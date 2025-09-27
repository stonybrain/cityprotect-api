// server.js — CommonJS, Node 18+ (works on older Node via optional polyfill)

// ---------- (optional) Polyfill fetch for Node <18 ----------
if (typeof fetch === "undefined") {
  global.fetch = (...args) => import("node-fetch").then(m => m.default(...args));
}

const express = require("express");

// ---------- (optional) Response compression ----------
let compression;
try { compression = require("compression"); } catch {}

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- ENV (reverse geocode & tuning) ---------- */
const ENABLE_REVERSE_GEOCODE =
  String(process.env.ENABLE_REVERSE_GEOCODE || "").toLowerCase() === "true";
const NOMINATIM_UA =
  process.env.NOMINATIM_UA || "AAXCrime/1.0 (contact: Brad@aaxalarm.com)";

const MAX_GEOCODE_PER_REQ = Number(process.env.MAX_GEOCODE_PER_REQ || 15);
const API_CACHE_TTL_SEC   = Number(process.env.API_CACHE_TTL_SEC || 60);
const DEFAULT_LITE_LIMIT  = Number(process.env.DEFAULT_LITE_LIMIT || 200);

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

if (compression) app.use(compression());

/* ---------- Health ---------- */
app.get("/", (_, res) => res.send("ok"));
app.get("/api/test", (_, res) => res.json({ ok: true }));

/* ---------- CityProtect config ---------- */
const EP = "https://ce-portal-service.commandcentral.com/api/v1.0/public/incidents";
const H = {
  "content-type": "application/json",
  accept: "application/json",
  origin: "https://www.cityprotect.com",
  referer: "https://www.cityprotect.com/",
  "user-agent": "Mozilla/5.0",
  "accept-language": "en-US,en;q=0.9",
};

// Redding bbox + base body
const BASE = {
  limit: 2000,
  offset: 0,
  geoJson: {
    type: "Polygon",
    coordinates: [[
      [-122.20872933, 40.37101482],
      [-122.55479867, 40.37101482],
      [-122.55479867, 40.77626157],
      [-122.20872933, 40.77626157],
      [-122.20872933, 40.37101482]
    ]]
  },
  projection: true,
  propertyMap: {
    pageSize: "2000",
    zoomLevel: "11",
    latitude: "40.573945",
    longitude: "-122.381764",
    days: "1,2,3,4,5,6,7",
    startHour: "0",
    endHour: "24",
    timezone: "+00:00",
    relativeDate: "custom",
    id: "5dfab4da933cf80011f565bc",
    agencyIds: "112398,112005,ci.anderson.ca.us,cityofredding.org",
    parentIncidentTypeIds:
      "149,150,148,8,97,104,165,98,100,179,178,180,101,99,103,163,168,166,12,161,14,16,15"
  }
};

/* ---------- Helpers ---------- */
const fetchJSON = async (url, opts = {}) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  const r = await fetch(url, { ...opts, signal: controller.signal });
  clearTimeout(t);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch {
    const err = new Error(`Bad JSON from ${url} (status ${r.status}): ${text.slice(0,200)}`);
    err.status = r.status;
    throw err;
  }
};

const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== "");

// Robust date normalizer -> Date | null
function normalizeTS(v) {
  if (v == null) return null;

  // number: seconds or milliseconds
  if (typeof v === "number") {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return isNaN(d) ? null : d;
  }

  if (typeof v === "string") {
    // JSON.NET style: /Date(1695782400000)/
    const m = v.match(/Date\((\d+)\)/);
    if (m) {
      const d = new Date(parseInt(m[1], 10));
      return isNaN(d) ? null : d;
    }

    // "YYYY-MM-DD HH:mm:ss" -> assume UTC
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) {
      const d = new Date(v.replace(" ", "T") + "Z");
      return isNaN(d) ? null : d;
    }

    // "YYYY-MM-DDTHH:mm:ss(.sss)" without zone -> assume UTC
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(v)) {
      const d = new Date(v + "Z");
      return isNaN(d) ? null : d;
    }

    // Anything else, let Date try
    const d = new Date(v);
    return isNaN(d) ? null : d;
  }

  return null;
}

// zones
function zoneFor(lat, lon) {
  if (lat == null || lon == null) return "Unknown";
  if (lat >= 40.62) return "North Redding";
  if (lat <= 40.55) return "South Redding";
  if (lon <= -122.42) return "West Redding";
  if (lon >= -122.36) return "East Redding";
  return "Central Redding";
}

