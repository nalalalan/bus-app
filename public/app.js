const state = {
  routeId: "31",
  destinationId: "chipotle",
  destination: {
    id: "chipotle",
    label: "Chipotle, Park Ave",
    name: "Chipotle",
    lat: 42.281927,
    lng: -71.8082589
  },
  savedDestinations: [],
  routeData: null,
  planResult: null,
  currentLocation: null,
  locationAccuracy: null,
  locationSource: "",
  watchId: null,
  vehicleSamples: new Map(),
  liveStatus: null,
  mapReady: false
};

const els = {
  routeInput: document.getElementById("routeInput"),
  destinationInput: document.getElementById("destinationInput"),
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
let exitMarker;
let destinationMarker;
let busMarker;
let planTimer;
let liveTimer;
let destinationTimer;

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
  const radius = 6371000;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function setText(element, value) {
  element.textContent = value || "--";
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

function destinationQueryParams() {
  const destination = state.destination || {};
  if (destination.id && destination.id !== "custom") {
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

function applyDestination(destination) {
  if (!destination) return;
  state.destination = destination;
  state.destinationId = destination.id || "custom";
  const label = destination.label || destination.name || "";
  if (label && els.destinationInput.value !== label) els.destinationInput.value = label;
}

async function loadDestinations() {
  try {
    const data = await api("/api/destinations");
    state.savedDestinations = data.destinations || [];
    const datalist = document.getElementById("destinationOptions");
    if (datalist) {
      datalist.innerHTML = state.savedDestinations
        .map((destination) => `<option value="${destination.label || destination.name}"></option>`)
        .join("");
    }
    applyDestination(savedDestinationMatch(els.destinationInput.value) || state.savedDestinations[0] || state.destination);
  } catch {
    state.savedDestinations = [];
  }
}

async function resolveDestinationInput() {
  const value = els.destinationInput.value.trim();
  const saved = savedDestinationMatch(value);
  if (saved) {
    applyDestination(saved);
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
    [exit.lat, exit.lng],
    [destination.lat, destination.lng],
    ...(state.currentLocation ? [[state.currentLocation.lat, state.currentLocation.lng]] : [])
  ]);
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [42, 42], maxZoom: 15 });
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

function interpolatedVehicle(sample) {
  if (!sample?.current) return null;
  const current = sample.current;
  const previous = sample.previous;
  if (!previous) return current;
  const dt = Math.max(1, current.sampledAt - previous.sampledAt);
  const t = Math.max(0, Math.min(1.2, (Date.now() - current.sampledAt) / dt));
  return {
    ...current,
    lat: current.lat + (current.lat - previous.lat) * Math.max(0, t - 1) * 0.35,
    lng: current.lng + (current.lng - previous.lng) * Math.max(0, t - 1) * 0.35
  };
}

function animateBusMarker() {
  const vehicle = interpolatedVehicle(selectedVehicleSample());
  if (vehicle && Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lng)) {
    const label = String(state.planResult?.plan?.route?.id || state.routeId || "B").slice(0, 3);
    busMarker = ensureMarker(busMarker, [vehicle.lat, vehicle.lng], pinIcon("bus", label, "bus"), "Live bus");
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

  if (onboard && exitDistance < 70) {
    return { text: "GET OFF HERE", detail: `${plan.exitStop.name} is within ${formatFeet(exitDistance)}.` };
  }

  if (onboard && (now >= plan.timings.pullCordAtMs || exitDistance < 430)) {
    return { text: "PULL CORD NOW", detail: `${plan.exitStop.name}; get off at ${formatTime(plan.timings.exitArrivalMs)}.` };
  }

  if (onboard) {
    return { text: "Stay on bus", detail: `${remainingStopsText(plan)} remaining to ${plan.exitStop.name}.` };
  }

  if (boardDistance < 115 && now >= plan.timings.busArrivalMs - 90 * 1000 && now <= plan.timings.busArrivalMs + 90 * 1000) {
    return { text: `Board Route ${plan.route.id}`, detail: `${plan.route.headsign}; bus arrival ${formatTime(plan.timings.busArrivalMs)}.` };
  }

  if (boardDistance < 85) {
    return { text: "Wait here", detail: `${plan.boardingStop.name}; bus arrival ${formatTime(plan.timings.busArrivalMs)}.` };
  }

  if (plan.status === "miss") {
    return { text: "Walk to stop", detail: "Likely miss; next usable bus stays selected." };
  }

  return { text: "Walk to stop", detail: `${plan.boardingStop.name}; ${formatWalk(plan.walking.toBoard.durationSeconds)} walk.` };
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
  if (plan.status === "on_time") return `On time; ${Math.max(0, marginMinutes)} min before latest leave.`;
  if (plan.status === "walk_faster") return "Walk faster; still catchable.";
  if (plan.status === "miss") return "Likely miss; waiting for next usable bus.";
  return "Current plan selected.";
}

function vehicleStateText(plan) {
  const vehicle = plan?.vehicle;
  const live = selectedVehicleSample()?.current || vehicle;
  if (!live) return "No live vehicle matched";
  const ageSeconds = live.sampledAt ? Math.floor((Date.now() - live.sampledAt) / 1000) : 0;
  const freshness = ageSeconds > 45 ? "stale" : "live";
  const movement = Number(live.speedMph) < 1 ? "stopped / light" : `${Math.round(live.speedMph)} mph`;
  return `Bus ${live.equipment || live.id} - ${freshness} - ${movement} - ${live.delay || "schedule state"}`;
}

function renderFacts() {
  const result = state.planResult;
  const plan = result?.plan;
  if (!plan) {
    const routeId = state.routeId || "31";
    setText(els.routeStatus, `Route ${routeId}`);
    setText(els.sourceState, result?.sources?.map((source) => `${source.name}: ${source.ok ? "OK" : "blocked"}`).join(" / ") || "Checking");
    return;
  }

  const instruction = currentInstruction(plan);
  setText(els.instructionText, instruction.text);
  setText(els.instructionDetail, `${instruction.detail} ${statusLine(plan)}`);

  setText(els.standByTime, formatTime(plan.timings.standByMs));
  setText(els.standBySub, "3 min before bus");
  setText(els.leaveByTime, formatTime(plan.timings.leaveByMs));
  setText(els.leaveBySub, statusLine(plan));
  setText(els.boardingStop, plan.boardingStop.name);
  setText(els.boardingDistance, `${formatMiles(plan.walking.toBoard.distanceMeters)} away`);
  setText(els.walkTime, formatWalk(plan.walking.toBoard.durationSeconds));
  setText(els.walkDistance, plan.walking.toBoard.source);
  setText(els.busArrival, formatTime(plan.timings.busArrivalMs));
  setText(
    els.busArrivalSub,
    plan.prediction ? `WRTA live; schedule ${formatTime(plan.timings.scheduledBusArrivalMs)}` : "Ride Guide schedule"
  );
  setText(els.busTarget, `Route ${plan.route.id} to ${plan.route.headsign}`);
  setText(els.busLiveState, vehicleStateText(plan));
  setText(els.pullCord, formatTime(plan.timings.pullCordAtMs));
  setText(els.pullCordSub, plan.previousStop ? `near ${plan.previousStop.name}` : "before exit stop");
  setText(els.exitStop, plan.exitStop.name);
  setText(els.exitSub, `${formatTime(plan.timings.exitArrivalMs)} - ${formatMiles(plan.walking.fromExit.distanceMeters)} from ${plan.destination.name}`);
  setText(els.stopsRemaining, remainingStopsText(plan));
  setText(els.routeStatus, `Route ${plan.route.id} - ${plan.route.headsign}`);
  setText(els.sourceState, (result.sources || []).map((source) => `${source.name}: ${source.ok ? "OK" : "blocked"}`).join(" / "));
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

async function loadRoute() {
  state.routeId = (els.routeInput.value || "31").trim() || "31";
  try {
    state.routeData = await api(`/api/route?routeId=${encodeURIComponent(state.routeId)}`);
    renderRoute();
    setText(els.routeStatus, `Route ${state.routeData.routeId}`);
  } catch (error) {
    setText(els.routeStatus, `Route ${state.routeId} blocked`);
    setText(els.sourceState, error.message);
  }
}

async function refreshPlan() {
  if (!state.currentLocation) return;
  clearTimeout(planTimer);
  planTimer = setTimeout(async () => {
    state.routeId = (els.routeInput.value || "31").trim() || "31";
    try {
      const params = new URLSearchParams({
        lat: String(state.currentLocation.lat),
        lng: String(state.currentLocation.lng),
        routeId: state.routeId,
        now: String(Date.now()),
        ...destinationQueryParams()
      });
      state.planResult = await api(`/api/plan?${params}`);
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
    const routeId = (els.routeInput.value || "31").trim() || "31";
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
    resolveDestinationInput();
  });
  els.useGps.addEventListener("click", startLocationWatch);
  els.saveHome.addEventListener("click", saveCurrentHome);
  els.routeInput.addEventListener("change", async () => {
    await loadRoute();
    refreshPlan();
    refreshLive();
  });
  els.destinationInput.addEventListener("change", resolveDestinationInput);
  els.destinationInput.addEventListener("blur", resolveDestinationInput);
  els.destinationInput.addEventListener("input", () => {
    clearTimeout(destinationTimer);
    destinationTimer = setTimeout(resolveDestinationInput, 900);
  });
}

async function boot() {
  initMap();
  bindEvents();
  renderLocationState();
  await loadDestinations();
  await loadRoute();
  startLocationWatch();
  useSavedHomeIfNeeded();
  refreshLive();
  setInterval(refreshLive, 8000);
  setInterval(refreshPlan, 25000);
  requestAnimationFrame(animateBusMarker);
}

boot();
