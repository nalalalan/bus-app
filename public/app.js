const ROUTES = ["2", "4", "3", "31"];
const LOCATIONS = [
  {
    id: "william",
    name: "96 William St",
    address: "96 William Street",
    lat: 42.2682067,
    lng: -71.8141609,
    label: "96"
  },
  {
    id: "alden",
    name: "Alden Hall",
    address: "100 Institute Road",
    lat: 42.2743150,
    lng: -71.8084567,
    label: "A"
  },
  {
    id: "union",
    name: "Union Station",
    address: "2 Washington Square",
    lat: 42.2613806,
    lng: -71.7952265,
    label: "U"
  },
  {
    id: "chipotle",
    name: "Chipotle",
    address: "49 Park Ave",
    lat: 42.2819270,
    lng: -71.8082589,
    label: "C"
  },
  {
    id: "coldstone",
    name: "Cold Stone",
    address: "531 Main St #103",
    lat: 42.2618181,
    lng: -71.8028624,
    label: "CS"
  },
  {
    id: "blackstone",
    name: "Blackstone Theaters",
    address: "70 Worcester-Providence Turnpike",
    lat: 42.1967955,
    lng: -71.7776713,
    label: "B"
  }
];

const els = {
  statusText: document.getElementById("statusText"),
  routeList: document.getElementById("routeList"),
  locationList: document.getElementById("locationList"),
  busList: document.getElementById("busList"),
  selectedStopName: document.getElementById("selectedStopName"),
  selectedStopDetail: document.getElementById("selectedStopDetail"),
  arrivalList: document.getElementById("arrivalList"),
  updatedAt: document.getElementById("updatedAt")
};

const routeColors = new Map();
const routeLayers = new Map();
const routeState = new Map(ROUTES.map((routeId) => [routeId, {
  routeId,
  name: `Route ${routeId}`,
  vehicles: [],
  ok: false,
  error: ""
}]));
const vehicleSamples = new Map();
const busMarkers = new Map();
const locationMarkers = new Map();

const BUS_POLL_MS = 10000;
const BUS_RENDER_MS = 1000;
const BUS_ESTIMATE_MAX_MS = 45000;
const EARTH_RADIUS_METERS = 6371000;
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit"
});

let map;
let refreshTimer;
let renderTimer;
let currentLocation = null;
let currentMarker = null;
let selectedLocationId = null;
let selectedRouteId = "";
let selectedStopMarker = null;

