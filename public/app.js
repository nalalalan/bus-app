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

const HOME_LOCATION = LOCATIONS.find((location) => location.id === "william");

const els = {
  statusText: document.getElementById("statusText"),
  locationList: document.getElementById("locationList"),
  busList: document.getElementById("busList"),
  selectedStopName: document.getElementById("selectedStopName"),
  selectedStopDetail: document.getElementById("selectedStopDetail"),
  arrivalList: document.getElementById("arrivalList"),
  updatedAt: document.getElementById("updatedAt")
};

const routeColors = new Map();
const routeLayers = new Map();
const routeDataById = new Map();
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
let currentLocation = HOME_LOCATION ? { ...HOME_LOCATION, source: "Home" } : null;
let currentMarker = null;
let selectedLocationId = null;
let selectedRouteId = "";
let selectedStopMarker = null;
let selectedTripLayer = null;
let selectedConnectorLayer = null;
let selectedArrivalData = null;
let followVehicleKey = "";

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

function locationGlyph(location) {
  if (location.id === "william") {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 15 16 6l11 9v11h-7v-7h-8v7H5z" fill="currentColor"/></svg>`;
  }
  if (location.id === "alden") {
    return `<span class="wpi-mark">WPI</span>`;
  }
  if (location.id === "union") {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 5h14c3 0 5 2 5 5v9c0 3-2 5-5 5l3 4h-5l-2-4h-6l-2 4H6l3-4c-3 0-5-2-5-5v-9c0-3 2-5 5-5zm1 5v5h12v-5H10zm1 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="currentColor"/></svg>`;
  }
  if (location.id === "chipotle") {
    return `<span class="brand-chipotle">C</span>`;
  }
  if (location.id === "coldstone") {
    return `<span class="brand-coldstone">CS</span>`;
  }
  if (location.id === "blackstone") {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M8 13h16l-2 15H10z" fill="currentColor"/><path d="M8 13 6 7l4-1 2 6 3-7 4 1-2 7 5-5 4 3-5 4z" fill="currentColor"/></svg>`;
  }
  return `<span>${escapeHtml(location.label)}</span>`;
}

