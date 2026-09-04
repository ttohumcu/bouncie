const fmtDate = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
};

const fmtNum = (n, digits = 1) =>
  typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: digits }) : "—";

async function fetchJson(path) {
  const res = await fetch(`${path}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function fetchEncrypted(path, key) {
  const res = await fetch(`${path}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Format: iv (12 bytes) + ciphertext; salt is shared and stored in last_updated.json
  const iv = buf.slice(0, 12);
  const ciphertext = buf.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function deriveKey(password, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const raw = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    raw,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

async function tryUnlock(password, saltB64) {
  const key = await deriveKey(password, saltB64);
  // AES-GCM throws on wrong password (auth tag mismatch)
  await fetchEncrypted("data/vehicles.json.enc", key);
  return key;
}

function card(label, value, sub) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
  return el;
}

function noDataBanner(message) {
  const el = document.createElement("p");
  el.className = "sub no-data";
  el.textContent = message;
  return el;
}

// ── Map state ────────────────────────────────────────────────────────────────
let _map = null;
let _routeLayerMap = new Map(); // transactionId → L.Polyline
let _activeLayer = null;
let _activeRow = null;

function focusTrip(txId, layer, row) {
  if (_activeLayer) _activeLayer.setStyle({ color: "#58a6ff", weight: 2, opacity: 0.4 });
  if (_activeRow) _activeRow.classList.remove("row-active");

  if (layer) {
    layer.setStyle({ color: "#f85149", weight: 4, opacity: 1 });
    layer.bringToFront();
    _map.fitBounds(layer.getBounds().pad(0.25));
  }
  if (row) {
    row.classList.add("row-active");
    row.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  _activeLayer = layer || null;
  _activeRow = row || null;
}

function initMap(trips, vehicles) {
  const mapEl = document.getElementById("trip-map");
  if (!mapEl || typeof L === "undefined") return;

  _map = L.map("trip-map", { preferCanvas: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
    className: "map-tiles-dark",
  }).addTo(_map);

  const allLatLngs = [];

  for (const t of trips) {
    const coords = t.gps?.coordinates;
    if (!coords || coords.length < 2) continue;
    // GeoJSON stores [lon, lat]; Leaflet wants [lat, lon]
    const latlngs = coords.map(([lon, lat]) => [lat, lon]);
    allLatLngs.push(...latlngs);

    const poly = L.polyline(latlngs, { color: "#58a6ff", weight: 2, opacity: 0.4 }).addTo(_map);
    const txId = t.transactionId;
    if (txId) _routeLayerMap.set(txId, poly);

    poly.on("click", () => {
      const row = txId ? document.querySelector(`tr[data-txid="${txId}"]`) : null;
      focusTrip(txId, poly, row);
    });
  }

  // Current vehicle location pins
  for (const v of vehicles) {
    const stats = v.stats || {};
    const loc = stats.location || {};
    const lat = loc.lat ?? loc.latitude;
    const lon = loc.lon ?? loc.longitude;
    if (!lat || !lon) continue;
    const name = v.nickName || v.imei || "Vehicle";
    L.circleMarker([lat, lon], {
      radius: 9, fillColor: "#f85149", color: "#fff", weight: 2, fillOpacity: 1,
    }).addTo(_map).bindPopup(`<b>${name}</b><br><small>${fmtDate(stats.lastUpdated)}</small>`);
  }

  if (allLatLngs.length > 0) {
    _map.fitBounds(allLatLngs, { padding: [20, 20] });
  }
}

// ── Date filter ──────────────────────────────────────────────────────────────
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function attachDateFilters(section) {
  const rows = [...section.querySelectorAll("tbody tr[data-date]")];
  if (rows.length < 10) return;

  const yearMonths = new Map();
  for (const r of rows) {
    const d = r.dataset.date;
    if (!d) continue;
    const y = d.slice(0, 4), m = d.slice(5, 7);
    if (!yearMonths.has(y)) yearMonths.set(y, new Set());
    yearMonths.get(y).add(m);
  }
  const years = [...yearMonths.keys()].sort().reverse();
  if (!years.length) return;

  const wrap = document.createElement("div");
  wrap.className = "table-filters";

  const yearSel = document.createElement("select");
  yearSel.className = "filter-select";
  yearSel.innerHTML = `<option value="">All years</option>` +
    years.map(y => `<option value="${y}">${y}</option>`).join("");

  const monthSel = document.createElement("select");
  monthSel.className = "filter-select";

  const countEl = document.createElement("span");
  countEl.className = "filter-count";

  function updateMonths() {
    const y = yearSel.value;
    const set = y ? yearMonths.get(y) : new Set([...yearMonths.values()].flatMap(s => [...s]));
    const months = [...set].sort();
    monthSel.innerHTML = `<option value="">All months</option>` +
      months.map(m => `<option value="${m}">${MONTH_NAMES[+m - 1]}</option>`).join("");
  }

  function applyFilter() {
    const y = yearSel.value, m = monthSel.value;
    let n = 0;
    for (const r of rows) {
      const d = r.dataset.date || "";
      const show = (!y || d.startsWith(y)) && (!m || d.slice(5, 7) === m);
      r.hidden = !show;
      if (show) n++;
    }
    countEl.textContent = `${n} of ${rows.length}`;
  }

  updateMonths();
  applyFilter();

  yearSel.addEventListener("change", () => { updateMonths(); applyFilter(); });
  monthSel.addEventListener("change", applyFilter);

  const lbl = (t) => Object.assign(document.createElement("span"), { textContent: t, className: "filter-label" });
  wrap.append(lbl("Year"), yearSel, lbl("Month"), monthSel, countEl);
  section.querySelector(".table-wrap").before(wrap);
}

// ── Render functions ─────────────────────────────────────────────────────────

function renderSummary(stats) {
  const root = document.getElementById("summary");
  const t = stats.totals || {};
  const hasTrips = (t.trips_all || 0) > 0;
  if (!hasTrips) {
    root.appendChild(noDataBanner("No trip history yet — will populate once the device records trips."));
    return;
  }
  root.append(
    card("Trips (all-time)", fmtNum(t.trips_all, 0), `${fmtNum(t.trips_7d, 0)} in last 7d`),
    card("Miles (all-time)", fmtNum(t.miles_all), `${fmtNum(t.miles_7d)} in last 7d`),
    card("Fuel (all-time)", `${fmtNum(t.fuel_all, 2)} gal`, `${fmtNum(t.fuel_7d, 2)} gal in last 7d`),
    card("Idle (all-time)", `${fmtNum(t.idle_all, 0)} min`, `${fmtNum(t.idle_7d, 0)} min in last 7d`),
    card("Hard events (all-time)", `${fmtNum(t.hard_brakes_all, 0)} / ${fmtNum(t.hard_accels_all, 0)}`, "brakes / accels"),
  );

  // Derived stats computed client-side
  const daily = stats.daily || [];
  if (daily.length > 0) {
    const avgMpg = t.fuel_all > 0 ? Math.round(t.miles_all / t.fuel_all * 10) / 10 : null;
    const avgMilesPerDay = Math.round(t.miles_all / daily.length * 10) / 10;
    const bestDay = daily.reduce((b, d) => d.miles > b.miles ? d : b, { miles: 0, date: "" });

    let maxStreak = 0, curStreak = 0, prevDate = null;
    for (const d of daily) {
      if (prevDate) {
        const diff = Math.round((new Date(d.date) - new Date(prevDate)) / 86400000);
        curStreak = diff === 1 ? curStreak + 1 : 1;
      } else {
        curStreak = 1;
      }
      if (curStreak > maxStreak) maxStreak = curStreak;
      prevDate = d.date;
    }

    if (avgMpg != null) root.append(card("Avg MPG", fmtNum(avgMpg, 1), "miles per gallon"));
    root.append(
      card("Avg miles / drive day", fmtNum(avgMilesPerDay), `over ${daily.length} days`),
      card("Longest streak", `${maxStreak} day${maxStreak !== 1 ? "s" : ""}`, "consecutive days with trips"),
    );
    if (bestDay.miles > 0) root.append(card("Best single day", `${fmtNum(bestDay.miles)} mi`, bestDay.date));
  }
}

function renderVehicles(vehicles) {
  const root = document.getElementById("vehicles");
  if (!vehicles.length) {
    root.appendChild(noDataBanner("No vehicles returned."));
    return;
  }
  for (const v of vehicles) {
    const stats = v.stats || {};
    const loc = stats.location || {};
    const mil = stats.mil || {};
    const modelObj = v.model || {};
    const make = modelObj.make || "";
    const name = modelObj.name || "";
    const year = modelObj.year || "";
    const displayName = v.nickName || [year, make, name].filter(Boolean).join(" ") || "Vehicle";
    const milStatus = mil.milOn ? '<span class="badge bad">MIL ON</span>' : '<span class="badge ok">MIL OK</span>';
    const running = stats.isRunning ? '<span class="badge ok">Running</span>' : '<span class="badge warn">Parked</span>';
    const fuel = stats.fuelLevel != null ? `${fmtNum(stats.fuelLevel, 1)}%` : "—";
    const odo = stats.odometer != null ? `${fmtNum(stats.odometer, 0)} mi` : "—";
    const speed = stats.speed != null ? `${fmtNum(stats.speed, 1)} mph` : "—";
    const heading = loc.heading != null ? `${fmtNum(loc.heading, 0)}°` : "—";
    const lastSeen = fmtDate(stats.lastUpdated);
    const lat = loc.lat ?? loc.latitude;
    const lon = loc.lon ?? loc.longitude;
    const mapLink = lat && lon ? `<a href="https://www.google.com/maps/search/?api=1&query=${lat},${lon}" target="_blank" rel="noopener">View on map</a>` : "";

    const dtcList = mil.qualifiedDtcList || [];
    const dtcHtml = dtcList.length
      ? `<div class="sub dtc-row">DTCs: ${dtcList.map((d) => `<span class="badge bad">${d}</span>`).join(" ")}</div>`
      : "";

    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      ${CAR_SVG}
      <div class="label">${displayName} ${milStatus} ${running}</div>
      <div class="value">${[year, make, name].filter(Boolean).join(" ")}</div>
      <div class="sub">VIN: ${v.vin || "—"}</div>
      <hr style="border-color:var(--border);margin:0.75rem 0;" />
      <div class="sub">Odometer: ${odo}</div>
      <div class="sub">Fuel: ${fuel}</div>
      <div class="sub">Speed: ${speed} · Heading: ${heading}</div>
      <div class="sub">Last update: ${lastSeen}</div>
      ${dtcHtml}
      <div class="sub">${mapLink}</div>
    `;
    root.appendChild(el);
  }
}

const CAR_SVG = `<svg viewBox="0 0 300 110" width="100%" style="max-height:130px;margin-bottom:0.75rem;display:block" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#e2e2e2"/><stop offset="40%" stop-color="#c6c6c6"/><stop offset="100%" stop-color="#8e8e8e"/>
    </linearGradient>
    <linearGradient id="wg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#b2cede" stop-opacity=".9"/><stop offset="100%" stop-color="#6292ba" stop-opacity=".75"/>
    </linearGradient>
    <radialGradient id="tg" cx="45%" cy="35%" r="55%">
      <stop offset="0%" stop-color="#555"/><stop offset="100%" stop-color="#111"/>
    </radialGradient>
  </defs>
  <path d="M14 66 Q14 56 24 54 L58 28 Q74 16 100 14 L200 14 Q226 14 244 28 L272 54 Q282 56 284 66 L284 80 Q284 86 278 86 L22 86 Q14 86 14 80Z" fill="url(#cg)" stroke="#a0a0a0" stroke-width=".8"/>
  <path d="M64 66 L72 32 Q82 16 102 16 L198 16 Q218 16 228 32 L248 66Z" fill="url(#wg)"/>
  <rect x="151" y="16" width="5" height="50" fill="#9aa" opacity=".6" rx="1"/>
  <path d="M24 74 Q149 70 274 74" stroke="#b0b0b0" stroke-width="1" fill="none" opacity=".5"/>
  <path d="M240 38 L256 32 L258 42 L242 46Z" fill="#ccc" stroke="#aaa" stroke-width=".5"/>
  <path d="M274 56 L286 62 L284 72 L272 70Z" fill="#fffee0" opacity=".9"/>
  <path d="M26 56 L14 62 L16 72 L28 70Z" fill="#dd2222" opacity=".85"/>
  <circle cx="64" cy="88" r="20" fill="url(#tg)"/><circle cx="64" cy="88" r="13" fill="#3a3a3a"/><circle cx="64" cy="88" r="6" fill="#888"/><circle cx="64" cy="88" r="2.5" fill="#aaa"/>
  <circle cx="220" cy="88" r="20" fill="url(#tg)"/><circle cx="220" cy="88" r="13" fill="#3a3a3a"/><circle cx="220" cy="88" r="6" fill="#888"/><circle cx="220" cy="88" r="2.5" fill="#aaa"/>
</svg>`;

function lineChart(canvasId, labels, datasets) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: "#e6edf3" } } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
      },
    },
  });
}

function barChart(canvasId, labels, data, label, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  new Chart(ctx, {
    type: "bar",
    data: { labels, datasets: [{ label, data, backgroundColor: color + "70", borderColor: color, borderWidth: 1, borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#e6edf3" } } },
      scales: {
        x: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" } },
        y: { ticks: { color: "#8b949e" }, grid: { color: "#30363d" }, beginAtZero: true },
      },
    },
  });
}

function renderCharts(stats) {
  const daily = stats.daily || [];
  const section = document.getElementById("charts-section");
  if (!daily.length) {
    section.style.display = "none";
    return;
  }
  const labels = daily.map((d) => d.date);
  lineChart("milesChart", labels, [{
    label: "Miles", data: daily.map((d) => d.miles), borderColor: "#58a6ff", backgroundColor: "rgba(88,166,255,0.2)", tension: 0.3, fill: true,
  }]);
  lineChart("tripsChart", labels, [{
    label: "Trips", data: daily.map((d) => d.trips), borderColor: "#3fb950", backgroundColor: "rgba(63,185,80,0.2)", tension: 0.3, fill: true,
  }]);
  lineChart("fuelChart", labels, [{
    label: "Fuel (gal)", data: daily.map((d) => d.fuel), borderColor: "#d29922", backgroundColor: "rgba(210,153,34,0.2)", tension: 0.3, fill: true,
  }]);
  lineChart("behaviorChart", labels, [
    { label: "Hard brakes", data: daily.map((d) => d.hard_brakes), borderColor: "#f85149", backgroundColor: "rgba(248,81,73,0.2)", tension: 0.3 },
    { label: "Hard accels", data: daily.map((d) => d.hard_accels), borderColor: "#bc8cff", backgroundColor: "rgba(188,140,255,0.2)", tension: 0.3 },
  ]);

  // Cumulative miles
  let cum = 0;
  lineChart("cumMilesChart", labels, [{
    label: "Cumulative miles",
    data: daily.map((d) => { cum += d.miles; return Math.round(cum * 10) / 10; }),
    borderColor: "#58a6ff", backgroundColor: "rgba(88,166,255,0.12)", tension: 0.2, fill: true,
  }]);

  // Avg speed
  lineChart("avgSpeedChart", labels, [{
    label: "Avg mph",
    data: daily.map((d) => d.avg_mph ?? null),
    borderColor: "#3fb950", backgroundColor: "rgba(63,185,80,0.15)", tension: 0.3, fill: true, spanGaps: false,
  }]);

  // MPG
  lineChart("mpgChart", labels, [{
    label: "MPG",
    data: daily.map((d) => d.fuel > 0 ? Math.round(d.miles / d.fuel * 10) / 10 : null),
    borderColor: "#d29922", backgroundColor: "rgba(210,153,34,0.15)", tension: 0.3, fill: true, spanGaps: false,
  }]);

  // Idle %
  lineChart("idlePctChart", labels, [{
    label: "Idle %",
    data: daily.map((d) => d.duration_min > 0 ? Math.round(d.idle_min / d.duration_min * 100 * 10) / 10 : null),
    borderColor: "#bc8cff", backgroundColor: "rgba(188,140,255,0.15)", tension: 0.3, fill: true, spanGaps: false,
  }]);
}

function renderPatterns(trips) {
  const section = document.getElementById("patterns-section");
  if (!section || !trips.length) { if (section) section.style.display = "none"; return; }

  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dowTrips = new Array(7).fill(0);
  const hodTrips = new Array(24).fill(0);
  const monthlyMiles = new Map();

  // Trip distance buckets (miles): 0-2, 2-5, 5-10, 10-20, 20-50, 50+
  const distBuckets = [0, 0, 0, 0, 0, 0];
  const distLabels = ["0–2 mi", "2–5 mi", "5–10 mi", "10–20 mi", "20–50 mi", "50+ mi"];

  for (const t of trips) {
    const start = t.startTime;
    if (start) {
      const d = new Date(start);
      dowTrips[d.getDay()]++;
      hodTrips[d.getHours()]++;
      const ym = start.slice(0, 7);
      monthlyMiles.set(ym, (monthlyMiles.get(ym) || 0) + (t.distance || 0));
    }
    const mi = t.distance || 0;
    if (mi < 2) distBuckets[0]++;
    else if (mi < 5) distBuckets[1]++;
    else if (mi < 10) distBuckets[2]++;
    else if (mi < 20) distBuckets[3]++;
    else if (mi < 50) distBuckets[4]++;
    else distBuckets[5]++;
  }

  barChart("dowChart", DOW, dowTrips, "Trips by day of week", "#58a6ff");
  barChart("hodChart", Array.from({ length: 24 }, (_, i) => `${i}:00`), hodTrips, "Trips by hour of day", "#3fb950");

  const months = [...monthlyMiles.keys()].sort();
  barChart("monthlyMilesChart", months, months.map((m) => Math.round(monthlyMiles.get(m))), "Miles by month", "#d29922");
  barChart("tripDistChart", distLabels, distBuckets, "Trip distance distribution", "#bc8cff");
}

function renderDaily(stats) {
  const section = document.getElementById("daily-section");
  const rows = [...(stats.daily || [])].reverse();
  if (!rows.length) {
    section.style.display = "none";
    return;
  }
  const tbody = section.querySelector("tbody");
  for (const d of rows) {
    const tr = document.createElement("tr");
    tr.dataset.date = d.date;
    tr.innerHTML = `
      <td>${d.date}</td>
      <td>${fmtNum(d.trips, 0)}</td>
      <td>${fmtNum(d.miles)} mi</td>
      <td>${fmtNum(d.duration_min, 0)} min</td>
      <td>${fmtNum(d.fuel, 2)} gal</td>
      <td>${d.avg_mph != null ? fmtNum(d.avg_mph, 1) : "—"}</td>
      <td>${fmtNum(d.max_mph, 0)}</td>
      <td>${d.idle_min != null ? fmtNum(d.idle_min, 1) + " min" : "—"}</td>
      <td>${fmtNum(d.hard_brakes, 0)}</td>
      <td>${fmtNum(d.hard_accels, 0)}</td>
    `;
    tbody.appendChild(tr);
  }
  attachDateFilters(section);
}

function renderHistory(history) {
  const section = document.getElementById("history-section");
  if (!history.length) {
    section.style.display = "none";
    return;
  }
  const tbody = section.querySelector("tbody");
  for (const h of history) {
    const name = h.nickName || [h.year, h.make, h.model].filter(Boolean).join(" ") || h.imei;
    const mil = h.milOn === true ? '<span class="badge bad">ON</span>' :
                h.milOn === false ? '<span class="badge ok">OK</span>' : "—";
    const loc = h.lat && h.lon
      ? `<a href="https://www.google.com/maps/search/?api=1&query=${h.lat},${h.lon}" target="_blank" rel="noopener">map</a>`
      : "—";
    const tr = document.createElement("tr");
    tr.dataset.date = h.date;
    tr.innerHTML = `
      <td>${h.date}</td>
      <td>${name}</td>
      <td>${h.odometer != null ? fmtNum(h.odometer, 0) + " mi" : "—"}</td>
      <td>${h.fuelLevel != null ? fmtNum(h.fuelLevel, 0) + "%" : "—"}</td>
      <td>${h.battery ?? "—"}</td>
      <td>${mil}</td>
      <td>${fmtDate(h.lastUpdated)}</td>
      <td>${loc}</td>
    `;
    tbody.appendChild(tr);
  }
  attachDateFilters(section);
}

function renderTrips(trips) {
  const section = document.getElementById("trips-section");
  if (!trips.length) {
    section.style.display = "none";
    return;
  }
  const tbody = section.querySelector("tbody");
  for (const t of trips) {
    const start = t.startTime || t.start_ts;
    const end = t.endTime || t.end_ts;
    const dur = start && end ? Math.round((new Date(end) - new Date(start)) / 60000) : null;
    const dist = t.distance ?? t.totalDistance;
    const top = t.maxSpeed ?? t.topSpeed;
    const avg = t.averageSpeed;
    const idle = t.totalIdleDuration != null ? Math.round(t.totalIdleDuration / 60) : null;
    const startOdo = t.startOdometer;
    const endOdo = t.endOdometer;
    const odoStr = startOdo != null && endOdo != null
      ? `${fmtNum(startOdo, 0)}→${fmtNum(endOdo, 0)}`
      : startOdo != null ? fmtNum(startOdo, 0) : "—";
    const hasRoute = t.gps?.coordinates?.length >= 2;
    const txId = t.transactionId || "";

    const dateStr = start ? new Date(start).toISOString().slice(0, 10) : "";
    const tr = document.createElement("tr");
    tr.dataset.txid = txId;
    tr.dataset.date = dateStr;
    if (hasRoute) tr.classList.add("has-route");
    tr.innerHTML = `
      <td>${fmtDate(start)}</td>
      <td>${fmtDate(end)}</td>
      <td>${dist != null ? fmtNum(dist) + " mi" : "—"}</td>
      <td>${dur != null ? dur + " min" : "—"}</td>
      <td>${avg != null ? fmtNum(avg, 1) : "—"}</td>
      <td>${top != null ? fmtNum(top, 0) : "—"}</td>
      <td>${idle != null ? idle + " min" : "—"}</td>
      <td>${t.fuelConsumed != null ? fmtNum(t.fuelConsumed, 2) + " gal" : "—"}</td>
      <td>${t.hardBrakingCount ?? 0}</td>
      <td>${t.hardAccelerationCount ?? 0}</td>
      <td>${odoStr}</td>
    `;

    if (hasRoute && txId) {
      tr.addEventListener("click", () => {
        const poly = _routeLayerMap.get(txId);
        focusTrip(txId, poly, tr);
        document.getElementById("trip-map")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }

    tbody.appendChild(tr);
  }
  attachDateFilters(section);
}

async function renderDashboard(key) {
  let vehicles, trips, stats, history;
  if (key) {
    [vehicles, trips, stats, history] = await Promise.all([
      fetchEncrypted("data/vehicles.json.enc", key),
      fetchEncrypted("data/trips.json.enc", key),
      fetchEncrypted("data/stats.json.enc", key),
      fetchEncrypted("data/vehicle_history.json.enc", key).catch(() => ({ history: [] })),
    ]);
  } else {
    [vehicles, trips, stats, history] = await Promise.all([
      fetchJson("data/vehicles.json"),
      fetchJson("data/trips.json"),
      fetchJson("data/stats.json"),
      fetchJson("data/vehicle_history.json").catch(() => ({ history: [] })),
    ]);
  }
  document.getElementById("updated").textContent = `Last updated: ${fmtDate(stats.updated_at)}`;
  renderSummary(stats);
  renderVehicles(vehicles.vehicles || []);
  initMap(trips.trips || [], vehicles.vehicles || []);
  renderCharts(stats);
  renderPatterns(trips.trips || []);
  renderDaily(stats);
  renderHistory(history.history || []);
  renderTrips(trips.trips || []);
}

// ── Auth gate ────────────────────────────────────────────────────────────────
(async () => {
  const gate = document.getElementById("auth-gate");
  const input = document.getElementById("auth-input");
  const btn = document.getElementById("auth-btn");
  const errEl = document.getElementById("auth-error");
  const authUpdated = document.getElementById("auth-updated");

  let meta;
  try {
    meta = await fetchJson("data/last_updated.json");
    authUpdated.textContent = `Last updated: ${fmtDate(meta.updated_at)}`;
  } catch {
    authUpdated.textContent = "";
    meta = {};
  }

  if (!meta.encrypted) {
    gate.classList.add("hidden");
    try {
      await renderDashboard(null);
    } catch (err) {
      document.getElementById("updated").textContent =
        "No data yet. Run the GitHub Action once to populate data/*.json.";
      console.error(err);
    }
    return;
  }

  const saltB64 = meta.salt;
  if (!saltB64) {
    errEl.textContent = "Encrypted files not ready — run the Update Bouncie data workflow first.";
    errEl.style.display = "block";
    gate.style.display = "flex";
    return;
  }

  const cached = sessionStorage.getItem("bp");
  if (cached) {
    try {
      const key = await tryUnlock(cached, saltB64);
      gate.remove();
      await renderDashboard(key);
      return;
    } catch {
      sessionStorage.removeItem("bp");
    }
  }

  async function attemptUnlock() {
    const pw = input.value;
    if (!pw) return;
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    errEl.style.display = "none";
    try {
      const key = await tryUnlock(pw, saltB64);
      sessionStorage.setItem("bp", pw);
      gate.remove();
      await renderDashboard(key);
    } catch (err) {
      console.error("Unlock error:", err);
      errEl.textContent = err?.message?.includes("404")
        ? "Could not load encrypted data — run the Update workflow first."
        : "Wrong password — try again";
      errEl.style.display = "block";
      input.value = "";
      input.focus();
    } finally {
      btn.disabled = false;
      btn.textContent = "Unlock";
    }
  }

  btn.addEventListener("click", attemptUnlock);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") attemptUnlock(); });
  input.focus();
})();
