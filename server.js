const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

const DEFAULT_ROUTE_ID = "31";
const TIME_ZONE = "America/New_York";
const RIDE_GUIDE_DATASET = "worcester-regional-transit-authority-ma-us";
const RIDE_GUIDE_CLIENT = "rideguide";
const RIDE_GUIDE_BASE = "https://api.app.ride.guide/v1";
const WRTA_SWIV_BASE = "https://swiv.wrta.cadavl.com/SWIV/WRTA/proxy/restWS";
const OSRM_BASE = "https://router.project-osrm.org/route/v1/foot";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org/search";

const WALK_SPEED_MPS = 1.34;
const STOP_BUFFER_MS = 3 * 60 * 1000;
const BOARD_GRACE_MS = 60 * 1000;
const MAX_BOARD_CANDIDATES = 10;
const MAX_DEPARTURES_PER_STOP = 5;
const MAX_EXIT_CANDIDATES = 8;

const destinations = {
  chipotle: {
    id: "chipotle",
    name: "Chipotle",
    label: "Chipotle, Park Ave",
    address: "49 Park Ave, Worcester, MA",
    lat: 42.281927,
    lng: -71.8082589,
    defaultRouteId: "31"
  }
};

function savedDestinationByQuery(query = "") {
  const normalized = String(query || "").trim().toLowerCase();
  if (!normalized) return null;
  return Object.values(destinations).find((destination) => {
    return [destination.id, destination.name, destination.label, destination.address]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase() === normalized);
  }) || null;
}

function resolveDestination(destinationId = "chipotle", customDestination = null) {
  if (
    customDestination
    && Number.isFinite(customDestination.lat)
    && Number.isFinite(customDestination.lng)
  ) {
    return {
      id: customDestination.id || "custom",
      name: customDestination.name || customDestination.label || "Custom destination",
      label: customDestination.label || customDestination.name || "Custom destination",
      address: customDestination.address || customDestination.label || "",
      lat: customDestination.lat,
      lng: customDestination.lng,
      defaultRouteId: customDestination.defaultRouteId || ""
    };
  }
  return savedDestinationByQuery(destinationId) || destinations[destinationId] || destinations.chipotle;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

const cache = new Map();

function send(res, status, payload, headers = {}) {
  const isBuffer = Buffer.isBuffer(payload);
  const isText = typeof payload === "string" || isBuffer;
  const body = isText ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": isText ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, payload, { "Content-Type": "application/json; charset=utf-8" });
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function sourceStatus(name, ok, detail = {}) {
  return {
    name,
    ok,
    checkedAt: new Date().toISOString(),
    ...detail
  };
}

async function memo(key, ttlMs, loader) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && now - existing.savedAt < ttlMs) return existing.value;
  const value = await loader();
  cache.set(key, { savedAt: now, value });
  return value;
}

