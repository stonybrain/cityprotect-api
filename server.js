// server.js — CommonJS, Node 18+ (global fetch)

// -------------------- Config (env) --------------------
const ENABLE_REVERSE_GEOCODE = (process.env.ENABLE_REVERSE_GEOCODE || "false").toLowerCase() === "true";
// how many missing-address incidents to reverse geocode per API response
const REV_MAX_PER_RESPONSE = parseInt(process.env.REV_MAX_PER_RESPONSE || "30", 10);
// delay between reverse geocode calls (ms) to respect Nominatim usage policy
const REV_RATE_MS = parseInt(process.env.REV_RATE_MS || "1200", 10);
// cache key rounding (decimal places); higher = more precise, more cache misses
const REV_CACHE_PRECISION = parseInt(process.env.REV_CACHE_PRECISION || "4", 10);
// user agent required by Nominatim policy (please customize to your site/contact)
const NOMINATIM_UA = process.env.NOMINATIM_UA || "AAXCrime/1.0 (contact: admin@example.com)";

const express = require("express");

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- CORS ---------- */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

/* ---------- Health ---------- */
app.get("/", (_, res) => res.send("ok"));
app.get("/api/test", (_, res) => res.json({ ok: true, reverseGeocode: ENABLE_REVERSE_GEOCODE }));

/* ---------- CityProtect config ---------- */
const EP = "https://ce-portal-service.commandcentral.com/api/v1.0/public/incidents";
const H = {
  "content-type": "application/json",
  accept: "application/json",
  origin: "https://www.cityprotect.com",
  referer: "https://www.cityprotect.com/",
  "user-agent": "Mozilla/5.0",
  "accept-language": "en-US,en;q=0.9"
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

const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== "");

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

/* ---------- Reverse geocoding (optional) ---------- */
// Simple in-memory cache (resets on redeploy)
const revCache = new Map(); // key: "lat,lon" (rounded), value: "address string"

/** Build a friendly short address from a Nominatim response */
function formatNominatimAddress(json) {
  // Prefer a short form like "123 Main St, Redding"
  const a = json.address || {};
  const parts = [];

  const number = a.house_number || a.building || "";
  const road = a.road || a.residential || a.pedestrian || a.cycleway || a.footway || a.path || "";
  const city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || "";
  const state = a.state || "";
  const postcode = a.postcode || "";

  const street = [number, road].filter(Boolean).join(" ").trim();
  if (street) parts.push(street);
  if (city) parts.push(city);
  // Keep it short; omit state/postcode unless nothing else
  if (!street && !city && (state || postcode)) parts.push([state, postcode].filter(Boolean).join(" "));

  const shortLine = parts.join(", ").trim();
  return shortLine || json.display_name || null;
}

async function reverseGeocode(lat, lon) {
  if (lat == null || lon == null) return null;
  const key = `${lat.toFixed(REV_CACHE_PRECISION)},${lon.toFixed(REV_CACHE_PRECISION)}`;
  if (revCache.has(key)) return revCache.get(key);

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1&accept-language=en`;
  const r = await fetch(url, {
    headers: {
      "User-Agent": NOMINATIM_UA,
      "Accept": "application/json"
    }
  });
  if (!r.ok) {
    // Cache a null to avoid hammering on failures
    revCache.set(key, null);
    return null;
  }
  const j = await r.json().catch(() => ({}));
  const addr = formatNominatimAddress(j);
  revCache.set(key, addr || null);
  return addr || null;
}

/* ---------- Core fetcher ---------- */
async function fetchRedding(hours) {
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
  const raw = j?.result?.list?.incidents ?? [];

  // Map minimal fields
  const incidents = raw.map((x) => {
    const lon = x.location?.coordinates?.[0] ?? null;
    const lat = x.location?.coordinates?.[1] ?? null;

    const datetime = pick(
      x.occurredDate, x.occurredOn, x.occurrenceDate,
      x.reportedDate, x.createdDate, x.createDate,
      x.startDate, x.eventDate, x.dateReported, x.datetime, x.timestamp
    );
    const address = pick(
      x.address, x.formattedAddress, x.locationName, x.blockAddress, x.commonPlaceName
    );
    const incidentId = pick(x.id, x.incidentId, x.reportNumber, x.caseNumber);

    const type = pick(x.incidentType, x.type, x.parentIncidentType, "Unknown");
    const parent = pick(x.parentIncidentType, x.parentCategory, x.category, type, "Unknown");
    const parentTypeId = pick(x.parentIncidentTypeId, x.categoryId, null);

    return {
      id: incidentId || null,
      type,
      parent,
      parentTypeId,
      lat, lon,
      zone: zoneFor(lat, lon),
      datetime: datetime ? new Date(datetime).toISOString() : null,
      address: address || null
    };
  });

  // Optional: fill missing addresses via reverse geocoding (throttled)
  if (ENABLE_REVERSE_GEOCODE) {
    const missing = incidents.filter(i => !i.address && i.lat != null && i.lon != null).slice(0, REV_MAX_PER_RESPONSE);
    for (let i = 0; i < missing.length; i++) {
      const it = missing[i];
      try {
        // polite rate limiting
        if (i > 0) await sleep(REV_RATE_MS);
        const addr = await reverseGeocode(it.lat, it.lon);
        if (addr) it.address = addr;
      } catch {
        // swallow and continue; address stays null
      }
    }
  }

  const categories = groupCount(incidents, (i) => i.parent);
  const zones = groupCount(incidents, (i) => i.zone);

  return {
    updated: now.toISOString(),
    hours,
    total: incidents.length,
    categories,
    zones,
    incidents
  };
}

/* ---------- /api/redding?hours=1..72 ---------- */
app.get("/api/redding", async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(72, parseInt(req.query.hours, 10) || 72));
    const data = await fetchRedding(hours);
    res.set("Cache-Control", "no-store");
    res.json(data);
  } catch (e) {
    console.error("redding error:", e);
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

/* ---------- Back-compat: /api/redding-72h ---------- */
app.get("/api/redding-72h", async (_req, res) => {
  try {
    const data = await fetchRedding(72);
    res.set("Cache-Control", "no-store");
    res.json(data);
  } catch (e) {
    console.error("redding-72h error:", e);
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

/* ---------- Optional: test a single reverse geocode ---------- */
app.get("/api/reverse", async (req, res) => {
  try {
    if (!ENABLE_REVERSE_GEOCODE) return res.status(400).json({ error: "reverse geocode disabled" });
    const lat = parseFloat(req.query.lat);
    const lon = parseFloat(req.query.lon);
    if (Number.isNaN(lat) || Number.isNaN(lon)) return res.status(400).json({ error: "lat/lon required" });
    const addr = await reverseGeocode(lat, lon);
    res.json({ lat, lon, address: addr });
  } catch (e) {
    res.status(500).json({ error: e?.message || "reverse-failed" });
  }
});

/* ---------- Start ---------- */
app.listen(PORT, () => console.log("cityprotect-api on :" + PORT));
