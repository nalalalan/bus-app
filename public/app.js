const state = {
  routeId: "",
  destinationId: "chipotle",
  destination: {
    id: "chipotle",
    label: "Chipotle, Park Ave",
    name: "Chipotle",
    lat: 42.281927,
    lng: -71.8082589
  },
  savedDestinations: [],
  destinationSuggestions: [],
  routeData: null,
  planResult: null,
  currentLocation: null,
  locationAccuracy: null,
  locationSource: "",
  watchId: null,
  vehicleSamples: new Map(),
  liveStatus: null,
  mapReady: false,
  choiceOffset: 0
};

const els = {
  routeInput: document.getElementById("routeInput"),
  destinationInput: document.getElementById("destinationInput"),
  arrivalInput: document.getElementById("arrivalInput"),
  previousTrip: document.getElementById("previousTrip"),
  nextTrip: document.getElementById("nextTrip"),
  tripChoice: document.getElementById("tripChoice"),
  instructionText: document.getElementById("instructionText"),
  instructionDetail: document.getElementById("instructionDetail"),
  standByTime: document.getElementById("standByTime"),
  standBySub: document.getElementById("standBySub"),
  leaveByTime: document.getElementById("leaveByTime"),
  leaveBySub: document.getElementById("leaveBySub"),
  boardingStop: document.getElementById("boardingStop"),
  boardingDistance: document.getElementById("boardingDistance"),
  walkTime: document.getElementById("walkTime"),
  walkDistance: document.getElementById("walkDistance"),
  busArrival: document.getElementById("busArrival"),
  busArrivalSub: document.getElementById("busArrivalSub"),
  busTarget: document.getElementById("busTarget"),
  busLiveState: document.getElementById("busLiveState"),
  pullCord: document.getElementById("pullCord"),
  pullCordSub: document.getElementById("pullCordSub"),
  exitStop: document.getElementById("exitStop"),
  exitSub: document.getElementById("exitSub"),
  locationState: document.getElementById("locationState"),
  homeState: document.getElementById("homeState"),
  stopsRemaining: document.getElementById("stopsRemaining"),
  routeStatus: document.getElementById("routeStatus"),
  sourceState: document.getElementById("sourceState"),
  useGps: document.getElementById("useGps"),
  saveHome: document.getElementById("saveHome")
};

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit"
});

let map;
let routeLayer;
let boardWalkLayer;
let exitWalkLayer;
let userMarker;
let boardingMarker;
let pullMarker;
let exitMarker;
let destinationMarker;
let busMarker;
let planTimer;
let liveTimer;
let destinationTimer;
let suggestionTimer;
let busRenderState = null;
let lastBusFrameMs = 0;

const BUS_ESTIMATE_MAX_MS = 45 * 1000;
const BUS_LIVE_POLL_MS = 1000;
const METERS_PER_MILE = 1609.344;
const EARTH_RADIUS_METERS = 6371000;

function api(path) {
  return fetch(path, { cache: "no-store" }).then(async (response) => {
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || `${response.status}`);
    return json;
  });
}

function formatTime(ms) {
  if (!Number.isFinite(Number(ms))) return "--";
  return timeFormatter.format(new Date(Number(ms)));
}

function formatMiles(meters) {
  if (!Number.isFinite(Number(meters))) return "--";
  if (Number(meters) < 90) return formatFeet(meters);
  return `${(Number(meters) / 1609.344).toFixed(2)} miles`;
}

function formatFeet(meters) {
  if (!Number.isFinite(Number(meters))) return "--";
  return `${Math.round(Number(meters) * 3.28084)} ft`;
}

function formatWalk(seconds) {
  if (!Number.isFinite(Number(seconds))) return "--";
  return `${Math.max(1, Math.ceil(Number(seconds) / 60))} min`;
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

function pointBetween(from, to, ratio) {
  const t = Math.max(0, Math.min(1, Number(ratio) || 0));
  return {
    lat: from.lat + (to.lat - from.lat) * t,
    lng: from.lng + (to.lng - from.lng) * t
  };
}

function setText(element, value) {
  element.textContent = value || "--";
}

function escapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function savedDestinationMatch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  return state.savedDestinations.find((destination) => {
    return [destination.id, destination.name, destination.label, destination.address]
      .filter(Boolean)
      .some((item) => String(item).toLowerCase() === normalized);
  }) || null;
}

