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
  const iv = buf.slice(16, 28);
  const ciphertext = buf.slice(28);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plain));
}

async function deriveKey(password, salt) {
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

// Fetch salt from vehicles.json.enc header, derive key, verify by decrypting.
async function tryUnlock(password) {
  const res = await fetch(`data/vehicles.json.enc?t=${Date.now()}`);
  if (!res.ok) throw new Error("vehicles.json.enc not found");
  const buf = new Uint8Array(await res.arrayBuffer());
  const salt = buf.slice(0, 16);
  const iv = buf.slice(16, 28);
  const ciphertext = buf.slice(28);
  const key = await deriveKey(password, salt);
  // AES-GCM throws if password is wrong (auth tag mismatch)
  await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
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
    card("Hard events (all-time)", `${fmtNum(t.hard_brakes_all, 0)} / ${fmtNum(t.hard_accels_all, 0)}`, "brakes / accels"),
  );
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
    const modelObj = v.model || {};
    const make = modelObj.make || "";
    const name = modelObj.name || "";
    const year = modelObj.year || "";
    const displayName = v.nickName || [year, make, name].filter(Boolean).join(" ") || "Vehicle";
    const milStatus = stats.mil?.milOn ? '<span class="badge bad">MIL ON</span>' : '<span class="badge ok">MIL OK</span>';
    const running = stats.isRunning ? '<span class="badge ok">Running</span>' : '<span class="badge warn">Parked</span>';
    const fuel = stats.fuelLevel != null ? `${fmtNum(stats.fuelLevel, 1)}%` : "—";
    const odo = stats.odometer != null ? `${fmtNum(stats.odometer, 0)} mi` : "—";
    const speed = stats.speed != null ? `${fmtNum(stats.speed, 1)} mph` : "—";
    const heading = loc.heading != null ? `${fmtNum(loc.heading, 0)}°` : "—";
    const lastSeen = fmtDate(stats.lastUpdated);
    const lat = loc.lat ?? loc.latitude;
    const lon = loc.lon ?? loc.longitude;
    const mapLink = lat && lon ? `<a href="https://maps.google.com/?q=${lat},${lon}" target="_blank" rel="noopener">View on map</a>` : "";

    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="label">${displayName} ${milStatus} ${running}</div>
      <div class="value">${[year, make, name].filter(Boolean).join(" ")}</div>
      <div class="sub">Year: ${year || "—"} · Make: ${make || "—"}</div>
      <hr style="border-color:var(--border);margin:0.75rem 0;" />
      <div class="sub">Odometer: ${odo}</div>
      <div class="sub">Fuel: ${fuel}</div>
      <div class="sub">Speed: ${speed} · Heading: ${heading}</div>
      <div class="sub">Last update: ${lastSeen}</div>
      <div class="sub">${mapLink}</div>
    `;
    root.appendChild(el);
  }
}

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
    tr.innerHTML = `
      <td>${d.date}</td>
      <td>${fmtNum(d.trips, 0)}</td>
      <td>${fmtNum(d.miles)} mi</td>
      <td>${fmtNum(d.duration_min, 0)} min</td>
      <td>${fmtNum(d.fuel, 2)} gal</td>
      <td>${fmtNum(d.max_mph, 0)}</td>
      <td>${fmtNum(d.hard_brakes, 0)}</td>
      <td>${fmtNum(d.hard_accels, 0)}</td>
    `;
    tbody.appendChild(tr);
  }
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
      ? `<a href="https://maps.google.com/?q=${h.lat},${h.lon}" target="_blank" rel="noopener">map</a>`
      : "—";
    const tr = document.createElement("tr");
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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(start)}</td>
      <td>${fmtDate(end)}</td>
      <td>${dist != null ? fmtNum(dist) + " mi" : "—"}</td>
      <td>${dur != null ? dur + " min" : "—"}</td>
      <td>${top != null ? fmtNum(top, 0) : "—"}</td>
      <td>${t.fuelConsumed != null ? fmtNum(t.fuelConsumed, 2) + " gal" : "—"}</td>
      <td>${t.hardBrakingCount ?? 0}</td>
      <td>${t.hardAccelerationCount ?? 0}</td>
    `;
    tbody.appendChild(tr);
  }
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
  renderCharts(stats);
  renderDaily(stats);
  renderHistory(history.history || []);
  renderTrips(trips.trips || []);
}

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

  // Encrypted — check sessionStorage for cached password so user doesn't re-enter on refresh
  const cached = sessionStorage.getItem("bp");
  if (cached) {
    try {
      const key = await tryUnlock(cached);
      gate.classList.add("hidden");
      await renderDashboard(key);
      return;
    } catch {
      sessionStorage.removeItem("bp");
    }
  }

  gate.style.display = "flex";

  async function attemptUnlock() {
    const pw = input.value;
    if (!pw) return;
    btn.disabled = true;
    btn.textContent = "Unlocking…";
    errEl.style.display = "none";
    try {
      const key = await tryUnlock(pw);
      sessionStorage.setItem("bp", pw);
      gate.classList.add("hidden");
      await renderDashboard(key);
    } catch {
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