function api(path) {
  return fetch(path, { cache: "no-store" }).then(async (response) => {
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || `${response.status}`);
    return json;
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function initMap() {
  map = L.map("map", {
    zoomControl: true,
    attributionControl: true
  }).setView([42.2623388, -71.8011645], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
}

function routeColor(routeId) {
  return routeColors.get(routeId) || {
    "2": "#375f8f",
    "4": "#7a5b2b",
    "3": "#2f745d",
    "31": "#b45a35"
  }[routeId] || "#555555";
}

function normalizeColor(value, fallback = "#555555") {
  const raw = String(value || "").trim();
  const color = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}

function pinIcon(kind, label, color = "#555555") {
  const markerKind = String(kind).split(" ")[0];
  return L.divIcon({
    className: `${markerKind}-marker`,
    html: `<span class="pin ${kind}" style="--pin-color:${normalizeColor(color)}">${escapeHtml(label)}</span>`,
    iconSize: markerKind === "bus" ? [34, 34] : [30, 30],
    iconAnchor: markerKind === "bus" ? [17, 17] : [15, 15]
  });
}

function renderLocations() {
  for (const marker of locationMarkers.values()) marker.remove();
  locationMarkers.clear();

  for (const location of LOCATIONS) {
    const marker = L.marker([location.lat, location.lng], {
      icon: pinIcon(location.id === selectedLocationId ? "location selected" : "location", location.label, "#222222"),
      title: location.name
    }).bindTooltip(`${escapeHtml(location.name)}<br>${escapeHtml(location.address)}`, {
      direction: "top",
      offset: [0, -12]
    }).addTo(map);
    marker.on("click", () => selectLocation(location.id));
    locationMarkers.set(location.id, marker);
  }

  els.locationList.innerHTML = LOCATIONS.map((location) => (
    `<button class="location-row${location.id === selectedLocationId ? " selected" : ""}" type="button" data-location="${escapeHtml(location.id)}">
      <strong>${escapeHtml(location.name)}</strong>
      <span>${escapeHtml(location.address)}</span>
    </button>`
  )).join("");
}

function renderRoutes() {
  els.routeList.innerHTML = ROUTES.map((routeId) => {
    const state = routeState.get(routeId);
    const count = state?.vehicles?.length || 0;
    const status = state?.ok ? `${count} live` : "blocked";
    return `<button class="route-row${routeId === selectedRouteId ? " selected" : ""}" type="button" data-route="${escapeHtml(routeId)}">
      <span class="route-swatch" style="--route-color:${routeColor(routeId)}"></span>
      <strong>Route ${escapeHtml(routeId)}</strong>
      <span>${escapeHtml(status)}</span>
    </button>`;
  }).join("");
}

function renderBusList() {
  const rows = [];
  for (const routeId of ROUTES) {
    const state = routeState.get(routeId);
    if (!state?.vehicles?.length) {
      rows.push(`<div class="bus-row muted">
        <strong>Route ${escapeHtml(routeId)}</strong>
        <span>No live bus</span>
      </div>`);
      continue;
    }

    for (const vehicle of state.vehicles) {
      const speed = Number(vehicle.speedMph || 0);
      const delay = vehicle.delay ? ` - ${vehicle.delay}` : "";
      const nextStop = vehicle.nextStop ? ` - ${vehicle.nextStop}` : "";
      rows.push(`<button class="bus-row" type="button" data-vehicle="${escapeHtml(vehicle.key)}">
        <strong>Route ${escapeHtml(routeId)} bus ${escapeHtml(vehicle.equipment || vehicle.id)}</strong>
        <span>${escapeHtml(`${speed.toFixed(0)} mph${delay}${nextStop}`)}</span>
      </button>`);
    }
  }
  els.busList.innerHTML = rows.join("");
}

function renderSelectedStop(data = null) {
  if (!data?.stop) {
    els.selectedStopName.textContent = selectedLocationId ? "Loading stop" : "Select a location";
    els.selectedStopDetail.textContent = "--";
    els.arrivalList.innerHTML = "";
    return;
  }

  const stop = data.stop;
  const route = data.route;
  const location = data.location;
  const distanceFeet = Math.round(Number(stop.distanceMeters || 0) * 3.28084);
  els.selectedStopName.textContent = stop.name || "Closest stop";
  els.selectedStopDetail.textContent = `Route ${route?.id || "--"} - ${distanceFeet} ft from ${location?.name || "location"}`;
  els.arrivalList.innerHTML = (data.arrivals || []).length
    ? data.arrivals.map((arrival) => (
      `<div class="arrival-row">
        <strong>${escapeHtml(timeFormatter.format(new Date(arrival.predictedMs)))}</strong>
        <span>Route ${escapeHtml(arrival.routeId)} to ${escapeHtml(arrival.destination || "destination")} - ${escapeHtml(arrival.minutes || "")}</span>
      </div>`
    )).join("")
    : `<div class="arrival-row muted"><strong>No WRTA times</strong><span>${escapeHtml(stop.name || "")}</span></div>`;
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function setUpdatedAt() {
  els.updatedAt.textContent = timeFormatter.format(new Date());
}

function toRadians(degrees) {
  return Number(degrees) * Math.PI / 180;
}

function toDegrees(radians) {
  return Number(radians) * 180 / Math.PI;
}

function destinationPoint(start, meters, bearingDegrees) {
  const distance = Number(meters);
  const bearing = toRadians(bearingDegrees);
  if (!start || !Number.isFinite(distance) || !Number.isFinite(bearing)) return start;
  const lat1 = toRadians(start.lat);
  const lng1 = toRadians(start.lng);
  const angularDistance = distance / EARTH_RADIUS_METERS;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance)
      + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
  );
  return {
    lat: toDegrees(lat2),
    lng: ((toDegrees(lng2) + 540) % 360) - 180
  };
}

function updateVehicleSamples(routeId, vehicles) {
  const now = Date.now();
  const activeKeys = new Set();

  for (const vehicle of vehicles) {
    const key = `${routeId}:${vehicle.id}`;
    activeKeys.add(key);
    const existing = vehicleSamples.get(key);
    const current = {
      ...vehicle,
      routeId,
      key,
      sampledAt: now
    };
    vehicleSamples.set(key, {
      previous: existing?.rendered || existing?.current || current,
      current,
      rendered: existing?.rendered || current
    });
  }

  for (const [key, sample] of vehicleSamples.entries()) {
    if (sample.current.routeId === routeId && !activeKeys.has(key)) {
      vehicleSamples.delete(key);
      const marker = busMarkers.get(key);
      if (marker) marker.remove();
      busMarkers.delete(key);
    }
  }
}

function estimatedVehicle(sample) {
  if (!sample?.current) return null;
  const ageMs = Math.max(0, Date.now() - Number(sample.current.sampledAt || Date.now()));
  let point = {
    ...sample.current,
    positionAgeMs: ageMs,
    positionMode: ageMs > 60000 ? "stale" : "live"
  };

  const speedMps = Number(sample.current.speedMph || 0) * 0.44704;
  const bearing = Number(sample.current.bearing);
  if (speedMps > 0.9 && Number.isFinite(bearing) && ageMs > 0 && ageMs < BUS_ESTIMATE_MAX_MS) {
    point = {
      ...point,
      ...destinationPoint(sample.current, speedMps * ageMs / 1000, bearing),
      positionMode: ageMs > 2500 ? "estimated" : "live"
    };
  }
  return point;
}

function busTitle(vehicle) {
  const speed = Number(vehicle.speedMph || 0).toFixed(0);
  const stale = vehicle.positionMode === "stale" ? "stale" : vehicle.positionMode;
  const destination = vehicle.destination ? ` to ${vehicle.destination}` : "";
  return `Route ${vehicle.routeId} bus ${vehicle.equipment || vehicle.id}${destination} - ${speed} mph - ${stale}`;
}

function focusVehicle(key) {
  const vehicle = estimatedVehicle(vehicleSamples.get(key));
  if (!vehicle || !Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lng)) return;
  map.setView([vehicle.lat, vehicle.lng], 17, { animate: true });
  const marker = busMarkers.get(key);
  if (marker) marker.openTooltip();
}

function renderBuses() {
  const active = new Set();
  for (const [key, sample] of vehicleSamples.entries()) {
    const vehicle = estimatedVehicle(sample);
    if (!vehicle || !Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lng)) continue;
    active.add(key);
    sample.rendered = vehicle;

    const markerClass = vehicle.positionMode === "stale" ? "stale" : vehicle.positionMode === "estimated" ? "estimated" : "live";
    const icon = pinIcon(`bus ${markerClass}`, vehicle.routeId, routeColor(vehicle.routeId));
    const latLng = [vehicle.lat, vehicle.lng];
    const existing = busMarkers.get(key);
    if (existing) {
      existing.setLatLng(latLng);
      existing.setIcon(icon);
      existing.setTooltipContent(escapeHtml(busTitle(vehicle)));
    } else {
      const marker = L.marker(latLng, {
        icon,
        title: busTitle(vehicle)
      }).bindTooltip(escapeHtml(busTitle(vehicle)), {
        direction: "top",
        offset: [0, -14]
      }).addTo(map);
      marker.on("click", () => focusVehicle(key));
      busMarkers.set(key, marker);
    }
  }

  for (const [key, marker] of busMarkers.entries()) {
    if (!active.has(key)) {
      marker.remove();
      busMarkers.delete(key);
    }
  }
}

