const ROUTES = ["2", "4", "3", "30", "31"];
const PLANNING_ROUTE_IDS = ["11", "23", "24", "26", "27", "30", "33"];
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
  gpsButton: document.getElementById("gpsButton"),
  gpsHint: document.getElementById("gpsHint"),
  locationList: document.getElementById("locationList"),
  busList: document.getElementById("busList"),
  optionList: document.getElementById("optionList"),
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
const PLAN_REFRESH_MS = 3000;
const EARTH_RADIUS_METERS = 6371000;
const timeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit"
});
const minuteTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit"
});
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});
const datedMinuteTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit"
});

let map;
let refreshTimer;
let renderTimer;
let planRefreshTimer;
let currentLocation = null;
let currentMarker = null;
let selectedLocationId = null;
let selectedRouteId = "";
let selectedStopLayer = null;
let selectedTripLayer = null;
let selectedConnectorLayer = null;
let selectedArrivalData = null;
let selectedPlanData = null;
let selectedChoiceIndex = 0;
let followVehicleKey = "";
let gpsStatus = "GPS needed";
let gpsRequestPromise = null;
let gpsPermissionStatus = null;
let locationWatchId = null;
let selectedLocationRequestId = 0;
let selectedPlanRefreshRequestId = 0;
let selectedPlanRefreshRunning = false;
let locateMapButton = null;
let resetMapButton = null;
let planPrefetchRunning = false;
let programmaticCameraUntil = 0;
const prefetchedPlanKeys = new Set();

function api(path) {
  return fetch(path, { cache: "no-store" }).then(async (response) => {
    const json = await response.json();
    if (!response.ok) throw new Error(json.error || `${response.status}`);
    return json;
  });
}

function planRequestPath(location, choiceIndex = 0) {
  return `/api/plan?lat=${encodeURIComponent(currentLocation.lat)}&lng=${encodeURIComponent(currentLocation.lng)}&destination=${encodeURIComponent(location.id)}&choice=${encodeURIComponent(choiceIndex)}&now=${Date.now()}`;
}

function planPrefetchKey(location) {
  if (!hasGpsLocation()) return "";
  return [
    location.id,
    currentLocation.lat.toFixed(4),
    currentLocation.lng.toFixed(4),
    Math.floor(Date.now() / 60000)
  ].join(":");
}

async function prefetchLocationPlans() {
  if (planPrefetchRunning || !hasGpsLocation()) return;
  planPrefetchRunning = true;
  try {
    const locations = [
      ...LOCATIONS.filter((location) => location.id === selectedLocationId),
      ...LOCATIONS.filter((location) => location.id !== selectedLocationId)
    ];
    for (const location of locations) {
      if (!hasGpsLocation()) break;
      const key = planPrefetchKey(location);
      if (!key || prefetchedPlanKeys.has(key)) continue;
      prefetchedPlanKeys.add(key);
      api(planRequestPath(location)).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    planPrefetchRunning = false;
  }
}

function schedulePlanPrefetch() {
  if (!hasGpsLocation()) return;
  setTimeout(prefetchLocationPlans, 300);
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
    zoomControl: false,
    attributionControl: true
  }).setView([42.2623388, -71.8011645], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 20,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);

  addMapControls();
}

function mapControlIcon(kind) {
  if (kind === "locate") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3v3m0 12v3M3 12h3m12 0h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      <circle cx="12" cy="12" r="5.2" fill="none" stroke="currentColor" stroke-width="2"/>
      <circle cx="12" cy="12" r="1.7" fill="currentColor"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 6h6a4 4 0 0 1 0 8H8a3 3 0 0 0 0 6h9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="m5 8 2-2 2 2m8 10 2 2 2-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function addMapButton(container, className, title, icon, handler) {
  const button = L.DomUtil.create("button", `map-action-button ${className}`, container);
  button.type = "button";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.innerHTML = icon;
  L.DomEvent.on(button, "click", (event) => {
    L.DomEvent.stop(event);
    handler();
  });
  return button;
}

function addMapControls() {
  const actionControl = L.control({ position: "topleft" });
  actionControl.onAdd = () => {
    const container = L.DomUtil.create("div", "leaflet-control map-control-stack");
    L.DomEvent.disableClickPropagation(container);
    L.DomEvent.disableScrollPropagation(container);
    locateMapButton = addMapButton(container, "locate", "Center on current location", mapControlIcon("locate"), centerOnCurrentLocation);
    resetMapButton = addMapButton(container, "route-reset", "Show selected route", mapControlIcon("route"), resetRouteView);
    return container;
  };
  actionControl.addTo(map);
  L.control.zoom({ position: "topleft" }).addTo(map);
  map.on("dragstart zoomstart", handleManualCameraMove);
}

function markProgrammaticCameraMove() {
  programmaticCameraUntil = Date.now() + 900;
}