function suggestionDestinationMatch(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return null;
  return state.destinationSuggestions.find((destination) => {
    return [destination.label, destination.name, destination.address]
      .filter(Boolean)
      .some((item) => String(item).trim().toLowerCase() === normalized);
  }) || null;
}

function destinationQueryParams() {
  const destination = state.destination || {};
  const isSavedDestination = destination.id && state.savedDestinations.some((saved) => saved.id === destination.id);
  if (isSavedDestination) {
    return { destination: destination.id };
  }
  if (Number.isFinite(destination.lat) && Number.isFinite(destination.lng)) {
    return {
      destination: "custom",
      destinationId: destination.id || "custom",
      destinationName: destination.name || destination.label || "Custom destination",
      destinationLabel: destination.label || destination.name || "Custom destination",
      destinationAddress: destination.address || "",
      destinationLat: String(destination.lat),
      destinationLng: String(destination.lng)
    };
  }
  return { destination: state.destinationId || "chipotle" };
}

function targetArrivalMsFromInput() {
  const value = els.arrivalInput?.value || "";
  if (!value) return NaN;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return NaN;
  const target = new Date();
  target.setHours(hours, minutes, 0, 0);
  if (target.getTime() < Date.now() - 2 * 60 * 60 * 1000) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function resetTripChoice() {
  state.choiceOffset = 0;
  updateTripChoice();
}

function applyDestination(destination) {
  if (!destination) return;
  state.destination = destination;
  state.destinationId = destination.id || "custom";
  const label = destination.label || destination.name || "";
  if (label && els.destinationInput.value !== label) els.destinationInput.value = label;
}

function renderDestinationOptions() {
  const datalist = document.getElementById("destinationOptions");
  if (!datalist) return;
  const byValue = new Map();
  for (const destination of [...state.savedDestinations, ...state.destinationSuggestions]) {
    const value = destination.label || destination.name || "";
    if (!value || byValue.has(value)) continue;
    byValue.set(value, destination);
  }
  datalist.innerHTML = [...byValue.values()]
    .map((destination) => {
      const value = escapeAttribute(destination.label || destination.name || "");
      const label = escapeAttribute(destination.address || destination.name || "");
      return `<option value="${value}" label="${label}"></option>`;
    })
    .join("");
}

async function loadDestinations() {
  try {
    const data = await api("/api/destinations");
    state.savedDestinations = data.destinations || [];
    renderDestinationOptions();
    applyDestination(savedDestinationMatch(els.destinationInput.value) || state.savedDestinations[0] || state.destination);
  } catch {
    state.savedDestinations = [];
  }
}

async function refreshDestinationSuggestions() {
  const value = els.destinationInput.value.trim();
  if (value.length < 2) {
    state.destinationSuggestions = [];
    renderDestinationOptions();
    return;
  }
  try {
    const data = await api(`/api/suggestions?q=${encodeURIComponent(value)}`);
    state.destinationSuggestions = data.suggestions || [];
    renderDestinationOptions();
    if (state.destinationSuggestions.length) {
      setText(els.sourceState, `${state.destinationSuggestions.length} destination suggestions`);
    }
  } catch (error) {
    state.destinationSuggestions = [];
    renderDestinationOptions();
    setText(els.sourceState, `Suggestions blocked: ${error.message}`);
  }
}

async function resolveDestinationInput() {
  const value = els.destinationInput.value.trim();
  const matched = savedDestinationMatch(value) || suggestionDestinationMatch(value);
  if (matched) {
    applyDestination(matched);
    refreshPlan();
    return;
  }
  if (!value) {
    applyDestination(state.savedDestinations[0] || state.destination);
    refreshPlan();
    return;
  }
  try {
    setText(els.sourceState, "Resolving destination");
    const data = await api(`/api/geocode?q=${encodeURIComponent(value)}`);
    applyDestination(data.destination);
    refreshPlan();
  } catch (error) {
    setText(els.sourceState, `Destination blocked: ${error.message}`);
  }
}

function pinIcon(kind, label, className) {
  return L.divIcon({
    className: `${className || kind}-marker`,
    html: `<span class="pin ${kind}">${label}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17]
  });
}

function initMap() {
  map = L.map("map", {
    zoomControl: true,
    attributionControl: true
  }).setView([42.281927, -71.8082589], 14);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  state.mapReady = true;
}

function routeGeoJsonStyle(feature) {
  const color = feature?.properties?.routeColor ? `#${feature.properties.routeColor}` : "#c75d32";
  return {
    color,
    weight: 5,
    opacity: 0.74,
    lineCap: "round",
    lineJoin: "round"
  };
}

function latLngsFromCoordinates(coordinates = []) {
  return coordinates.map(([lng, lat]) => [lat, lng]);
}

function ensureMarker(existing, latLng, icon, title) {
  if (existing) {
    existing.setLatLng(latLng);
    existing.setIcon(icon);
    return existing;
  }
  return L.marker(latLng, { icon, title }).addTo(map);
}

function renderRoute() {
  if (!state.mapReady || !state.routeData) return;
  if (routeLayer) routeLayer.remove();
  routeLayer = L.geoJSON(state.routeData.shapes, { style: routeGeoJsonStyle }).addTo(map);
  if (!state.currentLocation && routeLayer.getBounds().isValid()) {
    map.fitBounds(routeLayer.getBounds(), { padding: [22, 22] });
  }
}

function renderPlanOnMap() {
  const plan = state.planResult?.plan;
  if (!state.mapReady || !plan) return;

  const destination = plan.destination;
  const board = plan.boardingStop;
  const pull = plan.previousStop || plan.exitStop;
  const exit = plan.exitStop;

  if (state.currentLocation) {
    userMarker = ensureMarker(
      userMarker,
      [state.currentLocation.lat, state.currentLocation.lng],
      pinIcon("user", "me", "user"),
      "Current location"
    );
  }

  boardingMarker = ensureMarker(boardingMarker, [board.lat, board.lng], pinIcon("stop", "B", "stop"), "Boarding stop");
  if (pull) {
    pullMarker = ensureMarker(pullMarker, [pull.lat, pull.lng], pinIcon("pull", "C", "pull"), "Pull cord point");
  }
  exitMarker = ensureMarker(exitMarker, [exit.lat, exit.lng], pinIcon("exit", "X", "exit"), "Exit stop");
  destinationMarker = ensureMarker(destinationMarker, [destination.lat, destination.lng], pinIcon("dest", "D", "dest"), destination.name);

  if (boardWalkLayer) boardWalkLayer.remove();
  if (exitWalkLayer) exitWalkLayer.remove();
  const boardWalk = plan.walking?.toBoard?.geometry || [];
  const exitWalk = plan.walking?.fromExit?.geometry || [];
  boardWalkLayer = L.polyline(latLngsFromCoordinates(boardWalk), {
    color: "#486f8e",
    weight: 4,
    opacity: .78,
    dashArray: "6 7"
  }).addTo(map);
  exitWalkLayer = L.polyline(latLngsFromCoordinates(exitWalk), {
    color: "#3e7d57",
    weight: 4,
    opacity: .76,
    dashArray: "4 7"
  }).addTo(map);

  const bounds = L.latLngBounds([
    [board.lat, board.lng],
    ...(pull ? [[pull.lat, pull.lng]] : []),
    [exit.lat, exit.lng],
    [destination.lat, destination.lng],
    ...(state.currentLocation ? [[state.currentLocation.lat, state.currentLocation.lng]] : [])
  ]);
  if (bounds.isValid()) {
    const maxZoom = window.innerWidth < 560 ? 13 : 15;
    map.fitBounds(bounds, { padding: [42, 42], maxZoom });
  }
}

function pointForFocus(kind) {
  const plan = state.planResult?.plan;
  if (!plan) return null;
  if (kind === "origin" && state.currentLocation) return state.currentLocation;
  if (kind === "board") return plan.boardingStop;
  if (kind === "pull") return plan.previousStop || plan.exitStop;
  if (kind === "exit") return plan.exitStop;
  if (kind === "destination") return plan.destination;
  return null;
}

function focusPlanPoint(kind) {
  if (!state.mapReady) return;
  const point = pointForFocus(kind);
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
  map.setView([point.lat, point.lng], Math.max(map.getZoom(), 16), { animate: true });
  document.getElementById("map")?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function updateVehicleSamples(vehicles = []) {
  const now = Date.now();
  for (const vehicle of vehicles) {
    const previous = state.vehicleSamples.get(vehicle.id)?.current || null;
    state.vehicleSamples.set(vehicle.id, {
      previous,
      current: { ...vehicle, sampledAt: now }
    });
  }
}

function selectedVehicleSample() {
  const planVehicleId = state.planResult?.plan?.vehicle?.id;
  if (planVehicleId && state.vehicleSamples.has(planVehicleId)) return state.vehicleSamples.get(planVehicleId);
  const first = state.vehicleSamples.values().next();
  return first.done ? null : first.value;
}

function vectorEstimatedPoint(current, previous, ageMs) {
  if (!previous?.sampledAt || !Number.isFinite(previous.lat) || !Number.isFinite(previous.lng)) return null;
  const dt = Math.max(1, current.sampledAt - previous.sampledAt);
  const movedMeters = haversineMeters(previous, current);
  if (movedMeters < 6) return null;
  const scale = Math.min(1.5, ageMs / dt);
  return {
    lat: current.lat + (current.lat - previous.lat) * scale,
    lng: current.lng + (current.lng - previous.lng) * scale
  };
}

function estimatedVehiclePosition(sample, now = Date.now()) {
  if (!sample?.current) return null;
  const current = sample.current;
  const previous = sample.previous;
  if (!Number.isFinite(current.lat) || !Number.isFinite(current.lng)) return null;
  const ageMs = Math.max(0, now - (current.sampledAt || now));
  const speedMps = Math.max(0, Number(current.speedMph || 0) * METERS_PER_MILE / 3600);
  let point = { lat: current.lat, lng: current.lng };
  let positionMode = ageMs > BUS_ESTIMATE_MAX_MS ? "stale" : "live";

  if (ageMs > 1000 && ageMs <= BUS_ESTIMATE_MAX_MS) {
    if (speedMps > 0.45 && Number.isFinite(Number(current.bearing))) {
      point = destinationPoint(current, speedMps * (ageMs / 1000), Number(current.bearing));
      positionMode = "estimated";
    } else if (Number(current.speedMph || 0) >= 1) {
      const vectorPoint = vectorEstimatedPoint(current, previous, ageMs);
      if (vectorPoint) {
        point = vectorPoint;
        positionMode = "estimated";
      }
    }
  }

  return {
    ...current,
    ...point,
    ageSeconds: Math.floor(ageMs / 1000),
    positionMode,
    speedMps
  };
}

function smoothVehiclePosition(vehicle, now = Date.now()) {
  if (!vehicle) return null;
  const id = String(vehicle.id || "bus");
  const target = { lat: vehicle.lat, lng: vehicle.lng };
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lng)) return null;

  if (!busRenderState || busRenderState.id !== id) {
    busRenderState = { id, lat: target.lat, lng: target.lng, renderedAt: now };
    return { ...vehicle, displayEstimated: vehicle.positionMode !== "live" };
  }

  const rendered = { lat: busRenderState.lat, lng: busRenderState.lng };
  const distance = haversineMeters(rendered, target);
  const elapsedSeconds = Math.max(0.016, (now - busRenderState.renderedAt) / 1000);
  if (!Number.isFinite(distance) || distance > 1800) {
    busRenderState = { id, lat: target.lat, lng: target.lng, renderedAt: now };
    return { ...vehicle, displayEstimated: vehicle.positionMode !== "live" };
  }

  const maxMetersPerSecond = Math.max(10, Math.min(90, (vehicle.speedMps || 3) * 4 + 8));
  const stepMeters = Math.max(2, maxMetersPerSecond * elapsedSeconds);
  const ratio = distance <= stepMeters ? 1 : stepMeters / distance;
  const next = pointBetween(rendered, target, ratio);
  busRenderState = { id, lat: next.lat, lng: next.lng, renderedAt: now };

  return {
    ...vehicle,
    ...next,
    displayEstimated: vehicle.positionMode !== "live" || ratio < 1
  };
}

function animateBusMarker() {
  const now = Date.now();
  if (now - lastBusFrameMs < 120) {
    requestAnimationFrame(animateBusMarker);
    return;
  }
  lastBusFrameMs = now;
  const vehicle = smoothVehiclePosition(estimatedVehiclePosition(selectedVehicleSample(), now), now);
  if (vehicle && Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lng)) {
    const label = String(state.planResult?.plan?.route?.id || state.routeId || "B").slice(0, 3);
    const modeClass = vehicle.positionMode === "stale" ? "bus stale-bus" : vehicle.displayEstimated ? "bus estimated-bus" : "bus";
    const title = vehicle.positionMode === "stale" ? "Stale bus position" : vehicle.displayEstimated ? "Estimated live bus position" : "Live bus";
    busMarker = ensureMarker(busMarker, [vehicle.lat, vehicle.lng], pinIcon(modeClass, label, "bus"), title);
  }
  requestAnimationFrame(animateBusMarker);
}

function isOnboard(plan, now = Date.now()) {
  if (!plan) return false;
  return now > plan.timings.busArrivalMs + 90 * 1000 && now < plan.timings.exitArrivalMs + 7 * 60 * 1000;
}

function currentInstruction(plan) {
  if (!state.currentLocation) {
    return { text: "Use GPS", detail: "Waiting for current location." };
  }
  if (!plan) {
    return { text: "No plan", detail: "Route and destination do not produce a usable trip yet." };
  }

  const now = Date.now();
  const boardDistance = haversineMeters(state.currentLocation, plan.boardingStop);
  const exitDistance = haversineMeters(state.currentLocation, plan.exitStop);
  const onboard = isOnboard(plan, now);
  const pullByGps = now >= plan.timings.busArrivalMs && exitDistance < 520 && exitDistance > 80;

  if (onboard && exitDistance < 70) {
    return { text: "GET OFF HERE", detail: `${plan.exitStop.name} is the red X marker; ${formatFeet(exitDistance)} away.` };
  }

  if (onboard && (now >= plan.timings.pullCordAtMs || pullByGps)) {
    return { text: "PULL CORD NOW", detail: `Near the C marker; get off at ${formatTime(plan.timings.exitArrivalMs)} at ${plan.exitStop.name}.` };
  }

  if (onboard) {
    return { text: "Stay on bus", detail: `${remainingStopsText(plan)} remaining; red X is ${plan.exitStop.name}.` };
  }

  if (boardDistance < 115 && now >= plan.timings.busArrivalMs - 90 * 1000 && now <= plan.timings.busArrivalMs + 90 * 1000) {
    return { text: `Board Route ${plan.route.id}`, detail: `At B marker, ${plan.boardingStop.name}; bus arrival ${formatTime(plan.timings.busArrivalMs)}.` };
  }

  if (boardDistance < 85) {
    return { text: "Wait here", detail: `At B marker, ${plan.boardingStop.name}; bus arrival ${formatTime(plan.timings.busArrivalMs)}.` };
  }

  if (plan.status === "miss") {
    return { text: "Walk to stop", detail: "Likely miss; next usable bus stays selected." };
  }

  return { text: "Walk to stop", detail: `From blue me marker to B marker, ${plan.boardingStop.name}; ${formatWalk(plan.walking.toBoard.durationSeconds)} walk.` };
}

function remainingStopsText(plan) {
  const remaining = remainingStops(plan);
  if (!Number.isFinite(remaining)) return "--";
  return `${remaining} stop${remaining === 1 ? "" : "s"}`;
}

function remainingStops(plan) {
  if (!plan?.stopWindow?.length) return plan?.stopCount ?? NaN;
  const now = Date.now();
  const futureStops = plan.stopWindow.filter((stop) => stop.timeMs >= now);
  const exitSequence = plan.stopWindow[plan.stopWindow.length - 1]?.sequence;
  const nextSequence = futureStops[0]?.sequence ?? exitSequence;
  return Math.max(0, Number(exitSequence) - Number(nextSequence) + 1);
}

function statusLine(plan) {
  if (!plan) return "No usable trip from current location.";
  const now = Date.now();
  const marginMinutes = Math.floor((plan.timings.leaveByMs - now) / 60000);
  if (plan.status === "on_time" && marginMinutes >= 60) return "Early; no action yet.";
  if (plan.status === "on_time") return `On time; ${Math.max(0, marginMinutes)} min before latest leave.`;
  if (plan.status === "walk_faster") return "Walk faster; still catchable.";
  if (plan.status === "miss") return "Likely miss; waiting for next usable bus.";
  return "Current plan selected.";
}

function leadTimeText(minutes) {
  const safeMinutes = Math.max(0, Math.floor(Number(minutes) || 0));
  if (safeMinutes >= 60) {
    const hours = Math.floor(safeMinutes / 60);
    const remaining = safeMinutes % 60;
    return remaining ? `${hours} hr ${remaining} min` : `${hours} hr`;
  }
  return `${safeMinutes} min`;
}

function leaveByStatus(plan) {
  if (!plan) return "latest departure";
  const now = Date.now();
  const marginMinutes = Math.floor((plan.timings.leaveByMs - now) / 60000);
  if (plan.status === "on_time" && marginMinutes >= 60) return `No action yet; ${leadTimeText(marginMinutes)} before latest leave.`;
  return statusLine(plan);
}

function routeName(route) {
  const name = String(route?.name || "").trim();
  if (!name || name === `Route ${route?.id}`) return `Route ${route?.id || state.routeId || "--"}`;
  return `Route ${route.id} - ${name}`;
}

function vehicleStateText(plan) {
  const vehicle = plan?.vehicle;
  const live = estimatedVehiclePosition(selectedVehicleSample()) || vehicle;
  if (!live) return "No live vehicle matched";
  const ageSeconds = Number.isFinite(live.ageSeconds)
    ? live.ageSeconds
    : live.sampledAt ? Math.floor((Date.now() - live.sampledAt) / 1000) : 0;
  const freshness = live.positionMode === "stale" ? "stale" : live.positionMode === "estimated" ? "estimated" : "live";
  const movement = Number(live.speedMph) < 1 ? "stopped / light" : `${Math.round(live.speedMph)} mph`;
  return `Bus ${live.equipment || live.id} - ${freshness} ${ageSeconds}s - ${movement} - ${live.delay || "schedule state"}`;
}

function updateTripChoice() {
  const result = state.planResult;
  const plan = result?.plan;
  if (!plan) {
    setText(els.tripChoice, "Soonest trip");
    if (els.previousTrip) els.previousTrip.disabled = state.choiceOffset <= 0;
    if (els.nextTrip) els.nextTrip.disabled = true;
    return;
  }
  const selected = Number(result.selectedChoiceIndex || 0);
  const count = Number(result.choiceCount || 0);
  setText(els.tripChoice, count > 1
    ? `Trip ${selected + 1} of ${count} - get off ${formatTime(plan.timings.exitArrivalMs)}`
    : `Get off ${formatTime(plan.timings.exitArrivalMs)}`);
  if (els.previousTrip) els.previousTrip.disabled = selected <= 0;
  if (els.nextTrip) els.nextTrip.disabled = count > 0 ? selected >= count - 1 : true;
}

function renderFacts() {
  const result = state.planResult;
  const plan = result?.plan;
  if (!plan) {
    const routeId = state.routeId || "";
    setText(els.routeStatus, routeId ? `Route ${routeId}` : "Route picked after destination");
    setText(els.sourceState, result?.sources?.map((source) => `${source.name}: ${source.ok ? "OK" : "blocked"}`).join(" / ") || "Checking");
    updateTripChoice();
    return;
  }

  const instruction = currentInstruction(plan);
  setText(els.instructionText, instruction.text);
  setText(els.instructionDetail, `${instruction.detail} ${statusLine(plan)}`);

  setText(els.standByTime, formatTime(plan.timings.standByMs));
  setText(els.standBySub, `B marker: ${plan.boardingStop.name}`);
  setText(els.leaveByTime, formatTime(plan.timings.leaveByMs));
  setText(els.leaveBySub, `Current location, blue me marker. ${leaveByStatus(plan)}`);
  setText(els.boardingStop, plan.boardingStop.name);
  setText(els.boardingDistance, `${formatMiles(plan.walking.toBoard.distanceMeters)} away`);
  setText(els.walkTime, formatWalk(plan.walking.toBoard.durationSeconds));
  setText(els.walkDistance, "blue me marker to B marker");
  setText(els.busArrival, formatTime(plan.timings.busArrivalMs));
  setText(
    els.busArrivalSub,
    plan.prediction
      ? `B marker; to ${plan.route.headsign}; WRTA live, schedule ${formatTime(plan.timings.scheduledBusArrivalMs)}`
      : `B marker; to ${plan.route.headsign}; Ride Guide schedule`
  );
  setText(els.busTarget, routeName(plan.route));
  setText(els.busLiveState, vehicleStateText(plan));
  setText(els.pullCord, formatTime(plan.timings.pullCordAtMs));
  setText(els.pullCordSub, plan.previousStop
    ? `C marker after ${plan.previousStop.name}; before red X at ${plan.exitStop.name}`
    : `C marker before red X at ${plan.exitStop.name}`);
  setText(els.exitStop, `${formatTime(plan.timings.exitArrivalMs)} - ${plan.exitStop.name}`);
  setText(els.exitSub, `Red X marker; ${formatMiles(plan.walking.fromExit.distanceMeters)} from ${plan.destination.name}`);
  setText(els.stopsRemaining, remainingStopsText(plan));
  setText(els.routeStatus, routeName(plan.route));
  setText(els.sourceState, (result.sources || []).map((source) => `${source.name}: ${source.ok ? "OK" : "blocked"}`).join(" / "));
  updateTripChoice();
}

function renderLocationState() {
  if (state.currentLocation) {
    const acc = Number.isFinite(state.locationAccuracy) ? ` - ${Math.round(state.locationAccuracy)} m` : "";
    setText(els.locationState, `${state.locationSource || "GPS"}${acc}`);
  } else {
    setText(els.locationState, "Waiting");
  }
  const home = savedHome();
  setText(els.homeState, home ? "Saved" : "Not set");
}

function savedHome() {
  try {
    const raw = localStorage.getItem("bus.aolabs.home");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed.lat) && Number.isFinite(parsed.lng)) return parsed;
  } catch {
    return null;
  }
  return null;
}