function fitBounds(points, fallbackZoom = 12) {
  const validPoints = points.filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!validPoints.length) {
    map.setView([42.2623388, -71.8011645], fallbackZoom);
    return;
  }
  const bounds = L.latLngBounds(validPoints.map((point) => [point.lat, point.lng]));
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
}

function updateRouteStyles() {
  for (const [routeId, layer] of routeLayers.entries()) {
    const selected = selectedRouteId && routeId === selectedRouteId;
    layer.setStyle({
      color: routeColor(routeId),
      weight: selected ? 8 : 4,
      opacity: selectedRouteId ? (selected ? 0.95 : 0.28) : 0.74
    });
    if (selected) layer.bringToFront();
  }
  renderRoutes();
}

function fitAll() {
  const points = [...LOCATIONS];
  for (const layer of routeLayers.values()) {
    const bounds = layer.getBounds();
    if (bounds.isValid()) {
      points.push(bounds.getNorthEast(), bounds.getSouthWest());
    }
  }
  for (const sample of vehicleSamples.values()) {
    const vehicle = estimatedVehicle(sample);
    if (vehicle) points.push(vehicle);
  }
  fitBounds(points, 11);
}

function fitBuses(routeId = "") {
  const points = [...vehicleSamples.values()]
    .filter((sample) => !routeId || sample.current?.routeId === routeId)
    .map(estimatedVehicle)
    .filter(Boolean);
  fitBounds(points, 12);
}