function locationIcon(location, selected = false) {
  return L.divIcon({
    className: "location-marker",
    html: `<span class="place-pin place-${escapeHtml(location.id)}${selected ? " selected" : ""}">${locationGlyph(location)}</span>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18]
  });
}

function renderLocations() {
  for (const marker of locationMarkers.values()) marker.remove();
  locationMarkers.clear();

  for (const location of LOCATIONS) {
    const marker = L.marker([location.lat, location.lng], {
      icon: locationIcon(location, location.id === selectedLocationId),
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
      rows.push(`<button class="bus-row${vehicle.key === followVehicleKey ? " selected" : ""}" type="button" data-vehicle="${escapeHtml(vehicle.key)}">
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

function haversineMeters(a, b) {
  if (!a || !b) return Infinity;
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
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
  followVehicleKey = key;
  selectedRouteId = vehicle.routeId || selectedRouteId;
  updateRouteStyles();
  renderBusList();
  setStatus(`Route ${vehicle.routeId} bus ${vehicle.equipment || vehicle.id}`);
  map.setView([vehicle.lat, vehicle.lng], 17, { animate: false });
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
      if (followVehicleKey === key) followVehicleKey = "";
    }
  }
  if (followVehicleKey && busMarkers.has(followVehicleKey)) {
    const followed = estimatedVehicle(vehicleSamples.get(followVehicleKey));
    if (followed) map.setView([followed.lat, followed.lng], Math.max(map.getZoom(), 17), { animate: true });
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

function renderCurrentLocation() {
  if (!currentLocation) return;
  const latLng = [currentLocation.lat, currentLocation.lng];
  if (currentMarker) {
    currentMarker.setLatLng(latLng);
    return;
  }
  currentMarker = L.marker(latLng, {
    icon: pinIcon("current", "me", "#375f8f"),
    title: currentLocation.source === "Home" ? "Home fallback" : "Current location"
  }).bindTooltip(currentLocation.source === "Home" ? "Home fallback" : "Current location", {
    direction: "top",
    offset: [0, -12]
  }).addTo(map);
}

function startLocationWatch() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition((position) => {
    currentLocation = {
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      source: "GPS"
    };
    renderCurrentLocation();
    if (selectedArrivalData?.location && selectedArrivalData?.stop) {
      drawSelectedTrip(selectedArrivalData.location, selectedArrivalData.stop, selectedArrivalData.route?.id);
    }
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

function flattenRouteCoordinates(routeId) {
  const shapes = routeDataById.get(routeId)?.shapes?.features || [];
  const lines = [];
  for (const feature of shapes) {
    const geometry = feature.geometry || {};
    if (geometry.type === "LineString") lines.push(geometry.coordinates.map(([lng, lat]) => ({ lat, lng })));
    if (geometry.type === "MultiLineString") {
      for (const line of geometry.coordinates) lines.push(line.map(([lng, lat]) => ({ lat, lng })));
    }
  }
  return lines;
}

function nearestRoutePointIndex(line, point) {
  let best = { index: -1, distance: Infinity };
  line.forEach((candidate, index) => {
    const distance = haversineMeters(candidate, point);
    if (distance < best.distance) best = { index, distance };
  });
  return best;
}

function routeSegment(routeId, fromStop, toStop) {
  const lines = flattenRouteCoordinates(routeId);
  let best = null;
  for (const line of lines) {
    const from = nearestRoutePointIndex(line, fromStop);
    const to = nearestRoutePointIndex(line, toStop);
    if (from.index < 0 || to.index < 0) continue;
    const score = from.distance + to.distance;
    if (!best || score < best.score) best = { line, from, to, score };
  }
  if (!best) return [];
  const start = Math.min(best.from.index, best.to.index);
  const end = Math.max(best.from.index, best.to.index);
  return best.line.slice(start, end + 1);
}

function nearestStopOnRoute(routeId, point) {
  const stops = routeDataById.get(routeId)?.stops || [];
  let best = null;
  for (const stop of stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) continue;
    const distance = haversineMeters(point, stop);
    if (!best || distance < best.distanceMeters) best = { ...stop, distanceMeters: distance };
  }
  return best;
}

function drawSelectedTrip(location, stop, routeId = selectedRouteId) {
  if (selectedTripLayer) selectedTripLayer.remove();
  if (selectedConnectorLayer) selectedConnectorLayer.remove();
  selectedTripLayer = null;
  selectedConnectorLayer = null;
  if (!routeId || !location || !stop) return;

  const originStop = currentLocation ? nearestStopOnRoute(routeId, currentLocation) : null;
  const segment = originStop ? routeSegment(routeId, originStop, stop) : [];
  const color = routeColor(routeId);
  const tripLayers = [];
  if (segment.length > 1) {
    tripLayers.push(L.polyline(segment.map((point) => [point.lat, point.lng]), {
      color,
      weight: 8,
      opacity: 0.98,
      lineCap: "round",
      lineJoin: "round"
    }));
  }

  const connectors = [];
  if (currentLocation && originStop) connectors.push([[currentLocation.lat, currentLocation.lng], [originStop.lat, originStop.lng]]);
  connectors.push([[stop.lat, stop.lng], [location.lat, location.lng]]);
  selectedConnectorLayer = L.layerGroup(connectors.map((line) => L.polyline(line, {
    color: "#171717",
    weight: 3,
    opacity: 0.72,
    dashArray: "5 6"
  }))).addTo(map);
  selectedTripLayer = L.layerGroup(tripLayers).addTo(map);

  const points = [location, stop, currentLocation, originStop, ...segment].filter(Boolean);
  fitBounds(points, 15);
}

async function selectLocation(locationId) {
  const location = LOCATIONS.find((item) => item.id === locationId);
  if (!location) return;
  followVehicleKey = "";
  selectedArrivalData = null;
  selectedLocationId = location.id;
  renderLocations();
  renderSelectedStop();
  setStatus(`Loading ${location.name}`);

  try {
    const data = await api(`/api/location-arrivals?locationId=${encodeURIComponent(location.id)}&now=${Date.now()}`);
    selectedArrivalData = data;
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
    drawSelectedTrip(location, data.stop, data.route?.id);
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
  routeDataById.set(routeId, data);
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
  renderCurrentLocation();
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