function useSavedHomeIfNeeded() {
  if (state.currentLocation) return;
  const home = savedHome();
  if (!home) return;
  state.currentLocation = { lat: home.lat, lng: home.lng };
  state.locationAccuracy = null;
  state.locationSource = "Saved home";
  renderLocationState();
  refreshPlan();
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    useSavedHomeIfNeeded();
    return;
  }
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = navigator.geolocation.watchPosition(
    (position) => {
      state.currentLocation = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
      state.locationAccuracy = position.coords.accuracy;
      state.locationSource = "GPS";
      renderLocationState();
      refreshPlan();
    },
    () => {
      useSavedHomeIfNeeded();
      renderLocationState();
    },
    {
      enableHighAccuracy: true,
      maximumAge: 6000,
      timeout: 16000
    }
  );
}

async function loadRoute(routeId = state.routeId) {
  const selectedRouteId = String(routeId || state.routeId || "").trim();
  if (!selectedRouteId) return;
  const previousRouteId = state.routeId;
  state.routeId = selectedRouteId;
  if (previousRouteId && previousRouteId !== selectedRouteId) {
    state.vehicleSamples.clear();
    busRenderState = null;
    if (busMarker) {
      busMarker.remove();
      busMarker = null;
    }
  }
  try {
    state.routeData = await api(`/api/route?routeId=${encodeURIComponent(state.routeId)}`);
    renderRoute();
    setText(els.routeStatus, routeName({
      id: state.routeData.routeId,
      name: state.routeData.line?.longName || state.routeData.line?.shortName || ""
    }));
  } catch (error) {
    setText(els.routeStatus, `Route ${state.routeId} blocked`);
    setText(els.sourceState, error.message);
  }
}