function fitLocations() {
  fitBounds(LOCATIONS, 12);
}

function fitRouteOrBuses(routeId) {
  const busPoints = [...vehicleSamples.values()]
    .filter((sample) => sample.current?.routeId === routeId)
    .map(estimatedVehicle)
    .filter(Boolean);
  selectedRouteId = routeId;
  updateRouteStyles();
  if (busPoints.length === 1) {
    map.setView([busPoints[0].lat, busPoints[0].lng], 17, { animate: true });
    return;
  }
  if (busPoints.length > 1) {
    fitBounds(busPoints, 13);
    return;
  }
  const routeBounds = routeLayers.get(routeId)?.getBounds?.();
  if (routeBounds?.isValid?.()) map.fitBounds(routeBounds, { padding: [32, 32], maxZoom: 14 });
}

function renderCurrentLocation() {
  if (!currentLocation) return;
  const latLng = [currentLocation.lat, currentLocation.lng];
  if (currentMarker) {
    currentMarker.setLatLng(latLng);
    return;
  }
  currentMarker = L.marker(latLng, {
    icon: pinIcon("current", "me", "#375f8f"),
    title: "Current location"
  }).bindTooltip("Current location", {
    direction: "top",
    offset: [0, -12]
  }).addTo(map);
}

function startLocationWatch() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition((position) => {
    currentLocation = {
      lat: position.coords.latitude,
      lng: position.coords.longitude
    };
    renderCurrentLocation();
  }, () => {}, {
    enableHighAccuracy: true,
    maximumAge: 6000,
    timeout: 16000
  });
}

function focusSelectedLocation(location, stop = null) {
  const points = [location, currentLocation].filter(Boolean);
  if (stop) points.push(stop);
  fitBounds(points, 15);
}

async function selectLocation(locationId) {
  const location = LOCATIONS.find((item) => item.id === locationId);
  if (!location) return;
  selectedLocationId = location.id;
  renderLocations();
  renderSelectedStop();
  focusSelectedLocation(location);
  setStatus(`Loading ${location.name}`);

  try {
    const data = await api(`/api/location-arrivals?locationId=${encodeURIComponent(location.id)}&now=${Date.now()}`);
    selectedRouteId = data.route?.id || "";
    updateRouteStyles();
    renderSelectedStop(data);
    if (selectedStopMarker) selectedStopMarker.remove();
    if (data.stop && Number.isFinite(data.stop.lat) && Number.isFinite(data.stop.lng)) {
      selectedStopMarker = L.marker([data.stop.lat, data.stop.lng], {
        icon: pinIcon("stop", "S", routeColor(selectedRouteId)),
        title: data.stop.name || "Closest stop"
      }).bindTooltip(`${escapeHtml(data.stop.name || "Closest stop")}<br>Route ${escapeHtml(selectedRouteId || "--")}`, {
        direction: "top",
        offset: [0, -12]
      }).addTo(map);
      selectedStopMarker.on("click", () => selectedStopMarker.openTooltip());
    }
    focusSelectedLocation(location, data.stop);
    setStatus(`${location.name} - Route ${selectedRouteId || "--"}`);
  } catch (error) {
    els.selectedStopName.textContent = "Stop unavailable";
    els.selectedStopDetail.textContent = error.message;
    els.arrivalList.innerHTML = "";
    setStatus("Stop unavailable");
  }
}

