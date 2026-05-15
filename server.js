const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.env.PORT || 3000);
const publicDir = path.join(__dirname, "public");

const DEFAULT_ROUTE_ID = "31";
const TRACKED_ROUTE_IDS = ["2", "4", "3", "31"];
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
const MAX_DEPARTURES_PER_STOP = 10;
const MAX_EXIT_CANDIDATES = 8;
const MAX_AUTO_ROUTE_CANDIDATES = 4;
const MAX_AUTO_BOARD_CANDIDATES = 4;
const MAX_AUTO_EXIT_CANDIDATES = 4;
const MAX_AUTO_DEPARTURES_PER_STOP = 5;

const destinations = {
  william: {
    id: "william",
    name: "96 William St",
    label: "96 William Street",
    address: "96 William Street, Worcester, MA",
    lat: 42.2682067,
    lng: -71.8141609,
    defaultRouteId: "31"
  },
  alden: {
    id: "alden",
    name: "Alden Hall",
    label: "Alden Hall",
    address: "100 Institute Road, Worcester, MA",
    lat: 42.2743150,
    lng: -71.8084567,
    defaultRouteId: "31"
  },
  union: {
    id: "union",
    name: "Union Station",
    label: "Union Station",
    address: "2 Washington Square, Worcester, MA",
    lat: 42.2613806,
    lng: -71.7952265,
    defaultRouteId: "3"
  },
  chipotle: {
    id: "chipotle",
    name: "Chipotle",
    label: "Chipotle, Park Ave",
    address: "49 Park Ave, Worcester, MA",
    lat: 42.281927,
    lng: -71.8082589,
    defaultRouteId: "31"
  },
  coldstone: {
    id: "coldstone",
    name: "Cold Stone",
    label: "Cold Stone",
    address: "531 Main Street, Suite #103, Worcester, MA",
    lat: 42.2618181,
    lng: -71.8028624,
    defaultRouteId: "3"
  },
  blackstone: {
    id: "blackstone",
    name: "Blackstone Theaters",
    label: "Blackstone Theaters",
    address: "70 Worcester-Providence Turnpike, Millbury, MA",
    lat: 42.1967955,
    lng: -71.7776713,
    defaultRouteId: "4"
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

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { ok: true, value: await mapper(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

function destinationLabelFromNominatim(row, fallback) {
  const address = row.address || {};
  return address.amenity
    || address.building
    || address.office
    || address.shop
    || address.tourism
    || address.leisure
    || address.road
    || String(row.name || "").trim()
    || fallback;
}

async function suggestDestinations(query) {
  const trimmed = String(query || "").trim();
  if (trimmed.length < 2) return [];

  const saved = Object.values(destinations)
    .filter((destination) => {
      const haystack = [destination.id, destination.name, destination.label, destination.address].join(" ").toLowerCase();
      return haystack.includes(trimmed.toLowerCase());
    })
    .map((destination) => ({
      ...destination,
      source: "saved destination",
      sourceOk: true
    }));

  const q = /worcester|massachusetts|\bma\b/i.test(trimmed)
    ? trimmed
    : `${trimmed}, Worcester, MA`;
  const rows = await fetchJson(withParams(NOMINATIM_BASE, {
    format: "jsonv2",
    limit: 8,
    countrycodes: "us",
    addressdetails: 1,
    namedetails: 1,
    q
  }), {
    headers: {
      "accept-language": "en"
    },
    timeoutMs: 9000
  });

  const suggestions = [...saved];
  const seen = new Set(suggestions.map((item) => `${item.lat}:${item.lng}:${item.label}`));
  for (const row of Array.isArray(rows) ? rows : []) {
    const display = String(row.display_name || "");
    const inWorcester = display.toLowerCase().includes("worcester") && display.toLowerCase().includes("massachusetts");
    if (!inWorcester) continue;
    const lat = Number(row.lat);
    const lng = Number(row.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const label = destinationLabelFromNominatim(row, trimmed);
    const key = `${lat.toFixed(6)}:${lng.toFixed(6)}:${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push({
      id: `suggestion-${suggestions.length}`,
      name: label,
      label,
      address: display,
      lat,
      lng,
      defaultRouteId: "",
      source: "Nominatim",
      sourceOk: true
    });
  }

  return suggestions.slice(0, 8);
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

async function getWrtaRouteLines() {
  return memo("wrta-route-lines-v1", 30 * 60 * 1000, async () => {
    const topo = await getSwivTopo();
    const lines = topo?.topo?.[0]?.ligne || [];
    const byRouteId = new Map();
    for (const line of lines) {
      const routeId = String(line.nomCommercial || line.mnemo || "").trim();
      const lineId = Number(line.idLigne);
      if (!routeId || !Number.isFinite(lineId)) continue;
      if (!byRouteId.has(routeId)) {
        byRouteId.set(routeId, {
          routeId,
          lineId,
          shortName: line.nomCommercial || line.mnemo || routeId,
          longName: line.libCommercial || "",
          color: line.couleur || "#c75d32"
        });
      }
    }
    return [...byRouteId.values()];
  });
}

async function resolveWrtaLine(routeId) {
  const normalizedRouteId = normalizeRouteId(routeId);
  const lines = await getWrtaRouteLines();
  const line = lines.find((item) => String(item.nomCommercial || item.mnemo || "").trim() === normalizedRouteId)
    || lines.find((item) => String(item.routeId || "").trim() === normalizedRouteId)
    || lines.find((item) => String(item.shortName || "").trim() === normalizedRouteId)
    || lines.find((item) => String(item.longName || "").toLowerCase().includes(normalizedRouteId.toLowerCase()));
  if (!line) throw new Error(`WRTA line ${normalizedRouteId} unavailable in SWIV topology`);
  return {
    routeId: normalizedRouteId,
    lineId: Number(line.lineId),
    shortName: line.shortName || normalizedRouteId,
    longName: line.longName || "",
    color: line.color || "#c75d32"
  };
}

async function autoRoutePreviews(origin, destination) {
  const [topo, lines] = await Promise.all([getSwivTopo(), getWrtaRouteLines()]);
  const lineById = new Map(lines.map((line) => [Number(line.lineId), line]));
  const previews = new Map();
  const stops = topo?.topo?.[0]?.pointArret || [];

  for (const stop of stops) {
    const lat = Number(stop.localisation?.lat);
    const lng = Number(stop.localisation?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const point = { lat, lng };
    const boardMeters = haversineMeters(origin, point);
    const exitMeters = haversineMeters(destination, point);

    for (const info of stop.infoLigneSwiv || []) {
      const line = lineById.get(Number(info.idLigne));
      if (!line) continue;
      const existing = previews.get(line.routeId) || {
        routeId: line.routeId,
        lineId: line.lineId,
        longName: line.longName,
        nearestBoardMeters: Infinity,
        nearestExitMeters: Infinity
      };
      existing.nearestBoardMeters = Math.min(existing.nearestBoardMeters, boardMeters);
      existing.nearestExitMeters = Math.min(existing.nearestExitMeters, exitMeters);
      previews.set(line.routeId, existing);
    }
  }

  return [...previews.values()]
    .filter((preview) => Number.isFinite(preview.nearestBoardMeters) && Number.isFinite(preview.nearestExitMeters))
    .map((preview) => ({
      ...preview,
      directWalkMeters: preview.nearestBoardMeters + preview.nearestExitMeters
    }))
    .sort((a, b) => a.directWalkMeters - b.directWalkMeters);
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
    const data = await swiv("/topo/vehicules", {}, 1000);
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

function formatMinutesFromNow(ms, nowMs) {
  const minutes = Math.round((Number(ms) - Number(nowMs)) / 60000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes <= 0) return "due";
  if (minutes === 1) return "1 min";
  return `${minutes} min`;
}

async function stopArrivals(stop, routeEntries, nowMs = Date.now()) {
  if (!stop?.swivId) return [];
  const byLineId = new Map(routeEntries.map((entry) => [Number(entry.route.lineId), entry.route]));
  try {
    const data = await swiv(`/horaires/pta/${stop.swivId}`, {}, 10 * 1000);
    const today = localDateString(nowMs);
    const rows = [];
    for (const line of data?.listeHoraires || []) {
      const route = byLineId.get(Number(line.idLigne));
      if (!route) continue;
      for (const destination of line.destination || []) {
        for (const item of destination.horaires || []) {
          const scheduledMs = secondsAfterMidnightToMs(today, item.horaire);
          const predictedMs = secondsAfterMidnightToMs(today, item.horaireApplicable ?? item.horaire);
          if (predictedMs < nowMs - 2 * 60 * 1000) continue;
          rows.push({
            id: item.idHoraire,
            routeId: route.routeId,
            routeName: route.line?.longName || route.line?.shortName || `Route ${route.routeId}`,
            destination: destination.libelle || "",
            scheduledMs,
            predictedMs,
            minutes: formatMinutesFromNow(predictedMs, nowMs),
            source: "WRTA stop times"
          });
        }
      }
    }
    return rows
      .sort((a, b) => a.predictedMs - b.predictedMs)
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function closestTrackedStop(point, routeIds = TRACKED_ROUTE_IDS, nowMs = Date.now()) {
  const routes = await Promise.all(routeIds.map((routeId) => getRouteData(routeId)));
  let best = null;
  for (const route of routes) {
    for (const stop of route.stops || []) {
      if (!Number.isFinite(stop.lat) || !Number.isFinite(stop.lng)) continue;
      const distanceMeters = haversineMeters(point, stop);
      if (!best || distanceMeters < best.distanceMeters) {
        best = {
          route,
          stop,
          distanceMeters
        };
      }
    }
  }
  if (!best) return null;
  const arrivals = await stopArrivals(best.stop, routes.map((route) => ({ route })), nowMs);
  return {
    route: {
      id: best.route.routeId,
      lineId: best.route.lineId,
      name: best.route.line?.longName || best.route.line?.shortName || `Route ${best.route.routeId}`,
      color: best.route.line?.color || ""
    },
    stop: {
      ...compactStop(best.stop),
      distanceMeters: best.distanceMeters
    },
    arrivals
  };
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

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function choiceSummary(plan, index) {
  return {
    index,
    route: plan.route,
    boardingStop: plan.boardingStop,
    exitStop: plan.exitStop,
    timings: plan.timings,
    walking: {
      toBoard: {
        distanceMeters: plan.walking.toBoard.distanceMeters,
        durationSeconds: plan.walking.toBoard.durationSeconds,
        source: plan.walking.toBoard.source
      },
      fromExit: {
        distanceMeters: plan.walking.fromExit.distanceMeters,
        durationSeconds: plan.walking.fromExit.durationSeconds,
        source: plan.walking.fromExit.source
      }
    },
    status: plan.status
  };
}

function tripChoices(plans) {
  const bestByTrip = new Map();
  for (const plan of plans) {
    const key = `${plan.timings.serviceDate}:${plan.route.tripId}`;
    const existing = bestByTrip.get(key);
    if (!existing || plan.score < existing.score) bestByTrip.set(key, plan);
  }
  return [...bestByTrip.values()].sort((a, b) => {
    return a.timings.exitArrivalMs - b.timings.exitArrivalMs
      || a.timings.busArrivalMs - b.timings.busArrivalMs
      || a.score - b.score;
  });
}

function totalWalkingMeters(plan) {
  return Number(plan?.walking?.toBoard?.distanceMeters || 0)
    + Number(plan?.walking?.fromExit?.distanceMeters || 0);
}

function journeyOptionKey(plan) {
  return [
    plan.route.id,
    plan.route.directionId,
    plan.route.headsign,
    plan.boardingStop.id,
    plan.exitStop.id
  ].join("|");
}

function leastWalkingTripChoices(plans) {
  const available = plans.filter((plan) => plan.status !== "miss");
  const pool = available.length ? available : plans;
  const groups = new Map();
  for (const plan of pool) {
    const key = journeyOptionKey(plan);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(plan);
  }

  const ranked = [...groups.values()]
    .map((group) => {
      const choices = tripChoices(group);
      const first = choices.find((plan) => plan.status !== "miss") || choices[0] || group[0];
      return {
        choices,
        walkingMeters: totalWalkingMeters(first),
        firstArrivalMs: first?.timings?.busArrivalMs || Infinity,
        score: first?.score || Infinity
      };
    })
    .filter((item) => item.choices.length)
    .sort((a, b) => {
      return a.walkingMeters - b.walkingMeters
        || a.firstArrivalMs - b.firstArrivalMs
        || a.score - b.score;
    });

  return ranked[0]?.choices || [];
}

function selectedChoiceIndex(choices, choiceOffset = 0, targetArrivalMs = NaN) {
  if (!choices.length) return -1;
  let base = 0;
  if (Number.isFinite(targetArrivalMs)) {
    const targetIndex = choices.findIndex((plan) => plan.timings.exitArrivalMs >= targetArrivalMs);
    base = targetIndex >= 0 ? targetIndex : choices.length - 1;
  }
  return clamp(base + Math.trunc(Number(choiceOffset) || 0), 0, choices.length - 1);
}

async function routeCandidatesForPlan(origin, destination, routeId) {
  const explicitRouteId = String(routeId || "").trim();
  if (explicitRouteId) {
    const route = await getRouteData(explicitRouteId);
    return {
      auto: false,
      previews: [{ routeId: route.routeId, directWalkMeters: null }],
      routes: [{ route, preview: null }]
    };
  }

  const previews = await autoRoutePreviews(origin, destination);
  const routeResults = await mapLimit(
    previews.slice(0, MAX_AUTO_ROUTE_CANDIDATES),
    4,
    async (preview) => ({
      preview,
      route: await getRouteData(preview.routeId)
    })
  );

  return {
    auto: true,
    previews,
    routes: routeResults
      .filter((result) => result.ok && result.value?.route)
      .map((result) => result.value)
  };
}

async function createPlan(origin, destinationId = "chipotle", nowMs = Date.now(), routeId = "", customDestination = null, options = {}) {
  const destination = resolveDestination(destinationId, customDestination);
  const routeSelection = await routeCandidatesForPlan(origin, destination, routeId);
  const sources = [
    sourceStatus("WRTA route selection", routeSelection.routes.length > 0, {
      mode: routeSelection.auto ? "least walking" : "fixed route",
      routesChecked: routeSelection.auto ? routeSelection.previews.length : routeSelection.routes.length,
      routeCandidates: routeSelection.routes.map((item) => item.route.routeId)
    })
  ];

  const today = localDateString(nowMs);
  const tomorrow = addDays(today, 1);
  const possiblePlans = [];
  let boardCandidateCount = 0;
  let exitCandidateCount = 0;
  const boardLimit = routeSelection.auto ? MAX_AUTO_BOARD_CANDIDATES : MAX_BOARD_CANDIDATES;
  const exitLimit = routeSelection.auto ? MAX_AUTO_EXIT_CANDIDATES : MAX_EXIT_CANDIDATES;
  const departureLimit = routeSelection.auto ? MAX_AUTO_DEPARTURES_PER_STOP : MAX_DEPARTURES_PER_STOP;

  for (const { route } of routeSelection.routes) {
    const stopById = route.stopById;
    const candidateStops = route.stops
      .map((stop) => ({ stop, directMeters: haversineMeters(origin, stop) }))
      .filter((item) => Number.isFinite(item.directMeters))
      .sort((a, b) => a.directMeters - b.directMeters)
      .slice(0, boardLimit);

    const exitCandidates = route.stops
      .map((stop) => ({ stop, directMeters: haversineMeters(destination, stop) }))
      .filter((item) => Number.isFinite(item.directMeters))
      .sort((a, b) => a.directMeters - b.directMeters)
      .slice(0, exitLimit);

    boardCandidateCount += candidateStops.length;
    exitCandidateCount += exitCandidates.length;

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
        .slice(0, departureLimit);

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
          const earliestPullMs = busArrivalMs + 90 * 1000;
          const latestPullMs = exitArrivalMs - 2 * 60 * 1000;
          const scheduledPullMs = previousStopMs && exitArrivalMs - previousStopMs >= 90 * 1000
            ? previousStopMs + 20 * 1000
            : exitArrivalMs - 3 * 60 * 1000;
          const pullCordAtMs = clamp(
            scheduledPullMs,
            Math.min(earliestPullMs, latestPullMs),
            Math.max(earliestPullMs, latestPullMs)
          );
          const stopWindow = (trip.stopTimes || [])
            .filter((stopTime) => Number(stopTime.sequence) >= boardSequence && Number(stopTime.sequence) <= Number(exitTime.sequence))
            .map((stopTime) => ({
              id: stopTime.id,
              sequence: stopTime.sequence,
              time: stopTime.time,
              timeMs: timeStringToMs(departure.serviceDate, stopTime.time),
              stop: compactStop(stopById.get(stopTime.id))
            }));

          possiblePlans.push({
            generatedAt: new Date(nowMs).toISOString(),
            destination,
            origin,
            status,
            route: {
              id: route.routeId,
              lineId: route.lineId,
              name: route.line?.longName || route.line?.shortName || `Route ${route.routeId}`,
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
            vehicle: null,
            stopWindow,
            stopCount: Math.max(0, Number(exitTime.sequence) - boardSequence),
            prediction,
            score: scorePlan({ walkToBoard, walkFromExit, busArrivalMs, nowMs, status, exitStop, destination })
          });
        }
      }
    }

    if (routeSelection.auto && possiblePlans.some((plan) => plan.status !== "miss")) {
      break;
    }
  }

  possiblePlans.sort((a, b) => a.score - b.score);
  const choices = routeSelection.auto ? leastWalkingTripChoices(possiblePlans) : tripChoices(possiblePlans);
  const planIndex = selectedChoiceIndex(choices, options.choiceOffset, options.targetArrivalMs);
  const plan = planIndex >= 0 ? choices[planIndex] : null;

  if (plan) {
    sources.push(sourceStatus(`Ride Guide route ${plan.route.id} schedule`, true));
    const live = await getLiveVehicles(plan.route.id, plan.route.lineId);
    plan.vehicle = matchVehicle(live.vehicles, plan.route.headsign);
    sources.push(live.status);
  } else {
    sources.push(sourceStatus("Ride Guide candidate schedules", false, { detail: "no feasible plan" }));
  }

  const walkingOk = plan ? plan.walking.toBoard.sourceOk && plan.walking.fromExit.sourceOk : false;
  sources.push(sourceStatus("OSRM walking", walkingOk, plan ? {
    toBoardSource: plan.walking.toBoard.source,
    fromExitSource: plan.walking.fromExit.source,
    totalWalkingMeters: Math.round(totalWalkingMeters(plan))
  } : { detail: "no plan" }));

  return {
    ok: Boolean(plan),
    plan,
    selectedChoiceIndex: planIndex,
    choiceCount: choices.length,
    choices: choices.map((item, index) => choiceSummary(item, index)),
    alternatives: choices
      .map((item, index) => choiceSummary(item, index))
      .filter((item) => item.index !== planIndex)
      .slice(0, 4),
    sources,
    routeSelection: {
      mode: routeSelection.auto ? "least_walking" : "fixed",
      selectedRouteId: plan?.route?.id || null,
      candidates: routeSelection.routes.map((item) => ({
        routeId: item.route.routeId,
        directWalkMeters: item.preview ? Math.round(item.preview.directWalkMeters) : null
      }))
    },
    candidateCounts: {
      routesChecked: routeSelection.auto ? routeSelection.previews.length : routeSelection.routes.length,
      routeCandidates: routeSelection.routes.length,
      boardingStops: boardCandidateCount,
      exitStops: exitCandidateCount,
      feasiblePlans: possiblePlans.length
    }
  };
}

async function handleApi(req, res, requestUrl) {
  if (requestUrl.pathname === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      defaultRoute: DEFAULT_ROUTE_ID,
      trackedRoutes: TRACKED_ROUTE_IDS,
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

  if (requestUrl.pathname === "/api/suggestions") {
    const query = requestUrl.searchParams.get("q") || requestUrl.searchParams.get("destination") || "";
    const suggestions = await suggestDestinations(query);
    sendJson(res, 200, {
      ok: true,
      query,
      suggestions,
      sources: [
        sourceStatus("destination suggestions", true, { count: suggestions.length })
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
      line: route.line,
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

  if (requestUrl.pathname === "/api/location-arrivals") {
    const locationId = requestUrl.searchParams.get("locationId") || requestUrl.searchParams.get("location") || "";
    const lat = optionalNumber(requestUrl.searchParams.get("lat"));
    const lng = optionalNumber(requestUrl.searchParams.get("lng"));
    const destination = savedDestinationByQuery(locationId)
      || (Number.isFinite(lat) && Number.isFinite(lng)
        ? {
            id: locationId || "custom",
            name: requestUrl.searchParams.get("name") || "Selected location",
            label: requestUrl.searchParams.get("name") || "Selected location",
            address: "",
            lat,
            lng
          }
        : null);
    if (!destination || !Number.isFinite(destination.lat) || !Number.isFinite(destination.lng)) {
      sendJson(res, 400, { ok: false, error: "locationId or lat,lng is required" });
      return true;
    }
    const now = Number(requestUrl.searchParams.get("now") || Date.now());
    const result = await closestTrackedStop(
      { lat: destination.lat, lng: destination.lng },
      TRACKED_ROUTE_IDS,
      Number.isFinite(now) ? now : Date.now()
    );
    sendJson(res, result ? 200 : 404, {
      ok: Boolean(result),
      location: destination,
      ...result,
      sources: [
        sourceStatus("WRTA nearest tracked stop", Boolean(result)),
        sourceStatus("WRTA stop times", Boolean(result?.arrivals?.length), { count: result?.arrivals?.length || 0 })
      ]
    });
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
    const choiceOffset = Number(requestUrl.searchParams.get("choice") || 0);
    const targetArrivalMs = Number(requestUrl.searchParams.get("targetArrivalMs") || NaN);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      sendJson(res, 400, { ok: false, error: "lat and lng are required" });
      return true;
    }
    const result = await createPlan(
      { lat, lng },
      destinationId,
      Number.isFinite(now) ? now : Date.now(),
      routeId,
      customDestination,
      {
        choiceOffset: Number.isFinite(choiceOffset) ? choiceOffset : 0,
        targetArrivalMs: Number.isFinite(targetArrivalMs) ? targetArrivalMs : NaN
      }
    );
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