async function refreshPlan() {
  if (!state.currentLocation) return;
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    try {
      const params = new URLSearchParams({
        lat: String(state.currentLocation.lat),
        lng: String(state.currentLocation.lng),
        choice: String(state.choiceOffset),
        now: String(Date.now()),
        ...destinationQueryParams()
      });
      const targetArrivalMs = targetArrivalMsFromInput();
      if (Number.isFinite(targetArrivalMs)) params.set("targetArrivalMs", String(targetArrivalMs));
      state.planResult = await api(`/api/plan?${params}`);
      const plannedRouteId = state.planResult?.plan?.route?.id || "";
      if (plannedRouteId && (!state.routeData || state.routeData.routeId !== plannedRouteId)) {
        await loadRoute(plannedRouteId);
      }
      renderFacts();
      renderPlanOnMap();
    } catch (error) {
      state.planResult = { ok: false, sources: [{ name: "plan", ok: false, error: error.message }] };
      setText(els.instructionText, "No plan");
      setText(els.instructionDetail, error.message);
      renderFacts();
    }
  }, 180);
}

async function refreshLive() {
  try {
    const routeId = state.planResult?.plan?.route?.id || state.routeId;
    if (!routeId) return;
    const live = await api(`/api/live?routeId=${encodeURIComponent(routeId)}`);
    state.liveStatus = live.status;
    updateVehicleSamples(live.vehicles || []);
    renderFacts();
  } catch (error) {
    state.liveStatus = { ok: false, error: error.message };
    renderFacts();
  }
}

