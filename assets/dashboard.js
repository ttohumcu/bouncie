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

function card(label, value, sub) {
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="label">${label}</div><div class="value">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}`;
  return el;
}

function renderSummary(stats) {
  const root = document.getElementById("summary");
  const t = stats.totals || {};
  root.append(
    card("Trips (7d)", fmtNum(t.trips_7d, 0), `${fmtNum(t.trips_30d, 0)} in last 30d`),
    card("Miles (7d)", fmtNum(t.miles_7d), `${fmtNum(t.miles_30d)} in last 30d`),
    card("Fuel (7d)", `${fmtNum(t.fuel_7d, 2)} gal`, `${fmtNum(t.fuel_30d, 2)} gal in last 30d`),
    card("Hard brakes (30d)", fmtNum(t.hard_brakes_30d, 0), `${fmtNum(t.hard_accels_30d, 0)} hard accels`),
  );
}

function renderVehicles(vehicles) {
  const root = document.getElementById("vehicles");
  if (!vehicles.length) {
    root.innerHTML = '<p class="sub">No vehicles returned.</p>';
    return;
  }
  for (const v of vehicles) {
    const stats = v.stats || {};
    const loc = stats.location || {};
    const milStatus = stats.mil?.milOn ? '<span class="badge bad">MIL ON</span>' : '<span class="badge ok">MIL OK</span>';
    const battery = stats.battery?.status || stats.battery?.level || "—";
    const fuel = stats.fuelLevel != null ? `${fmtNum(stats.fuelLevel, 0)}%` : "—";
    const odo = stats.odometer != null ? `${fmtNum(stats.odometer, 0)} mi` : "—";
    const speed = stats.speed != null ? `${fmtNum(stats.speed, 0)} mph` : "—";
    const heading = stats.heading != null ? `${fmtNum(stats.heading, 0)}°` : "—";
    const lastSeen = fmtDate(stats.lastUpdated);
    const lat = loc.lat ?? loc.latitude;
    const lon = loc.lon ?? loc.longitude;
    const mapLink = lat && lon ? `<a href="https://maps.google.com/?q=${lat},${lon}" target="_blank" rel="noopener">View on map</a>` : "";

    const el = document.createElement("div");
    el.className = "card";
    el.innerHTML = `
      <div class="label">${v.nickName || v.model || "Vehicle"} ${milStatus}</div>
      <div class="value">${[v.year, v.make, v.model].filter(Boolean).join(" ")}</div>
      <div class="sub">VIN: ${v.vin || "—"} · IMEI: ${v.imei || "—"}</div>
      <hr style="border-color:var(--border);margin:0.75rem 0;" />
      <div class="sub">Odometer: ${odo}</div>
      <div class="sub">Fuel level: ${fuel}</div>
      <div class="sub">Battery: ${battery}</div>
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

function renderTrips(trips) {
  const tbody = document.querySelector("#trips tbody");
  const rows = trips.slice(0, 50);
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="sub">No trips yet.</td></tr>';
    return;
  }
  for (const t of rows) {
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

(async () => {
  try {
    const [vehicles, trips, stats] = await Promise.all([
      fetchJson("data/vehicles.json"),
      fetchJson("data/trips.json"),
      fetchJson("data/stats.json"),
    ]);
    document.getElementById("updated").textContent = `Last updated: ${fmtDate(stats.updated_at)}`;
    renderSummary(stats);
    renderVehicles(vehicles.vehicles || []);
    renderCharts(stats);
    renderTrips(trips.trips || []);
  } catch (err) {
    document.getElementById("updated").textContent =
      "No data yet. Run the GitHub Action once to populate data/*.json.";
    console.error(err);
  }
})();