function handleManualCameraMove() {
  if (Date.now() < programmaticCameraUntil) return;
  if (!followVehicleKey) return;
  followVehicleKey = "";
  renderBusList();
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

function currentPhotoIcon() {
  return L.divIcon({
    className: "current-marker",
    html: `<span class="current-photo"><img src="/assets/alan-current.png" alt=""></span>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23]
  });
}

function logoImg(src, alt) {
  return `<img class="place-logo" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
}

function locationGlyph(location) {
  if (location.id === "william") {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 15 16 6l11 9v11h-7v-7h-8v7H5z" fill="currentColor"/></svg>`;
  }
  if (location.id === "alden") {
    return logoImg("/assets/wpi-favicon.ico", "WPI");
  }
  if (location.id === "union") {
    return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 4h14c3 0 5 2 5 5v10c0 3-2 5-5 5l3 4h-5l-2-4h-6l-2 4H6l3-4c-3 0-5-2-5-5V9c0-3 2-5 5-5zm0 5v5h14V9H9zm2 9a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="currentColor"/></svg>`;
  }
  if (location.id === "chipotle") {
    return logoImg("/assets/chipotle-logo.svg", "Chipotle");
  }
  if (location.id === "coldstone") {
    return logoImg("/assets/coldstone-mark.png", "Cold Stone");
  }
  if (location.id === "blackstone") {
    return `<svg class="popcorn-icon" viewBox="0 0 32 32" aria-hidden="true">
      <path d="M9 12h14l-2 16H11L9 12z" fill="#ffffff" stroke="#171717" stroke-width="1.4" stroke-linejoin="round"/>
      <path d="M12 14h3l.8 12H13l-1-12zm5 0h3l-1 12h-2.8L17 14z" fill="#c7342d"/>
      <path d="M8 13c-2.2-.7-2.8-3.8-.8-5.1 1.2-.8 2.5-.5 3.2.4.1-2.3 3-3.6 4.7-2 1.2-2.8 5.2-2.8 6.4 0 1.8-1.3 4.7 0 4.7 2.3 1-.7 2.3-.6 3.2.4 1.5 1.7.5 4.2-1.7 4.7H8z" fill="#f2c94c" stroke="#171717" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="M10.6 8.7c1.1 1.8 2.6 2.7 4.3 2.6m5.5-5c-.8 2-1 3.6-.4 5m4.7-2.7c-1.4 1-2.2 2.2-2.4 3.8" fill="none" stroke="#ffffff" stroke-width="1.1" stroke-linecap="round"/>
    </svg>`;
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

function busStopSvg() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 4h14c2 0 4 2 4 4v11c0 2-1 4-3 4l2 5h-4l-2-4h-8l-2 4H6l2-5c-2 0-3-2-3-4V8c0-2 2-4 4-4zm1 5v7h12V9H10zm2 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm8 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" fill="currentColor"/></svg>`;
}

function busStopIcon(kind, label, color = "#555555") {
  const size = kind === "route" ? 18 : 42;
  return L.divIcon({
    className: "stop-marker",
    html: `<span class="bus-stop-pin ${escapeHtml(kind)}" style="--stop-color:${normalizeColor(color)}">${busStopSvg()}${label ? `<span>${escapeHtml(label)}</span>` : ""}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function walkLabelIcon(label) {
  return L.divIcon({
    className: "walk-label-marker",
    html: `<span class="walk-label">${escapeHtml(label)}</span>`,
    iconSize: [98, 22],
    iconAnchor: [49, 11]
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

function normalizePlanArrivals(planData, location) {
  const plan = planData?.plan;
  if (!plan?.boardingStop || !plan?.exitStop) return null;
  const isJourney = Array.isArray(plan.legs) && plan.legs.length > 1;
  const firstLeg = isJourney ? plan.legs[0] : null;
  const lastLeg = isJourney ? plan.legs[plan.legs.length - 1] : null;
  const scheduledBusMs = Number((firstLeg?.timings?.scheduledBusArrivalMs) ?? plan.timings?.scheduledBusArrivalMs);
  const predictedBusMs = Number((firstLeg?.timings?.busArrivalMs) ?? plan.timings?.busArrivalMs ?? scheduledBusMs);
  const hasPrediction = Boolean(plan.prediction || plan.predictions?.length || plan.legs?.some((leg) => leg.prediction));
  const scheduleDelayMs = Number.isFinite(predictedBusMs) && Number.isFinite(scheduledBusMs)
    ? predictedBusMs - scheduledBusMs
    : 0;
  const scheduledDestinationArrivalMs = Number(plan.timings?.scheduledDestinationArrivalMs)
    || Number(plan.timings?.exitArrivalMs) + Math.round(Number(plan.walking?.fromExit?.durationSeconds || 0) * 1000);
  const destinationArrivalMs = Number(plan.timings?.destinationArrivalMs) || scheduledDestinationArrivalMs + scheduleDelayMs;
  const boardingStop = {
    ...plan.boardingStop,
    distanceMeters: plan.walking?.toBoard?.distanceMeters
  };
  const exitStop = {
    ...plan.exitStop,
    distanceMeters: plan.walking?.fromExit?.distanceMeters
  };

  return {
    ok: true,
    mode: isJourney ? "journey" : "trip",
    location,
    route: plan.route,
    routeIds: plan.routeIds || (isJourney ? plan.legs.map((leg) => leg.route.id) : [plan.route.id]),
    stop: boardingStop,
    boardingStop,
    exitStop,
    legs: plan.legs || [],
    transfers: plan.transfers || [],
    plan,
    choiceCount: planData.choiceCount || 0,
    selectedChoiceIndex: planData.selectedChoiceIndex || 0,
    walking: plan.walking,
    arrivals: [{
      routeId: plan.route.id,
      routeName: plan.route.name || `Route ${plan.route.id}`,
      destination: isJourney ? `${plan.legs.length} buses` : plan.route.headsign || "destination",
      scheduledMs: scheduledBusMs,
      predictedMs: predictedBusMs,
      scheduledDestinationArrivalMs,
      destinationArrivalMs,
      hasPrediction,
      predictionCheckedAt: plan.prediction?.checkedAt || plan.predictions?.[0]?.checkedAt || "",
      walkToStopSeconds: plan.walking?.toBoard?.durationSeconds,
      walkToStopMeters: plan.walking?.toBoard?.distanceMeters,
      transferWalkSeconds: plan.walking?.transfer?.durationSeconds,
      transferWalkMeters: plan.walking?.transfer?.distanceMeters,
      walkFromStopSeconds: plan.walking?.fromExit?.durationSeconds,
      walkFromStopMeters: plan.walking?.fromExit?.distanceMeters,
      source: hasPrediction ? "WRTA live prediction" : "WRTA schedule"
    }]
  };
}

function routeSequenceText(routeIds = []) {
  return routeIds.map((routeId) => String(routeId).replace(/^Route\s+/i, "")).join(" + ");
}

function choiceTitle(choice) {
  const routeIds = choice.summary?.routeIds || (choice.route?.id ? String(choice.route.id).split(" + ") : []);
  const basis = choice.summary?.hasPrediction ? "predicted" : "scheduled";
  return `${routeSequenceText(routeIds)} ${formatMinuteTime(choice.summary?.destinationArrivalMs)} ${basis} arrival`;
}

function renderTripOptions(planData = selectedPlanData) {
  if (!els.optionList) return;
  const choices = (planData?.choices || []).filter((choice) => choice.status !== "miss");
  if (!choices.length || planData?.pending || planData?.error) {
    els.optionList.innerHTML = "";
    return;
  }
  const current = Number(selectedChoiceIndex) || 0;
  const next = choices.find((choice) => Number(choice.index) > current);
  const buttons = [
    next ? { label: "Next", choice: next } : null
  ].filter(Boolean);
  els.optionList.innerHTML = buttons.map(({ label, choice }) => (
    `<button class="option-row trip-nav-row" type="button" data-choice="${escapeHtml(choice.index)}">
      <strong>${escapeHtml(`${label}: ${choiceTitle(choice)}`)}</strong>
    </button>`
  )).join("");
}

function tripArrivalMs(data, arrival = data?.arrivals?.[0]) {
  return Number(arrival?.destinationArrivalMs)
    || Number(data?.plan?.timings?.destinationArrivalMs)
    || Number(data?.plan?.timings?.exitArrivalMs)
    || Number(arrival?.predictedMs)
    || NaN;
}

function tripTitle(data, location) {
  const routeText = routeSequenceText(data?.routeIds || (data?.route?.id ? [data.route.id] : []));
  const arrival = formatMinuteTime(tripArrivalMs(data));
  const basis = hasLivePrediction(data) ? "predicted" : "scheduled";
  return routeText ? `${routeText} ${arrival} ${basis} arrival` : `${location?.name || "Trip"} ${arrival}`;
}

function hasLivePrediction(data) {
  return Boolean(data?.plan?.prediction || data?.plan?.predictions?.length || data?.legs?.some((leg) => leg.prediction) || data?.arrivals?.some((arrival) => arrival.hasPrediction));
}

function predictionDetail(predictedMs, scheduledMs, hasPrediction = false, label = "") {
  const scheduledTime = Number.isFinite(Number(scheduledMs)) ? formatMinuteTime(scheduledMs) : "";
  if (hasPrediction) {
    return scheduledTime ? `${label || "WRTA predicted"}; scheduled ${scheduledTime}` : (label || "WRTA predicted");
  }
  return scheduledTime ? `scheduled ${scheduledTime}` : "scheduled";
}

function predictionUpdatedText(data) {
  const checkedAt = data?.plan?.prediction?.checkedAt || data?.plan?.predictions?.[0]?.checkedAt || data?.arrivals?.find((arrival) => arrival.predictionCheckedAt)?.predictionCheckedAt || "";
  if (!checkedAt) return "";
  return `updated ${timeFormatter.format(new Date(checkedAt))}`;
}

function primaryBoardLeg(data, arrival = data?.arrivals?.[0]) {
  const legs = tripLegs(data, arrival);
  return legs[0] || null;
}

function stopTimeDetail(data, arrival = data?.arrivals?.[0]) {
  const leg = primaryBoardLeg(data, arrival);
  if (!leg) return "";
  const stopName = displayStopLabel(leg.boardingStop, "boarding stop");
  const predicted = formatMinuteTime(leg.timings?.busArrivalMs);
  const scheduled = formatMinuteTime(leg.timings?.scheduledBusArrivalMs);
  const updated = predictionUpdatedText(data);
  return [
    `Boarding stop ${stopName}`,
    `bus at stop predicted ${predicted}`,
    `scheduled ${scheduled}`,
    updated
  ].filter(Boolean).join("; ");
}

function displayStopName(stopOrName, fallback = "stop") {
  const rawName = typeof stopOrName === "string" ? stopOrName : stopOrName?.name;
  return String(rawName || fallback)
    .replace(/\bSgamore\b/g, "Sagamore")
    .replace(/\bN\.([A-Z])/g, "N. $1")
    .replace(/\s+/g, " ")
    .trim();
}

function displayStopLabel(stopOrName, fallback = "stop") {
  const name = displayStopName(stopOrName, fallback);
  const code = typeof stopOrName === "string" ? "" : String(stopOrName?.code || "").trim();
  return code ? `${name} (Stop ${code})` : name;
}

function formatTripStepTime(ms, tripDateMs) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "--";
  const date = new Date(Math.round(value / 60000) * 60000);
  const tripDate = Number.isFinite(Number(tripDateMs)) ? new Date(Number(tripDateMs)) : null;
  if (tripDate && dayKeyFormatter.format(date) === dayKeyFormatter.format(tripDate)) {
    return minuteTimeFormatter.format(date);
  }
  return formatMinuteTime(value);
}

function tripStepRow(timeMs, action, details = [], tripDateMs = NaN) {
  const detailText = details.filter(Boolean).join("; ");
  return `<div class="arrival-row trip-step">
    <strong>${escapeHtml(`${formatTripStepTime(timeMs, tripDateMs)} ${action}`)}</strong>
    ${detailText ? `<span>${escapeHtml(detailText)}</span>` : ""}
  </div>`;
}

function stopTimeCell(label, value, className = "") {
  return `<div class="stop-time-cell ${escapeHtml(className)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value || "--")}</strong>
  </div>`;
}

function boardingStepRow(leg, details = [], tripDateMs = NaN) {
  const routeId = leg.route?.id || "";
  const stopName = displayStopLabel(leg.boardingStop);
  const detailText = details.filter(Boolean).join("; ");
  return `<div class="arrival-row trip-step stop-time-row">
    <strong>${escapeHtml(`${formatTripStepTime(leg.timings?.busArrivalMs, tripDateMs)} board ${routeId} at ${stopName}`)}</strong>
    ${detailText ? `<span>${escapeHtml(detailText)}</span>` : ""}
    <div class="stop-time-grid">
      ${stopTimeCell("Predicted at stop", formatTripStepTime(leg.timings?.busArrivalMs, tripDateMs))}
      ${stopTimeCell("Scheduled at stop", formatTripStepTime(leg.timings?.scheduledBusArrivalMs, tripDateMs))}
    </div>
  </div>`;
}

function tripLegs(data, arrival) {
  if (Array.isArray(data?.legs) && data.legs.length) return data.legs;
  return [{
    route: data.route,
    boardingStop: data.boardingStop,
    exitStop: data.exitStop,
    timings: {
      busArrivalMs: arrival?.predictedMs,
      scheduledBusArrivalMs: arrival?.scheduledMs,
      exitArrivalMs: data.plan?.timings?.exitArrivalMs,
      scheduledExitArrivalMs: data.plan?.timings?.scheduledExitArrivalMs || data.plan?.timings?.exitArrivalMs
    },
    walking: data.walking,
    prediction: data.plan?.prediction || null
  }];
}

function renderTripRows(data, arrival, location) {
  const placeName = location?.name || "destination";
  const rows = [];
  const legs = tripLegs(data, arrival);
  const tripDateMs = tripArrivalMs(data, arrival);

  legs.forEach((leg, index) => {
    const routeId = leg.route?.id || "";
    const transfer = data.transfers?.[index];
    const firstWalk = index === 0 && data.walking?.toBoard?.durationSeconds
      ? formatWalkSeconds(data.walking.toBoard.durationSeconds)
      : "";
    rows.push(boardingStepRow(
      leg,
      [firstWalk, leg.prediction ? "WRTA predicted stop time" : "scheduled stop time"],
      tripDateMs
    ));

    if (transfer) {
      const transferWalk = transfer.walking?.durationSeconds ? formatWalkSeconds(transfer.walking.durationSeconds) : "same stop";
      rows.push(tripStepRow(
        leg.timings?.exitArrivalMs,
        `transfer at ${displayStopLabel(transfer.toStop || transfer.fromStop || leg.exitStop)}`,
        [
          transfer.walking?.distanceMeters ? `${transferWalk}; ${formatDistance(transfer.walking.distanceMeters)}` : "same stop",
          leg.prediction ? "estimated from predicted bus" : predictionDetail(leg.timings?.exitArrivalMs, leg.timings?.scheduledExitArrivalMs, false)
        ],
        tripDateMs
      ));
    } else {
      rows.push(tripStepRow(
        leg.timings?.exitArrivalMs,
        `get off at ${displayStopLabel(leg.exitStop, "exit stop")}`,
        [
          data.walking?.fromExit?.durationSeconds ? `${formatWalkSeconds(data.walking.fromExit.durationSeconds)} to ${placeName}` : "",
          leg.prediction ? "estimated from predicted bus" : predictionDetail(leg.timings?.exitArrivalMs, leg.timings?.scheduledExitArrivalMs, false)
        ],
        tripDateMs
      ));
    }
  });
  return rows.join("");
}

function renderSelectedStop(data = null, context = {}) {
  if (!data?.stop) {
    els.selectedStopName.textContent = selectedLocationId ? "Loading stop" : "Select a location";
    els.selectedStopDetail.textContent = "--";
    els.arrivalList.innerHTML = "";
    renderTripOptions();
    return;
  }

  const stop = data.stop;
  const route = data.route;
  const location = data.location;
  const arrivalMode = data.mode || "location";
  const primaryArrival = data.arrivals?.[0] || null;
  const predictionState = (arrivalMode === "journey" || arrivalMode === "trip") ? stopTimeDetail(data, primaryArrival) : "";
  els.selectedStopName.textContent = arrivalMode === "journey" || arrivalMode === "trip"
    ? tripTitle(data, location)
    : stop.name || "Closest stop";
  if (arrivalMode === "journey") {
    els.selectedStopDetail.textContent = `${formatDistance(data.plan?.totalWalkingMeters ?? data.walking?.totalMeters)} walk total${predictionState ? `; ${predictionState}` : ""}`;
  } else if (arrivalMode === "trip") {
    els.selectedStopDetail.textContent = `${formatDistance(data.walking?.toBoard?.distanceMeters ?? stop.distanceMeters)} to stop; ${formatDistance(data.walking?.fromExit?.distanceMeters)} after bus${predictionState ? `; ${predictionState}` : ""}`;
  } else if (context.atSelectedPlace) {
    els.selectedStopDetail.textContent = `At ${location?.name || "selected place"}; nearest stop ${formatDistance(stop.distanceMeters)}`;
  } else if (!context.hasGps) {
    els.selectedStopDetail.textContent = `GPS needed for trip stop; location stop ${formatDistance(stop.distanceMeters)} from ${location?.name || "location"}`;
  } else {
    els.selectedStopDetail.textContent = `Location stop for ${location?.name || "location"}; ${formatDistance(stop.distanceMeters)} from place`;
  }
  els.arrivalList.innerHTML = (arrivalMode === "journey" || arrivalMode === "trip") && (data.arrivals || []).length
    ? renderTripRows(data, data.arrivals[0], location)
    : (data.arrivals || []).length
    ? data.arrivals.map((arrival) => {
      const placeName = location?.name || "destination";
      const busText = timePairText(arrival.predictedMs, arrival.scheduledMs, "Bus at stop predicted");
      const destinationText = arrival.destinationArrivalMs
        ? timePairText(arrival.destinationArrivalMs, arrival.scheduledDestinationArrivalMs, `Arrive ${placeName}`)
        : "";
      const routeText = `Route ${arrival.routeId} to ${arrival.destination || "destination"}`;
      const walkToText = arrival.walkToStopSeconds ? `walk to stop ${formatWalkSeconds(arrival.walkToStopSeconds)}` : "";
      const walkFromText = arrival.walkFromStopSeconds ? `from exit ${formatWalkSeconds(arrival.walkFromStopSeconds)}` : "";
      const placeText = destinationText || `Arrive ${placeName}`;
      const detailParts = [placeText, walkToText, walkFromText, routeText].filter(Boolean);
      return `<div class="arrival-row">
        <strong>${escapeHtml(busText)}</strong>
        <span>${escapeHtml(detailParts.join("; "))}</span>
      </div>`;
    }).join("")
    : `<div class="arrival-row muted"><strong>No WRTA times</strong><span>${escapeHtml(displayStopLabel(stop, ""))}</span></div>`;
  renderTripOptions();
}

function renderPlanningSelection(location) {
  selectedPlanData = { choices: [], pending: true };
  els.selectedStopName.textContent = location?.name || "Planning trip";
  els.selectedStopDetail.textContent = hasGpsLocation()
    ? "Planning WRTA trip from current location"
    : "GPS needed for route options";
  els.arrivalList.innerHTML = `<div class="arrival-row muted"><strong>Planning WRTA trip</strong><span>${escapeHtml(location?.address || "")}</span></div>`;
  renderTripOptions();
}

function showPlanningPreview(location) {
  clearSelectedLayers();
  if (location) fitCurrentAndLocation(location, 13);
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function formatMinuteTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "--";
  const date = new Date(Math.round(value / 60000) * 60000);
  if (dayKeyFormatter.format(date) === dayKeyFormatter.format(new Date())) {
    return minuteTimeFormatter.format(date);
  }
  return datedMinuteTimeFormatter.format(date);
}

function formatWalkSeconds(seconds) {
  const minutes = Math.max(1, Math.round(Number(seconds || 0) / 60));
  return `${minutes} min walk`;
}

function formatDistance(meters) {
  const value = Number(meters || 0);
  if (!Number.isFinite(value)) return "--";
  const feet = Math.round(value * 3.28084);
  if (feet < 1000) return `${feet} ft`;
  return `${(feet / 5280).toFixed(2)} mi`;
}

function sameMinute(a, b) {
  return Math.round(Number(a || 0) / 60000) === Math.round(Number(b || 0) / 60000);
}

function timePairText(predictedMs, scheduledMs, label) {
  const predicted = formatMinuteTime(predictedMs);
  const scheduled = formatMinuteTime(scheduledMs);
  if (!Number.isFinite(Number(scheduledMs))) return `${label} ${predicted}`;
  if (sameMinute(predictedMs, scheduledMs)) return `${label} ${predicted}; scheduled ${scheduled}`;
  return `${label} ${predicted}; scheduled ${scheduled}`;
}

function renderGpsButton() {
  const hasGps = currentLocation?.source === "GPS";
  els.gpsButton.textContent = hasGps ? "GPS on" : gpsStatus === "GPS needed" ? "Use GPS" : gpsStatus;
  els.gpsButton.classList.toggle("active", hasGps);
  els.gpsButton.classList.toggle("blocked", !hasGps && gpsStatus === "GPS blocked");
  if (!els.gpsHint) return;
  let hint = "";
  if (!hasGps && gpsStatus === "GPS blocked") hint = "Allow location in Chrome";
  if (!hasGps && gpsStatus === "GPS unavailable") hint = "Windows Location off";
  if (!hasGps && gpsStatus === "GPS timeout") hint = "GPS timeout";
  els.gpsHint.textContent = hint;
  els.gpsHint.hidden = !hint;
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
  markProgrammaticCameraMove();
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
    if (followed) {
      markProgrammaticCameraMove();
      map.setView([followed.lat, followed.lng], Math.max(map.getZoom(), 17), { animate: true });
    }
  }
}

function fitBounds(points, fallbackZoom = 12) {
  const validPoints = points.filter((point) => point && Number.isFinite(point.lat) && Number.isFinite(point.lng));
  if (!validPoints.length) {
    markProgrammaticCameraMove();
    map.setView([42.2623388, -71.8011645], fallbackZoom);
    return;
  }
  const bounds = L.latLngBounds(validPoints.map((point) => [point.lat, point.lng]));
  if (bounds.isValid()) {
    markProgrammaticCameraMove();
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 16 });
  }
}

function fitCurrentAndLocation(location, fallbackZoom = 13) {
  const points = [hasGpsLocation() ? currentLocation : null, location].filter(Boolean);
  fitBounds(points, fallbackZoom);
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

async function centerOnCurrentLocation() {
  followVehicleKey = "";
  renderBusList();
  await ensureCurrentLocation();
  if (!hasGpsLocation()) {
    setStatus(gpsStatus);
    return;
  }
  markProgrammaticCameraMove();
  map.setView([currentLocation.lat, currentLocation.lng], Math.max(map.getZoom(), 17), { animate: true });
  setStatus("Current location");
}

function resetRouteView() {
  followVehicleKey = "";
  renderBusList();
  if (selectedArrivalData) {
    drawSelectedData(selectedArrivalData, { preserveView: false });
    const routeText = selectedArrivalData.routeIds?.length
      ? routeSequenceText(selectedArrivalData.routeIds)
      : `Route ${selectedArrivalData.route?.id || selectedRouteId || "--"}`;
    setStatus(`${selectedArrivalData.location?.name || "Selected trip"} - ${routeText}`);
    return;
  }
  const selectedLocation = LOCATIONS.find((location) => location.id === selectedLocationId);
  if (selectedLocation) {
    fitCurrentAndLocation(selectedLocation, 13);
    setStatus(`${selectedLocation.name} - route view`);
    return;
  }
  fitAll();
  setStatus("Route view");
}

function renderCurrentLocation() {
  if (!currentLocation) {
    if (currentMarker) {
      currentMarker.remove();
      currentMarker = null;
    }
    renderGpsButton();
    return;
  }
  const latLng = [currentLocation.lat, currentLocation.lng];
  if (currentMarker) {
    currentMarker.setLatLng(latLng);
    currentMarker.setIcon(currentPhotoIcon());
    currentMarker.setZIndexOffset(2000);
    currentMarker.setTooltipContent("Current location");
    renderGpsButton();
    return;
  }
  currentMarker = L.marker(latLng, {
    icon: currentPhotoIcon(),
    zIndexOffset: 2000,
    title: "Current location"
  }).bindTooltip("Current location", {
    direction: "top",
    offset: [0, -12]
  }).addTo(map);
  renderGpsButton();
}

function gpsErrorText(error) {
  if (error?.code === 1) return "GPS blocked";
  if (error?.code === 2) return "GPS unavailable";
  if (error?.code === 3) return "GPS timeout";
  return "GPS needed";
}

function setGpsStatus(text) {
  gpsStatus = text;
  renderGpsButton();
}

function setCurrentLocationFromPosition(position) {
  if (!position?.coords) return;
  currentLocation = {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    source: "GPS"
  };
  setGpsStatus("GPS on");
  renderCurrentLocation();
  schedulePlanPrefetch();
}

async function readGpsPermissionState() {
  if (!navigator.permissions?.query) return "";
  try {
    gpsPermissionStatus = await navigator.permissions.query({ name: "geolocation" });
    return gpsPermissionStatus.state;
  } catch {
    return "";
  }
}

async function syncGpsPermissionState() {
  const state = await readGpsPermissionState();
  if (!gpsPermissionStatus) return;
  gpsPermissionStatus.onchange = () => {
    if (gpsPermissionStatus.state === "denied" && !hasGpsLocation()) setGpsStatus("GPS blocked");
    if (gpsPermissionStatus.state === "prompt" && !hasGpsLocation()) setGpsStatus("GPS needed");
  };
  if (state === "denied" && !hasGpsLocation()) setGpsStatus("GPS blocked");
  if (state === "prompt" && !hasGpsLocation()) setGpsStatus("GPS needed");
  if (state === "granted" && !hasGpsLocation()) {
    ensureCurrentLocation().then(refreshSelectedLocationView);
  }
}

function refreshSelectedLocationView() {
  if (!selectedArrivalData?.location || !selectedArrivalData?.stop) return;
  const context = {
    hasGps: hasGpsLocation(),
    atSelectedPlace: isAtSelectedPlace(selectedArrivalData.location)
  };
  renderSelectedStop(selectedArrivalData, context);
  drawSelectedData(selectedArrivalData, { preserveView: true });
}

async function refreshSelectedPlanData() {
  if (selectedPlanRefreshRunning || !selectedLocationId || !hasGpsLocation()) return;
  const location = LOCATIONS.find((item) => item.id === selectedLocationId);
  if (!location) return;
  const requestId = ++selectedPlanRefreshRequestId;
  selectedPlanRefreshRunning = true;
  try {
    const planData = await api(planRequestPath(location, selectedChoiceIndex));
    if (requestId !== selectedPlanRefreshRequestId || selectedLocationId !== location.id) return;
    const data = normalizePlanArrivals(planData, location);
    if (!data) return;
    await ensurePlanRoutesLoaded(data);
    if (requestId !== selectedPlanRefreshRequestId || selectedLocationId !== location.id) return;
    selectedPlanData = planData;
    selectedChoiceIndex = planData.selectedChoiceIndex || 0;
    selectedArrivalData = data;
    selectedRouteId = data.routeIds?.[0] || data.route?.id || "";
    updateRouteStyles();
    const context = {
      hasGps: hasGpsLocation(),
      atSelectedPlace: isAtSelectedPlace(location)
    };
    renderSelectedStop(data, context);
    drawSelectedData(data, { preserveView: true });
    if (!followVehicleKey) {
      setStatus(`${location.name} - ${data.routeIds?.length ? routeSequenceText(data.routeIds) : `Route ${selectedRouteId || "--"}`}`);
    }
  } catch {
    if (selectedArrivalData) setStatus("WRTA prediction stale");
  } finally {
    selectedPlanRefreshRunning = false;
  }
}

function startLocationWatch() {
  if (!navigator.geolocation) {
    setGpsStatus("GPS unavailable");
    return;
  }
  if (locationWatchId !== null) return;
  locationWatchId = navigator.geolocation.watchPosition((position) => {
    setCurrentLocationFromPosition(position);
    refreshSelectedPlanData();
  }, (error) => {
    setGpsStatus(gpsErrorText(error));
  }, {
    enableHighAccuracy: true,
    maximumAge: 6000,
    timeout: 16000
  });
}

async function ensureCurrentLocation() {
  if (currentLocation?.source === "GPS") return Promise.resolve(currentLocation);
  if (!navigator.geolocation) {
    setGpsStatus("GPS unavailable");
    return Promise.resolve(null);
  }
  const permissionState = await readGpsPermissionState();
  if (permissionState === "denied") {
    setGpsStatus("GPS blocked");
    return Promise.resolve(null);
  }
  if (gpsRequestPromise) return gpsRequestPromise;
  setStatus("Requesting GPS");
  setGpsStatus("Requesting GPS");
  gpsRequestPromise = new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition((position) => {
      setCurrentLocationFromPosition(position);
      startLocationWatch();
      gpsRequestPromise = null;
      resolve(currentLocation);
    }, (error) => {
      setGpsStatus(gpsErrorText(error));
      gpsRequestPromise = null;
      resolve(null);
    }, {
      enableHighAccuracy: true,
      maximumAge: 3000,
      timeout: 7000
    });
  });
  return gpsRequestPromise;
}

function hasGpsLocation() {
  return currentLocation?.source === "GPS"
    && Number.isFinite(currentLocation.lat)
    && Number.isFinite(currentLocation.lng);
}

function isAtSelectedPlace(location) {
  return hasGpsLocation() && haversineMeters(currentLocation, location) <= 90;
}

function midpoint(a, b) {
  return {
    lat: (Number(a.lat) + Number(b.lat)) / 2,
    lng: (Number(a.lng) + Number(b.lng)) / 2
  };
}

function walkingGeometryPoints(walking) {
  const geometry = Array.isArray(walking?.geometry) ? walking.geometry : [];
  return geometry
    .map((point) => Array.isArray(point)
      ? { lat: Number(point[1]), lng: Number(point[0]) }
      : { lat: Number(point?.lat), lng: Number(point?.lng) })
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng));
}

function addWalkingConnector(layers, from, to, label, walking = null) {
  if (!from || !to) return;
  const routePoints = walkingGeometryPoints(walking);
  const linePoints = routePoints.length > 1
    ? routePoints.map((point) => [point.lat, point.lng])
    : [[from.lat, from.lng], [to.lat, to.lng]];
  layers.push(L.polyline(linePoints, {
    color: "#171717",
    weight: 3,
    opacity: 0.72,
    dashArray: "5 6"
  }));
  const labelPoint = routePoints.length > 1
    ? routePoints[Math.floor(routePoints.length / 2)]
    : midpoint(from, to);
  layers.push(L.marker([labelPoint.lat, labelPoint.lng], {
    icon: walkLabelIcon(label),
    interactive: false,
    keyboard: false
  }));
}

function routeStopsAlongSegment(routeId, segment, originStop, destinationStop) {
  const stops = routeDataById.get(routeId)?.stops || [];
  const byId = new Map();
  for (const stop of [originStop, destinationStop]) {
    if (stop?.id) byId.set(stop.id, stop);
  }
  if (segment.length > 1) {
    for (const stop of stops) {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) continue;
      const nearest = nearestRoutePointIndex(segment, stop);
      if (nearest.distance <= 85) byId.set(stop.id || `${stop.lat}:${stop.lng}`, stop);
    }
  }
  return [...byId.values()].sort((a, b) => {
    if (!segment.length) return 0;
    return nearestRoutePointIndex(segment, a).index - nearestRoutePointIndex(segment, b).index;
  });
}

function drawStopMarkers(routeId, stops, originStop, destinationStop) {
  if (selectedStopLayer) selectedStopLayer.remove();
  const color = routeColor(routeId);
  const markers = [];
  const originId = originStop?.id;
  const destinationId = destinationStop?.id;
  for (const stop of stops) {
    if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) continue;
    if (stop.id === originId || stop.id === destinationId) continue;
    markers.push(L.marker([stop.lat, stop.lng], {
      icon: busStopIcon("route", "", color),
      title: stop.name || "Bus stop"
    }).bindTooltip(escapeHtml(stop.name || "Bus stop"), {
      direction: "top",
      offset: [0, -10]
    }));
  }
  if (originStop && Number.isFinite(originStop.lat) && Number.isFinite(originStop.lng)) {
    markers.push(L.marker([originStop.lat, originStop.lng], {
      icon: busStopIcon("board", "Board", color),
      title: originStop.name || "Board stop"
    }).bindTooltip(`${escapeHtml(originStop.name || "Board stop")}<br>Board stop`, {
      direction: "top",
      offset: [0, -16]
    }));
  }
  if (destinationStop && Number.isFinite(destinationStop.lat) && Number.isFinite(destinationStop.lng)) {
    markers.push(L.marker([destinationStop.lat, destinationStop.lng], {
      icon: busStopIcon("exit", "Exit", color),
      title: destinationStop.name || "Exit stop"
    }).bindTooltip(`${escapeHtml(destinationStop.name || "Exit stop")}<br>Exit stop`, {
      direction: "top",
      offset: [0, -16]
    }));
  }
  selectedStopLayer = L.layerGroup(markers).addTo(map);
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

function clearSelectedLayers() {
  if (selectedTripLayer) selectedTripLayer.remove();
  if (selectedConnectorLayer) selectedConnectorLayer.remove();
  if (selectedStopLayer) selectedStopLayer.remove();
  selectedTripLayer = null;
  selectedConnectorLayer = null;
  selectedStopLayer = null;
}

function selectedStopMarker(stop, kind, label, routeId) {
  return L.marker([stop.lat, stop.lng], {
    icon: busStopIcon(kind, label, routeColor(routeId)),
    title: stop.name || label || "Bus stop"
  }).bindTooltip(`${escapeHtml(stop.name || "Bus stop")}<br>${escapeHtml(label || "Stop")}`, {
    direction: "top",
    offset: [0, kind === "route" ? -10 : -16]
  });
}

function drawSelectedJourney(data, options = {}) {
  clearSelectedLayers();
  if (!data?.legs?.length || !data.location) return;

  const gpsLocation = hasGpsLocation() ? currentLocation : null;
  const tripLayers = [];
  const connectors = [];
  const stopMarkers = [];
  const points = [data.location, gpsLocation].filter(Boolean);
  const seenStops = new Set();

  if (gpsLocation && data.boardingStop) {
    addWalkingConnector(connectors, gpsLocation, data.boardingStop, "walk to stop", data.walking?.toBoard);
    points.push(...walkingGeometryPoints(data.walking?.toBoard));
  }

  data.legs.forEach((leg, index) => {
    const routeId = leg.route?.id;
    if (!routeId || !leg.boardingStop || !leg.exitStop) return;
    const segment = routeSegment(routeId, leg.boardingStop, leg.exitStop);
    const color = routeColor(routeId);
    if (segment.length > 1) {
      tripLayers.push(L.polyline(segment.map((point) => [point.lat, point.lng]), {
        color,
        weight: 8,
        opacity: 0.98,
        lineCap: "round",
        lineJoin: "round"
      }));
      points.push(...segment);
    }

    for (const stop of routeStopsAlongSegment(routeId, segment, leg.boardingStop, leg.exitStop)) {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) continue;
      const key = `${routeId}:${stop.id || stop.code || stop.lat}:${stop.lng}`;
      if (seenStops.has(key)) continue;
      seenStops.add(key);
      const isBoard = index === 0 && stop.id === leg.boardingStop.id;
      const isExit = index === data.legs.length - 1 && stop.id === leg.exitStop.id;
      const isTransfer = !isBoard && !isExit && (stop.id === leg.boardingStop.id || stop.id === leg.exitStop.id);
      stopMarkers.push(selectedStopMarker(
        stop,
        isBoard ? "board" : isExit ? "exit" : isTransfer ? "board" : "route",
        isBoard ? "Board" : isExit ? "Exit" : isTransfer ? "Transfer" : "",
        routeId
      ));
    }
    points.push(leg.boardingStop, leg.exitStop);
  });

  for (const transfer of data.transfers || []) {
    if (transfer.fromStop && transfer.toStop && transfer.fromStop.id !== transfer.toStop.id) {
      addWalkingConnector(connectors, transfer.fromStop, transfer.toStop, "transfer", transfer.walking);
      points.push(...walkingGeometryPoints(transfer.walking));
    }
  }
  if (data.exitStop && data.location) {
    addWalkingConnector(connectors, data.exitStop, data.location, "walk from stop", data.walking?.fromExit);
    points.push(...walkingGeometryPoints(data.walking?.fromExit));
  }

  selectedConnectorLayer = L.layerGroup(connectors).addTo(map);
  selectedTripLayer = L.layerGroup(tripLayers).addTo(map);
  selectedStopLayer = L.layerGroup(stopMarkers).addTo(map);
  if (!options.preserveView) fitBounds(points, 15);
}

function drawSelectedTrip(location, stop, routeId = selectedRouteId, options = {}) {
  clearSelectedLayers();
  if (!routeId || !location || !stop) return;

  const gpsLocation = hasGpsLocation() ? currentLocation : null;
  const atSelectedPlace = isAtSelectedPlace(location);
  const originStop = options.originStop || (gpsLocation && !atSelectedPlace ? nearestStopOnRoute(routeId, gpsLocation) : null);
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
  const points = [location, stop, gpsLocation, originStop, ...segment].filter(Boolean);
  if (gpsLocation && originStop) {
    addWalkingConnector(connectors, gpsLocation, originStop, "walk to stop", options.walking?.toBoard);
    points.push(...walkingGeometryPoints(options.walking?.toBoard));
  }
  if (atSelectedPlace) {
    addWalkingConnector(connectors, location, stop, "walk to stop");
  } else {
    addWalkingConnector(connectors, stop, location, "walk from stop", options.walking?.fromExit);
    points.push(...walkingGeometryPoints(options.walking?.fromExit));
  }
  selectedConnectorLayer = L.layerGroup(connectors).addTo(map);
  selectedTripLayer = L.layerGroup(tripLayers).addTo(map);
  const routeStops = routeStopsAlongSegment(routeId, segment, originStop, stop);
  drawStopMarkers(routeId, routeStops, originStop, stop);

  if (!options.preserveView) fitBounds(points, 15);
}

function drawSelectedData(data, options = {}) {
  if (!data?.location || !data?.route?.id) return;
  if (data.mode === "journey") {
    drawSelectedJourney(data, options);
    return;
  }
  if (data.mode === "trip") {
    drawSelectedTrip(data.location, data.exitStop, data.route.id, {
      originStop: data.boardingStop,
      walking: data.walking,
      preserveView: options.preserveView
    });
    return;
  }
  drawSelectedTrip(data.location, data.stop, data.route.id, options);
}

async function ensurePlanRoutesLoaded(data) {
  const routeIds = new Set(data?.routeIds || []);
  if (data?.route?.id && !String(data.route.id).includes("+")) routeIds.add(data.route.id);
  for (const leg of data?.legs || []) {
    if (leg.route?.id) routeIds.add(leg.route.id);
  }
  await Promise.all([...routeIds]
    .filter((routeId) => routeId && !routeDataById.has(routeId))
    .map((routeId) => fetchRouteData(routeId).catch(() => null)));
}

async function selectLocation(locationId, choiceIndex = 0) {
  const location = LOCATIONS.find((item) => item.id === locationId);
  if (!location) return;
  const requestId = ++selectedLocationRequestId;
  selectedPlanRefreshRequestId += 1;
  followVehicleKey = "";
  selectedArrivalData = null;
  selectedPlanData = null;
  selectedChoiceIndex = Number(choiceIndex) || 0;
  selectedLocationId = location.id;
  selectedRouteId = "";
  updateRouteStyles();
  renderLocations();
  renderPlanningSelection(location);
  showPlanningPreview(location);
  setStatus(`Planning ${location.name}`);

  try {
    await ensureCurrentLocation();
    if (requestId !== selectedLocationRequestId) return;
    renderPlanningSelection(location);
    showPlanningPreview(location);
    let data;
    if (hasGpsLocation()) {
      const planData = await api(planRequestPath(location, selectedChoiceIndex));
      selectedPlanData = planData;
      selectedChoiceIndex = planData.selectedChoiceIndex || 0;
      data = normalizePlanArrivals(planData, location);
    } else {
      data = await api(`/api/location-arrivals?locationId=${encodeURIComponent(location.id)}&now=${Date.now()}`);
      data.mode = "location";
    }
    if (requestId !== selectedLocationRequestId || !data) return;
    await ensurePlanRoutesLoaded(data);
    if (requestId !== selectedLocationRequestId) return;
    selectedArrivalData = data;
    selectedRouteId = data.routeIds?.[0] || data.route?.id || "";
    updateRouteStyles();
    const context = {
      hasGps: hasGpsLocation(),
      atSelectedPlace: isAtSelectedPlace(location)
    };
    renderSelectedStop(data, context);
    drawSelectedData(data, { preserveView: Boolean(followVehicleKey) });
    if (!context.hasGps) {
      setStatus(`${gpsStatus}; ${location.name} stop shown`);
    } else if (context.atSelectedPlace) {
      setStatus(`At ${location.name}; nearby stop shown`);
    } else {
      setStatus(`${location.name} - ${data.routeIds?.length ? routeSequenceText(data.routeIds) : `Route ${selectedRouteId || "--"}`}`);
    }
  } catch (error) {
    if (requestId !== selectedLocationRequestId) return;
    if (selectedStopLayer) selectedStopLayer.remove();
    const lowWalkMiss = String(error.message || "").toLowerCase().includes("no low-walk");
    const nextTripMiss = String(error.message || "").toLowerCase().includes("no next trip");
    els.selectedStopName.textContent = lowWalkMiss
      ? "No low-walk trip today"
      : nextTripMiss
        ? "No next trip"
        : "Stop unavailable";
    els.selectedStopDetail.textContent = error.message;
    els.arrivalList.innerHTML = "";
    selectedPlanData = { choices: [], error: error.message };
    renderTripOptions();
    setStatus(lowWalkMiss
      ? `${location.name} - no low-walk trip today`
      : nextTripMiss
        ? `${location.name} - no next trip`
        : "Stop unavailable");
  }
}

async function fetchRouteData(routeId) {
  if (routeDataById.has(routeId)) return routeDataById.get(routeId);
  const data = await api(`/api/route?routeId=${encodeURIComponent(routeId)}`);
  routeDataById.set(routeId, data);
  const color = data.line?.color || data.shapes?.features?.[0]?.properties?.routeColor || routeColor(routeId);
  routeColors.set(routeId, normalizeColor(color, routeColor(routeId)));
  routeState.set(routeId, {
    ...(routeState.get(routeId) || {}),
    routeId,
    name: data.line?.longName || `Route ${routeId}`,
    ok: true,
    error: ""
  });
  return data;
}

async function loadRoute(routeId) {
  const data = await fetchRouteData(routeId);
  if (routeLayers.has(routeId)) routeLayers.get(routeId).remove();
  const layer = L.geoJSON(data.shapes, {
    style: {
      color: routeColor(routeId),
      weight: 4,
      opacity: 0.74
    }
  }).addTo(map);
  routeLayers.set(routeId, layer);
  updateRouteStyles();
}

function preloadPlanningRouteData() {
  Promise.all(PLANNING_ROUTE_IDS
    .filter((routeId) => !ROUTES.includes(routeId) && !routeDataById.has(routeId))
    .map((routeId) => fetchRouteData(routeId).catch(() => null)))
    .catch(() => {});
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
  preloadPlanningRouteData();
}

async function refreshLive() {
  if (!selectedLocationId && !followVehicleKey) setStatus("Updating");
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
  if (!selectedLocationId && !followVehicleKey) setStatus(`${total} live buses`);
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
  els.optionList?.addEventListener("click", (event) => {
    const row = event.target.closest("[data-choice]");
    if (!row || !selectedLocationId) return;
    selectLocation(selectedLocationId, Number(row.dataset.choice) || 0);
  });
  els.gpsButton.addEventListener("click", async () => {
    await ensureCurrentLocation();
    refreshSelectedLocationView();
  });
}

async function boot() {
  initMap();
  bindEvents();
  renderLocations();
  renderCurrentLocation();
  renderGpsButton();
  renderBusList();
  renderSelectedStop();
  syncGpsPermissionState();
  await loadAllRoutes();
  await refreshLive();
  refreshTimer = setInterval(refreshLive, BUS_POLL_MS);
  renderTimer = setInterval(renderBuses, BUS_RENDER_MS);
  planRefreshTimer = setInterval(refreshSelectedPlanData, PLAN_REFRESH_MS);
}

window.addEventListener("beforeunload", () => {
  clearInterval(refreshTimer);
  clearInterval(renderTimer);
  clearInterval(planRefreshTimer);
  if (locationWatchId !== null && navigator.geolocation?.clearWatch) {
    navigator.geolocation.clearWatch(locationWatchId);
  }
});

boot();