function saveCurrentHome() {
  if (!state.currentLocation) return;
  localStorage.setItem("bus.aolabs.home", JSON.stringify({
    lat: state.currentLocation.lat,
    lng: state.currentLocation.lng,
    savedAt: new Date().toISOString()
  }));
  renderLocationState();
}

function bindEvents() {
  document.getElementById("tripControls").addEventListener("submit", (event) => {
    event.preventDefault();
    resetTripChoice();
    resolveDestinationInput();
  });
  els.useGps.addEventListener("click", startLocationWatch);
  els.saveHome.addEventListener("click", saveCurrentHome);
  els.routeInput?.addEventListener("change", async () => {
    resetTripChoice();
    state.routeId = (els.routeInput.value || "").trim();
    await loadRoute();
    refreshPlan();
    refreshLive();
  });
  els.destinationInput.addEventListener("change", () => {
    resetTripChoice();
    resolveDestinationInput();
  });
  els.destinationInput.addEventListener("blur", () => {
    resetTripChoice();
    resolveDestinationInput();
  });
  els.destinationInput.addEventListener("input", () => {
    clearTimeout(destinationTimer);
    clearTimeout(suggestionTimer);
    resetTripChoice();
    const exactDestination = savedDestinationMatch(els.destinationInput.value) || suggestionDestinationMatch(els.destinationInput.value);
    if (exactDestination) {
      applyDestination(exactDestination);
      refreshPlan();
      return;
    }
    suggestionTimer = setTimeout(refreshDestinationSuggestions, 260);
    destinationTimer = setTimeout(() => {
      const exactSuggestion = suggestionDestinationMatch(els.destinationInput.value);
      if (exactSuggestion) {
        applyDestination(exactSuggestion);
        refreshPlan();
      }
    }, 900);
  });
  els.arrivalInput?.addEventListener("change", () => {
    resetTripChoice();
    refreshPlan();
  });
  els.previousTrip?.addEventListener("click", () => {
    state.choiceOffset -= 1;
    refreshPlan();
  });
  els.nextTrip?.addEventListener("click", () => {
    state.choiceOffset += 1;
    refreshPlan();
  });
  document.querySelectorAll(".step[data-focus]").forEach((step) => {
    step.addEventListener("click", () => focusPlanPoint(step.dataset.focus));
  });
}

async function boot() {
  initMap();
  bindEvents();
  renderLocationState();
  await loadDestinations();
  startLocationWatch();
  useSavedHomeIfNeeded();
  refreshLive();
  liveTimer = setInterval(refreshLive, BUS_LIVE_POLL_MS);
  setInterval(refreshPlan, 25000);
  requestAnimationFrame(animateBusMarker);
}

boot();