async function fetchJson(url, { headers = {}, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json,text/plain,*/*",
        "user-agent": "bus.aolabs.io personal WRTA tracker",
        ...headers
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText} for ${url}`);
    }
    if (!text.trim()) return null;
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function geocodeDestination(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) throw new Error("destination is required");

  const saved = savedDestinationByQuery(trimmed);
  if (saved) {
    return {
      ...saved,
      source: "saved destination",
      sourceOk: true
    };
  }

  const q = /worcester|massachusetts|\bma\b/i.test(trimmed)
    ? trimmed
    : `${trimmed}, Worcester, MA`;
  const data = await fetchJson(withParams(NOMINATIM_BASE, {
    format: "jsonv2",
    limit: 5,
    countrycodes: "us",
    addressdetails: 1,
    q
  }), {
    headers: {
      "accept-language": "en"
    },
    timeoutMs: 12000
  });

  const rows = Array.isArray(data) ? data : [];
  const candidate = rows.find((row) => {
    const display = String(row.display_name || "").toLowerCase();
    return display.includes("worcester") && display.includes("massachusetts");
  }) || rows[0];
  if (!candidate) throw new Error(`No destination match for ${trimmed}`);

  const lat = Number(candidate.lat);
  const lng = Number(candidate.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error(`Destination match missing coordinates for ${trimmed}`);

  return {
    id: "custom",
    name: trimmed,
    label: trimmed,
    address: candidate.display_name || trimmed,
    lat,
    lng,
    defaultRouteId: "",
    source: "Nominatim",
    sourceOk: true
  };
}

function withParams(base, params = {}) {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function rideGuideKey() {
  return memo("ride-guide-key", 12 * 60 * 60 * 1000, async () => {
    const url = withParams(`${RIDE_GUIDE_BASE}/api-keys`, {
      clientName: RIDE_GUIDE_CLIENT,
      datasetName: RIDE_GUIDE_DATASET
    });
    const keys = await fetchJson(url, { timeoutMs: 10000 });
    const key = Array.isArray(keys) ? keys[0]?.apiKeyValue : "";
    if (!key) throw new Error("Ride Guide API key unavailable");
    return key;
  });
}

async function rideGuide(pathname, params = {}, ttlMs = 10 * 60 * 1000) {
  const cacheKey = `ride:${pathname}:${JSON.stringify(params)}`;
  return memo(cacheKey, ttlMs, async () => {
    const key = await rideGuideKey();
    return fetchJson(withParams(`${RIDE_GUIDE_BASE}${pathname}`, params), {
      headers: {
        "x-api-key": key,
        "origin": "https://app.ride.guide",
        "referer": "https://app.ride.guide/"
      },
      timeoutMs: 14000
    });
  });
}

async function swiv(pathname, params = {}, ttlMs = 10 * 1000) {
  const cacheKey = `swiv:${pathname}:${JSON.stringify(params)}`;
  return memo(cacheKey, ttlMs, async () => {
    return fetchJson(withParams(`${WRTA_SWIV_BASE}${pathname}`, params), {
      timeoutMs: 12000
    });
  });
}

const localFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function dateParts(ms) {
  const parts = Object.fromEntries(localFormatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second)
  };
}

function localDateString(ms = Date.now()) {
  const p = dateParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return date.toISOString().slice(0, 10);
}

function zonedTimeToUtcMs(dateString, hour, minute = 0, second = 0) {
  const [year, month, day] = dateString.split("-").map(Number);
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = targetUtc;
  for (let index = 0; index < 4; index += 1) {
    const p = dateParts(guess);
    const renderedUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += targetUtc - renderedUtc;
  }
  return guess;
}

function timeStringToMs(serviceDate, timeString) {
  const [rawHour, minute = "0", second = "0"] = String(timeString || "00:00:00").split(":");
  const hourValue = Number(rawHour || 0);
  const dayOffset = Math.floor(hourValue / 24);
  const hour = hourValue % 24;
  return zonedTimeToUtcMs(addDays(serviceDate, dayOffset), hour, Number(minute), Number(second));
}

function secondsAfterMidnightToMs(dateString, seconds) {
  const value = Number(seconds || 0);
  const dayOffset = Math.floor(value / 86400);
  const daySeconds = value - dayOffset * 86400;
  const hour = Math.floor(daySeconds / 3600);
  const minute = Math.floor((daySeconds % 3600) / 60);
  const second = Math.floor(daySeconds % 60);
  return zonedTimeToUtcMs(addDays(dateString, dayOffset), hour, minute, second);
}

function haversineMeters(a, b) {
  const radius = 6371000;
  const lat1 = a.lat * Math.PI / 180;
  const lat2 = b.lat * Math.PI / 180;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function cleanStopId(stopId) {
  return String(stopId || "").replace(/^0_/, "");
}

function normalizeRouteId(routeId) {
  return String(routeId || DEFAULT_ROUTE_ID).trim() || DEFAULT_ROUTE_ID;
}

function optionalNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
}

function normalizeStopFeature(feature, swivStopByCode) {
  const props = feature.properties || {};
  const [lng, lat] = feature.geometry?.coordinates || [];
  const code = String(props.code || cleanStopId(props.stopId));
  const swivStop = swivStopByCode.get(code);
  return {
    id: props.stopId,
    code,
    name: props.name || `Stop ${code}`,
    lat,
    lng,
    description: props.description || "",
    swivId: swivStop?.id || null,
    swivName: swivStop?.name || ""
  };
}

async function getSwivTopo() {
  return swiv("/topo", {}, 30 * 60 * 1000);
}

async function resolveWrtaLine(routeId) {
  const normalizedRouteId = normalizeRouteId(routeId);
  const topo = await getSwivTopo();
  const lines = topo?.topo?.[0]?.ligne || [];
  const line = lines.find((item) => String(item.nomCommercial || item.mnemo || "").trim() === normalizedRouteId)
    || lines.find((item) => String(item.mnemo || "").trim() === normalizedRouteId)
    || lines.find((item) => String(item.libCommercial || "").toLowerCase().includes(normalizedRouteId.toLowerCase()));
  if (!line) throw new Error(`WRTA line ${normalizedRouteId} unavailable in SWIV topology`);
  return {
    routeId: normalizedRouteId,
    lineId: Number(line.idLigne),
    shortName: line.nomCommercial || line.mnemo || normalizedRouteId,
    longName: line.libCommercial || "",
    color: line.couleur || "#c75d32"
  };
}

async function getSwivRouteStopMap(routeId, lineId) {
  const topo = await getSwivTopo();
  const points = topo?.topo?.[0]?.pointArret || [];
  const byCode = new Map();
  for (const stop of points) {
    const routeInfo = (stop.infoLigneSwiv || []).find((info) => Number(info.idLigne) === Number(lineId));
    if (!routeInfo) continue;
    const code = String(stop.stopCode || "");
    if (!code) continue;
    byCode.set(code, {
      id: stop.idPointArret,
      code,
      name: stop.nomCommercial || "",
      lat: stop.localisation?.lat,
      lng: stop.localisation?.lng,
      pad: Boolean(routeInfo.estPad)
    });
  }
  return byCode;
}

async function getRouteData(routeId = DEFAULT_ROUTE_ID) {
  const normalizedRouteId = normalizeRouteId(routeId);
  return memo(`route-data-v2:${normalizedRouteId}`, 30 * 60 * 1000, async () => {
    const line = await resolveWrtaLine(normalizedRouteId);
    const [swivStopByCode, stopsGeo, routeStops, variants, shapes] = await Promise.all([
      getSwivRouteStopMap(normalizedRouteId, line.lineId),
      rideGuide("/map/stops", { routeId: normalizedRouteId }, 30 * 60 * 1000),
      rideGuide("/map/route-stops", { routeId: normalizedRouteId }, 30 * 60 * 1000),
      rideGuide("/map/route-trip-variants", { routeId: normalizedRouteId }, 30 * 60 * 1000),
      rideGuide("/map/route-shapes", { routeId: normalizedRouteId }, 30 * 60 * 1000)
    ]);

    const stops = (stopsGeo.features || []).map((feature) => normalizeStopFeature(feature, swivStopByCode));
    const stopById = new Map(stops.map((stop) => [stop.id, stop]));
    return {
      routeId: normalizedRouteId,
      lineId: line.lineId,
      line,
      generatedAt: new Date().toISOString(),
      destinations: Object.values(destinations),
      stops,
      routeStops,
      variants,
      shapes,
      stopById
    };
  });
}

async function getDepartures(stopId, serviceDate) {
  return rideGuide("/schedule/stops/departures", { stopId, date: serviceDate }, 2 * 60 * 1000);
}

async function getTrip(tripId) {
  return rideGuide("/schedule/trips", { tripId }, 30 * 60 * 1000);
}

async function getLiveVehicles(routeId = DEFAULT_ROUTE_ID, lineId = null) {
  const line = lineId ? { lineId } : await resolveWrtaLine(routeId);
  const checkedAt = new Date().toISOString();
  try {
    const data = await swiv("/topo/vehicules", {}, 8 * 1000);
    const vehicles = (data?.vehicule || [])
      .filter((vehicle) => Number(vehicle.conduite?.idLigne) === Number(line.lineId))
      .map((vehicle) => ({
        id: String(vehicle.id),
        equipment: String(vehicle.numeroEquipement || vehicle.id || ""),
        type: vehicle.type || "Bus",
        lat: vehicle.localisation?.lat,
        lng: vehicle.localisation?.lng,
        bearing: vehicle.localisation?.cap ?? null,
        speedMph: Number(vehicle.conduite?.vitesse || 0),
        destination: vehicle.conduite?.destination || "",
        delay: vehicle.conduite?.avanceRetard || "",
        nextStop: vehicle.conduite?.arretSuiv?.nomCommercial || "",
        nextStopMinutes: vehicle.conduite?.arretSuiv?.estimationTemps ?? null,
        load: vehicle.vehiculeLoad || "",
        displayable: Boolean(vehicle.estAffichable),
        receivedAt: checkedAt
      }));
    return {
      vehicles,
      status: sourceStatus("WRTA live vehicles", true, { count: vehicles.length })
    };
  } catch (error) {
    return {
      vehicles: [],
      status: sourceStatus("WRTA live vehicles", false, { error: error.message })
    };
  }
}

function walkFallback(from, to, error = "") {
  const directMeters = haversineMeters(from, to);
  const distance = directMeters * 1.25;
  return {
    distanceMeters: distance,
    durationSeconds: distance / WALK_SPEED_MPS,
    geometry: [[from.lng, from.lat], [to.lng, to.lat]],
    source: "straight-line fallback",
    sourceOk: false,
    error
  };
}

async function walkingRoute(from, to) {
  const key = [
    "walk",
    from.lat.toFixed(5),
    from.lng.toFixed(5),
    to.lat.toFixed(5),
    to.lng.toFixed(5)
  ].join(":");

  return memo(key, 5 * 60 * 1000, async () => {
    const url = `${OSRM_BASE}/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=geojson&steps=false`;
    try {
      const data = await fetchJson(url, { timeoutMs: 9000 });
      const route = data?.routes?.[0];
      if (!route) return walkFallback(from, to, "OSRM route missing");
      const walkingSeconds = Math.max(route.duration, route.distance / WALK_SPEED_MPS);
      return {
        distanceMeters: route.distance,
        durationSeconds: walkingSeconds,
        geometry: route.geometry?.coordinates || [[from.lng, from.lat], [to.lng, to.lat]],
        source: "OSRM path + walking pace",
        sourceOk: true
      };
    } catch (error) {
      return walkFallback(from, to, error.message);
    }
  });
}

function matchVehicle(vehicles, headsign) {
  const needle = String(headsign || "").toLowerCase();
  return vehicles.find((vehicle) => String(vehicle.destination || "").toLowerCase().includes(needle))
    || vehicles.find((vehicle) => vehicle.displayable)
    || vehicles[0]
    || null;
}

async function stopPredictions(stop, headsign, nowMs, plannedArrivalMs, lineId) {
  if (!stop?.swivId) return null;
  try {
    const data = await swiv(`/horaires/pta/${stop.swivId}`, {}, 10 * 1000);
    const line = (data?.listeHoraires || []).find((item) => Number(item.idLigne) === Number(lineId));
    if (!line) return null;
    const destinationsForLine = line.destination || [];
    const normalizedHeadsign = String(headsign || "").toLowerCase();
    const destination = destinationsForLine.find((item) => String(item.libelle || "").toLowerCase().includes(normalizedHeadsign))
      || destinationsForLine[0];
    const today = localDateString(nowMs);
    const rows = (destination?.horaires || []).map((item) => ({
      id: item.idHoraire,
      scheduledMs: secondsAfterMidnightToMs(today, item.horaire),
      applicableMs: secondsAfterMidnightToMs(today, item.horaireApplicable ?? item.horaire),
      raw: item
    }));
    if (!rows.length) return null;
    rows.sort((a, b) => Math.abs((a.applicableMs || a.scheduledMs) - plannedArrivalMs) - Math.abs((b.applicableMs || b.scheduledMs) - plannedArrivalMs));
    const best = rows[0];
    if (Math.abs((best.applicableMs || best.scheduledMs) - plannedArrivalMs) > 25 * 60 * 1000) return null;
    return {
      destination: destination?.libelle || "",
      scheduledMs: best.scheduledMs,
      predictedMs: best.applicableMs,
      source: "WRTA stop prediction"
    };
  } catch {
    return null;
  }
}

function planState(nowMs, leaveByMs, standByMs, busArrivalMs, walkSeconds) {
  const arrivalIfLeavingNow = nowMs + walkSeconds * 1000;
  if (nowMs <= leaveByMs) return "on_time";
  if (arrivalIfLeavingNow <= busArrivalMs - BOARD_GRACE_MS) return "walk_faster";
  if (arrivalIfLeavingNow > busArrivalMs - BOARD_GRACE_MS) return "miss";
  if (nowMs >= standByMs && nowMs <= busArrivalMs + BOARD_GRACE_MS) return "wait";
  return "on_time";
}

function scorePlan({ walkToBoard, walkFromExit, busArrivalMs, nowMs, status, exitStop, destination }) {
  const waitSeconds = Math.max(0, (busArrivalMs - nowMs) / 1000);
  const exitDirect = haversineMeters(exitStop, destination);
  const missPenalty = status === "miss" ? 3600 : 0;
  return walkToBoard.durationSeconds * 1.1
    + walkFromExit.durationSeconds * 0.8
    + waitSeconds * 0.28
    + exitDirect * 0.12
    + missPenalty;
}

function compactStop(stop) {
  if (!stop) return null;
  return {
    id: stop.id,
    code: stop.code,
    name: stop.name,
    lat: stop.lat,
    lng: stop.lng,
    swivId: stop.swivId
  };
}

async function createPlan(origin, destinationId = "chipotle", nowMs = Date.now(), routeId = "", customDestination = null) {
  const destination = resolveDestination(destinationId, customDestination);
  const selectedRouteId = normalizeRouteId(routeId || destination.defaultRouteId || DEFAULT_ROUTE_ID);
  const route = await getRouteData(selectedRouteId);
  const live = await getLiveVehicles(route.routeId, route.lineId);
  const sources = [
    sourceStatus(`Ride Guide route ${route.routeId} schedule`, true),
    live.status
  ];

  const stopById = route.stopById;
  const candidateStops = route.stops
    .map((stop) => ({ stop, directMeters: haversineMeters(origin, stop) }))
    .filter((item) => Number.isFinite(item.directMeters))
    .sort((a, b) => a.directMeters - b.directMeters)
    .slice(0, MAX_BOARD_CANDIDATES);

  const exitCandidates = route.stops
    .map((stop) => ({ stop, directMeters: haversineMeters(destination, stop) }))
    .sort((a, b) => a.directMeters - b.directMeters)
    .slice(0, MAX_EXIT_CANDIDATES);

  const today = localDateString(nowMs);
  const tomorrow = addDays(today, 1);
  const possiblePlans = [];

  for (const boardCandidate of candidateStops) {
    const boardStop = boardCandidate.stop;
    const walkToBoard = await walkingRoute(origin, boardStop);
    const walkSeconds = walkToBoard.durationSeconds;
    const departureDates = [today, tomorrow];
    const departures = [];
    for (const serviceDate of departureDates) {
      try {
        const rows = await getDepartures(boardStop.id, serviceDate);
        for (const row of rows || []) {
          if (row.routeId === route.routeId) departures.push(row);
        }
      } catch {
        sources.push(sourceStatus(`Ride Guide departures ${boardStop.code}`, false));
      }
    }

    const usableDepartures = departures
      .map((row) => ({ ...row, departureMs: timeStringToMs(row.serviceDate, row.departureTime) }))
      .filter((row) => row.departureMs >= nowMs - 8 * 60 * 1000)
      .sort((a, b) => a.departureMs - b.departureMs)
      .slice(0, MAX_DEPARTURES_PER_STOP);

    for (const departure of usableDepartures) {
      let trip;
      try {
        trip = await getTrip(departure.tripId);
      } catch {
        continue;
      }
      const boardTime = (trip.stopTimes || []).find((stopTime) => stopTime.id === boardStop.id);
      if (!boardTime) continue;
      const boardSequence = Number(boardTime.sequence);
      const boardArrivalMs = timeStringToMs(departure.serviceDate, boardTime.time);

      for (const exitCandidate of exitCandidates) {
        const exitStop = exitCandidate.stop;
        const exitTime = (trip.stopTimes || []).find((stopTime) => stopTime.id === exitStop.id);
        if (!exitTime || Number(exitTime.sequence) <= boardSequence) continue;
        const exitArrivalMs = timeStringToMs(departure.serviceDate, exitTime.time);
        const walkFromExit = await walkingRoute(exitStop, destination);
        const prediction = departure.serviceDate === today
          ? await stopPredictions(boardStop, trip.headsign, nowMs, boardArrivalMs, route.lineId)
          : null;
        const busArrivalMs = prediction?.predictedMs || boardArrivalMs;
        const standByMs = busArrivalMs - STOP_BUFFER_MS;
        const leaveByMs = standByMs - walkSeconds * 1000;
        const status = planState(nowMs, leaveByMs, standByMs, busArrivalMs, walkSeconds);
        const previousStopTime = (trip.stopTimes || [])
          .filter((stopTime) => Number(stopTime.sequence) < Number(exitTime.sequence))
          .sort((a, b) => Number(b.sequence) - Number(a.sequence))[0];
        const previousStop = previousStopTime ? stopById.get(previousStopTime.id) : null;
        const previousStopMs = previousStopTime ? timeStringToMs(departure.serviceDate, previousStopTime.time) : null;
        const pullCordAtMs = Math.max(previousStopMs || exitArrivalMs - 90 * 1000, exitArrivalMs - 110 * 1000);
        const stopWindow = (trip.stopTimes || [])
          .filter((stopTime) => Number(stopTime.sequence) >= boardSequence && Number(stopTime.sequence) <= Number(exitTime.sequence))
          .map((stopTime) => ({
            id: stopTime.id,
            sequence: stopTime.sequence,
            time: stopTime.time,
            timeMs: timeStringToMs(departure.serviceDate, stopTime.time),
            stop: compactStop(stopById.get(stopTime.id))
          }));

        const vehicle = matchVehicle(live.vehicles, trip.headsign);
        const plan = {
          generatedAt: new Date(nowMs).toISOString(),
          destination,
          origin,
          status,
          route: {
            id: route.routeId,
            lineId: route.lineId,
            headsign: trip.headsign,
            directionId: trip.directionId,
            shapeId: trip.shapeId,
            tripId: trip.id
          },
          boardingStop: compactStop(boardStop),
          exitStop: compactStop(exitStop),
          previousStop: compactStop(previousStop),
          timings: {
            leaveByMs,
            standByMs,
            busArrivalMs,
            scheduledBusArrivalMs: boardArrivalMs,
            exitArrivalMs,
            pullCordAtMs,
            serviceDate: departure.serviceDate
          },
          walking: {
            toBoard: walkToBoard,
            fromExit: walkFromExit
          },
          vehicle,
          stopWindow,
          stopCount: Math.max(0, Number(exitTime.sequence) - boardSequence),
          prediction,
          score: scorePlan({ walkToBoard, walkFromExit, busArrivalMs, nowMs, status, exitStop, destination })
        };
        possiblePlans.push(plan);
      }
    }
  }

  possiblePlans.sort((a, b) => a.score - b.score);
  const plan = possiblePlans[0] || null;
  const walkingOk = plan ? plan.walking.toBoard.sourceOk && plan.walking.fromExit.sourceOk : false;
  sources.push(sourceStatus("OSRM walking", walkingOk, plan ? {
    toBoardSource: plan.walking.toBoard.source,
    fromExitSource: plan.walking.fromExit.source
  } : { detail: "no plan" }));

  return {
    ok: Boolean(plan),
    plan,
    alternatives: possiblePlans.slice(1, 4).map((item) => ({
      boardingStop: item.boardingStop,
      exitStop: item.exitStop,
      timings: item.timings,
      walking: {
        toBoard: {
          distanceMeters: item.walking.toBoard.distanceMeters,
          durationSeconds: item.walking.toBoard.durationSeconds,
          source: item.walking.toBoard.source
        },
        fromExit: {
          distanceMeters: item.walking.fromExit.distanceMeters,
          durationSeconds: item.walking.fromExit.durationSeconds,
          source: item.walking.fromExit.source
        }
      },
      route: item.route,
      status: item.status
    })),
    sources,
    candidateCounts: {
      boardingStops: candidateStops.length,
      exitStops: exitCandidates.length,
      feasiblePlans: possiblePlans.length
    }
  };
}

async function handleApi(req, res, requestUrl) {
  if (requestUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      defaultRoute: DEFAULT_ROUTE_ID,
      destinations: Object.values(destinations),
      checkedAt: new Date().toISOString()
    });
    return true;
  }

  if (requestUrl.pathname === "/api/destinations") {
    sendJson(res, 200, {
      ok: true,
      destinations: Object.values(destinations)
    });
    return true;
  }

  if (requestUrl.pathname === "/api/geocode") {
    const query = requestUrl.searchParams.get("q") || requestUrl.searchParams.get("destination") || "";
    const destination = await geocodeDestination(query);
    sendJson(res, 200, {
      ok: true,
      destination,
      sources: [
        sourceStatus(destination.source || "destination geocode", true)
      ]
    });
    return true;
  }

  if (requestUrl.pathname === "/api/route") {
    const routeId = requestUrl.searchParams.get("routeId") || requestUrl.searchParams.get("route") || DEFAULT_ROUTE_ID;
    const route = await getRouteData(routeId);
    sendJson(res, 200, {
      routeId: route.routeId,
      lineId: route.lineId,
      generatedAt: route.generatedAt,
      destinations: route.destinations,
      stops: route.stops,
      routeStops: route.routeStops,
      variants: route.variants,
      shapes: route.shapes,
      sources: [
        sourceStatus(`Ride Guide route ${route.routeId} stops and geometry`, true),
        sourceStatus("WRTA SWIV stop map", true)
      ]
    });
    return true;
  }

  if (requestUrl.pathname === "/api/live") {
    const routeId = requestUrl.searchParams.get("routeId") || requestUrl.searchParams.get("route") || DEFAULT_ROUTE_ID;
    const live = await getLiveVehicles(routeId);
    sendJson(res, live.status.ok ? 200 : 502, live);
    return true;
  }

  if (requestUrl.pathname === "/api/plan") {
    const lat = Number(requestUrl.searchParams.get("lat"));
    const lng = Number(requestUrl.searchParams.get("lng"));
    const destinationId = requestUrl.searchParams.get("destination") || requestUrl.searchParams.get("destinationId") || "chipotle";
    const destinationLat = optionalNumber(requestUrl.searchParams.get("destinationLat") || requestUrl.searchParams.get("destLat"));
    const destinationLng = optionalNumber(requestUrl.searchParams.get("destinationLng") || requestUrl.searchParams.get("destLng"));
    const customDestination = Number.isFinite(destinationLat) && Number.isFinite(destinationLng)
      ? {
          id: requestUrl.searchParams.get("destinationId") || "custom",
          name: requestUrl.searchParams.get("destinationName") || requestUrl.searchParams.get("destName") || "Custom destination",
          label: requestUrl.searchParams.get("destinationLabel") || requestUrl.searchParams.get("destName") || requestUrl.searchParams.get("destinationName") || "Custom destination",
          address: requestUrl.searchParams.get("destinationAddress") || "",
          lat: destinationLat,
          lng: destinationLng
        }
      : null;
    const routeId = requestUrl.searchParams.get("routeId") || requestUrl.searchParams.get("route") || "";
    const now = Number(requestUrl.searchParams.get("now") || Date.now());
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      sendJson(res, 400, { ok: false, error: "lat and lng are required" });
      return true;
    }
    const result = await createPlan({ lat, lng }, destinationId, Number.isFinite(now) ? now : Date.now(), routeId, customDestination);
    sendJson(res, result.ok ? 200 : 404, result);
    return true;
  }

  if (requestUrl.pathname === "/api/walk") {
    const from = String(requestUrl.searchParams.get("from") || "").split(",").map(Number);
    const to = String(requestUrl.searchParams.get("to") || "").split(",").map(Number);
    if (from.length !== 2 || to.length !== 2 || from.some(Number.isNaN) || to.some(Number.isNaN)) {
      sendJson(res, 400, { ok: false, error: "from and to must be lat,lng" });
      return true;
    }
    const route = await walkingRoute({ lat: from[0], lng: from[1] }, { lat: to[0], lng: to[1] });
    sendJson(res, 200, { ok: true, route });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  try {
    if (requestUrl.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, requestUrl);
      if (!handled) sendJson(res, 404, { ok: false, error: "Unknown endpoint" });
      return;
    }

    let pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === "/") pathname = "/index.html";
    const normalizedPath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(publicDir, normalizedPath);
    if (!filePath.startsWith(publicDir)) {
      send(res, 403, "Forbidden");
      return;
    }
    sendFile(res, filePath);
  } catch (error) {
    sendJson(res, 500, {
      ok: false,
      error: error.message,
      checkedAt: new Date().toISOString()
    });
  }
});

server.listen(port, () => {
  console.log(`AO Labs bus tracker running at http://localhost:${port}`);
});