async function loadRoute(routeId) {
  const data = await api(`/api/route?routeId=${encodeURIComponent(routeId)}`);
  const color = data.line?.color || data.shapes?.features?.[0]?.properties?.routeColor || routeColor(routeId);
  routeColors.set(routeId, normalizeColor(color, routeColor(routeId)));
  if (routeLayers.has(routeId)) routeLayers.get(routeId).remove();
  const layer = L.geoJSON(data.shapes, {
    style: {
      color: routeColor(routeId),
      weight: 4,
      opacity: 0.74
    }
  }).addTo(map);
  routeLayers.set(routeId, layer);
  routeState.set(routeId, {
    ...(routeState.get(routeId) || {}),
    routeId,
    name: data.line?.longName || `Route ${routeId}`,
    ok: true,
    error: ""
  });
  updateRouteStyles();
}

async function loadLive(routeId) {
  const live = await api(`/api/live?routeId=${encodeURIComponent(routeId)}`);
  const vehicles = (live.vehicles || []).map((vehicle) => ({
    ...vehicle,
    routeId,
    key: `${routeId}:${vehicle.id}`
  }));
  updateVehicleSamples(routeId, vehicles);
  routeState.set(routeId, {
    ...(routeState.get(routeId) || {}),
    routeId,
    vehicles,
    ok: live.status?.ok !== false,
    error: live.status?.error || ""
  });
}

async function loadAllRoutes() {
  setStatus("Loading routes");
  await Promise.all(ROUTES.map(async (routeId) => {
    try {
      await loadRoute(routeId);
    } catch (error) {
      routeState.set(routeId, {
        ...(routeState.get(routeId) || {}),
        routeId,
        ok: false,
        error: error.message
      });
    }
  }));
  renderRoutes();
  fitAll();
}

async function refreshLive() {
  setStatus("Updating");
  await Promise.all(ROUTES.map(async (routeId) => {
    try {
      await loadLive(routeId);
    } catch (error) {
      routeState.set(routeId, {
        ...(routeState.get(routeId) || {}),
        routeId,
        vehicles: [],
        ok: false,
        error: error.message
      });
    }
  }));
  renderBuses();
  renderRoutes();
  renderBusList();
  setUpdatedAt();
  const total = [...routeState.values()].reduce((sum, state) => sum + (state.vehicles?.length || 0), 0);
  setStatus(`${total} live buses`);
}

function bindEvents() {
  els.locationList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-location]");
    if (!row) return;
    selectLocation(row.dataset.location);
  });
  els.routeList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-route]");
    if (!row) return;
    fitRouteOrBuses(row.dataset.route);
  });
  els.busList.addEventListener("click", (event) => {
    const row = event.target.closest("[data-vehicle]");
    if (!row) return;
    focusVehicle(row.dataset.vehicle);
  });
}

async function boot() {
  initMap();
  bindEvents();
  renderLocations();
  renderRoutes();
  renderBusList();
  renderSelectedStop();
  startLocationWatch();
  await loadAllRoutes();
  await refreshLive();
  refreshTimer = setInterval(refreshLive, BUS_POLL_MS);
  renderTimer = setInterval(renderBuses, BUS_RENDER_MS);
}

window.addEventListener("beforeunload", () => {
  clearInterval(refreshTimer);
  clearInterval(renderTimer);
});

boot();