function groupCount(arr, keyFn) {
  const m = {};
  for (const x of arr) {
    const k = keyFn(x) || "Other";
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

/* ---------- Reverse geocode (optional) ---------- */
const geoCache = new Map();
const GEO_CACHE_MAX = 2000;

async function reverseGeocode(lat, lon) {
  if (!ENABLE_REVERSE_GEOCODE) return null;
  if (lat == null || lon == null) return null;

  const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
  if (geoCache.has(key)) return geoCache.get(key);

  const url =
    `https://nominatim.openstreetmap.org/reverse` +
    `?format=jsonv2&lat=${encodeURIComponent(lat)}` +
    `&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;

  try {
    const r = await fetch(url, {
      headers: { "User-Agent": NOMINATIM_UA, "Accept": "application/json" }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();

    const a = j.address || {};
    const parts = [
      [a.house_number, a.road].filter(Boolean).join(" ").trim(),
      a.neighbourhood || a.suburb,
      a.city || a.town || a.village
    ].filter(Boolean);
    let line = parts.join(", ") || j.display_name || null;

    if (line && line.length > 90) line = line.slice(0, 87) + "…";

    if (line) {
      if (geoCache.size > GEO_CACHE_MAX) {
        const n = Math.ceil(GEO_CACHE_MAX * 0.1);
        let i = 0;
        for (const k of geoCache.keys()) { geoCache.delete(k); if (++i >= n) break; }
      }
      geoCache.set(key, line);
    }
    return line;
  } catch {
    return null;
  }
}

/* ---------- RAW (debug 72h) ---------- */
app.get("/api/raw", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const body = { ...BASE, propertyMap: { ...BASE.propertyMap, fromDate: from.toISOString(), toDate: now.toISOString() } };
    const r = await fetch(EP, { method: "POST", headers: H, body: JSON.stringify(body) });
    const status = r.status;
    const text = await r.text();
    res.set("Cache-Control", "no-store");
    res.type("text/plain").send(`status=${status}\n\n${text.slice(0, 2000)}`);
  } catch (e) {
    res.status(500).type("text/plain").send("error: " + (e.message || e));
  }
});

/* ---------- API response cache (TTL) ---------- */
const apiCache = new Map(); // key -> { ts:number, data:object }
const nowSec = () => Math.floor(Date.now() / 1000);

function getCache(key) {
  const hit = apiCache.get(key);
  if (!hit) return null;
  if (nowSec() - hit.ts > API_CACHE_TTL_SEC) { apiCache.delete(key); return null; }
  return hit.data;
}
function setCache(key, data) {
  apiCache.set(key, { ts: nowSec(), data });
  if (apiCache.size > 200) {
    for (const [k, v] of apiCache) {
      if (nowSec() - v.ts > API_CACHE_TTL_SEC) apiCache.delete(k);
    }
  }
}

/* ---------- Core fetcher with skinny mode ---------- */
async function fetchRedding(hours, options = {}) {
  const {
    doGeocode = false,
    lite = false,
    limit = null
  } = options;

  const now = new Date();
  const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const body = {
    ...BASE,
    propertyMap: {
      ...BASE.propertyMap,
      fromDate: from.toISOString(),
      toDate: now.toISOString()
    }
  };

  const j = await fetchJSON(EP, { method: "POST", headers: H, body: JSON.stringify(body) });
  let raw = j?.result?.list?.incidents ?? [];

  let sliceN = limit && Number.isFinite(limit) ? Math.max(1, Math.min(limit, raw.length)) : raw.length;
  raw = raw.slice(0, sliceN);

  const incidents = raw.map((x) => {
    const lonRaw = x.location?.coordinates?.[0] ?? null;
    const latRaw = x.location?.coordinates?.[1] ?? null;

    const lon = lonRaw == null ? null : Number(lonRaw.toFixed(5));
    const lat = latRaw == null ? null : Number(latRaw.toFixed(5));

    // ---- WIDER set of possible date fields + normalize ----
   // ---- EVEN WIDER set of possible date fields + normalize ----
const datetimeRaw = pick(
  // occurred / occurrence
  x.occurredDate, x.occurredOn, x.occurrenceDate, x.occurrenceOn,
  // start / event
  x.startDateTime, x.startDate, x.startTime, x.eventDateTime, x.eventDate,
  // reported
  x.reportedDateTime, x.reportedDate, x.reportedOn, x.reportDate,
  x.reportedUtc, x.reportedOnUtc,
  // created / updated
  x.createdDateTime, x.createdDate, x.createDate, x.createdOn,
  x.updatedDateTime, x.updatedDate, x.lastUpdatedDate,
  // generic
  x.timestamp, x.time, x.datetime
);
// If some APIs nest under "properties" or similar, try those too
const nestedTime = pick(
  x?.properties?.occurredDate, x?.properties?.reportedDate, x?.properties?.createdDate,
  x?.details?.occurredDate, x?.details?.reportedDate
);

const dtObj = normalizeTS(datetimeRaw || nestedTime);
const datetime = dtObj ? dtObj.toISOString() : null;

    const address = pick(
      x.address, x.formattedAddress, x.locationName, x.blockAddress, x.commonPlaceName
    );

    const id    = pick(x.incidentId, x.id, x.reportNumber, x.caseNumber) || null;
    const type  = pick(x.incidentType, x.type, x.parentIncidentType, "Unknown");
    const parent= pick(x.parentIncidentType, x.parentCategory, x.category, type, "Unknown");

    const base = {
      id, type, parent,
      lat, lon,
      zone: zoneFor(lat, lon),
      datetime,                 // <-- fixed
      address: address || null
    };

    if (!lite) base.parentTypeId = pick(x.parentIncidentTypeId, x.categoryId, null);
    return base;
  });

  if (doGeocode) {
    let filled = 0;
    for (const i of incidents) {
      if (filled >= MAX_GEOCODE_PER_REQ) break;
      if (!i.address && i.lat != null && i.lon != null) {
        const addr = await reverseGeocode(i.lat, i.lon);
        if (addr) { i.address = addr; filled++; }
      }
    }
  }

  const categories = groupCount(incidents, (i) => i.parent);
  const zones      = groupCount(incidents, (i) => i.zone);

  return {
    updated: now.toISOString(),
    hours,
    total: incidents.length,
    categories,
    zones,
    incidents
  };
}

/* ---------- parse query helpers ---------- */
function parseFlags(req) {
  const hours = Math.max(1, Math.min(72, parseInt(req.query.hours, 10) || 72));

  const geoq = String(req.query.geocode || "").toLowerCase();
  const doGeocode = geoq === "1" || geoq === "true" || (ENABLE_REVERSE_GEOCODE && geoq !== "click");

  const lite = ["1","true"].includes(String(req.query.lite||"").toLowerCase());
  const limit = Number.isFinite(parseInt(req.query.limit, 10))
    ? Math.max(1, parseInt(req.query.limit, 10))
    : (lite ? DEFAULT_LITE_LIMIT : null);

  return { hours, doGeocode, lite, limit };
}

/* ---------- /api/redding ---------- */
app.get("/api/redding", async (req, res) => {
  try {
    const { hours, doGeocode, lite, limit } = parseFlags(req);

    const cacheKey = `redding:h${hours}:g${doGeocode?1:0}:l${lite?1:0}:n${limit||0}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.set("Cache-Control", `public, max-age=${API_CACHE_TTL_SEC}`);
      return res.json(cached);
    }

    const data = await fetchRedding(hours, { doGeocode, lite, limit });
    setCache(cacheKey, data);

    res.set("Cache-Control", `public, max-age=${API_CACHE_TTL_SEC}`);
    res.json(data);
  } catch (e) {
    console.error("redding error:", e);
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

/* ---------- Back-compat: /api/redding-72h ---------- */
app.get("/api/redding-72h", async (req, res) => {
  try {
    const { doGeocode, lite, limit } = parseFlags(req);
    const hours = 72;

    const cacheKey = `redding:h72:g${doGeocode?1:0}:l${lite?1:0}:n${limit||0}`;
    const cached = getCache(cacheKey);
    if (cached) {
      res.set("Cache-Control", `public, max-age=${API_CACHE_TTL_SEC}`);
      return res.json(cached);
    }

    const data = await fetchRedding(hours, { doGeocode, lite, limit });
    setCache(cacheKey, data);

    res.set("Cache-Control", `public, max-age=${API_CACHE_TTL_SEC}`);
    res.json(data);
  } catch (e) {
    console.error("redding-72h error:", e);
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

/* ---------- Start ---------- */
app.listen(PORT, () => console.log("cityprotect-api on :" + PORT));
