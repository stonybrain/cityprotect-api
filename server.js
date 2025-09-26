// server.js
import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- Feature flags ---------- */
const ENABLE_REVERSE_GEOCODE =
  (process.env.ENABLE_REVERSE_GEOCODE || "false").toLowerCase() === "true";

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
app.get("/api/test", (_, res) => res.json({ ok: true }));

/* ---------- CityProtect config ---------- */
const EP =
  "https://ce-portal-service.commandcentral.com/api/v1.0/public/incidents";
const H = {
  "content-type": "application/json",
  accept: "application/json",
  origin: "https://www.cityprotect.com",
  referer: "https://www.cityprotect.com/",
  "user-agent": "Mozilla/5.0",
  "accept-language": "en-US,en;q=0.9",
};

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
      [-122.20872933, 40.37101482],
    ]],
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
      "149,150,148,8,97,104,165,98,100,179,178,180,101,99,103,163,168,166,12,161,14,16,15",
  },
};

/* ---------- Helpers ---------- */
const fetchJSON = async (url, opts = {}) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  const r = await fetch(url, { ...opts, signal: controller.signal });
  clearTimeout(t);
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(
      `Bad JSON from ${url} (status ${r.status}): ${text.slice(0, 200)}`
    );
    err.status = r.status;
    throw err;
  }
};

// Simple zone bucketing for Redding
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

// Try to pull a datetime from typical fields if CityProtect ever includes them
function extractDateISO(x) {
  const candidates = [
    x.datetime,
    x.dateTime,
    x.incidentDate,
    x.occurrenceDate,
    x.reportedDate,
    x.eventTime,
    x.createdTime,
    x.created_at,
    x.updated,
    x.lastUpdated,
  ];
  for (const v of candidates) {
    if (!v) continue;
    const d = new Date(v);
    if (!isNaN(d)) return d.toISOString();
  }
  return null;
}

// Decode Mongo ObjectId -> ISO (first 4 bytes are Unix epoch seconds)
function objectIdToISO(id) {
  if (!id || typeof id !== "string" || id.length < 8) return null;
  const seconds = parseInt(id.slice(0, 8), 16);
  if (Number.isNaN(seconds)) return null;
  return new Date(seconds * 1000).toISOString();
}

// Tiny in-memory cache for reverse geocoding
const RG_CACHE = new Map();
async function reverseGeocode(lat, lon) {
  if (!ENABLE_REVERSE_GEOCODE) return null;
  if (lat == null || lon == null) return null;

  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`; // cluster nearby points
  if (RG_CACHE.has(key)) return RG_CACHE.get(key);

  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
    lat
  )}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;

  const r = await fetch(url, {
    headers: { "User-Agent": "AAX-Crime/1.0 (contact: admin@aaxalarm.example)" },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  if (!j) return null;

  const a = j.address || {};
  const line =
    [
      a.house_number && a.road ? `${a.house_number} ${a.road}` : a.road || null,
      a.city || a.town || a.village || a.hamlet || a.county || null,
      [a.state, a.postcode].filter(Boolean).join(" ") || null,
    ]
      .filter(Boolean)
      .join(", ") || j.display_name || null;

  RG_CACHE.set(key, line);
  return line;
}

/* ---------- RAW (debug 72h) ---------- */
app.get("/api/raw", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 72 * 60 * 60 * 1000);
    const body = {
      ...BASE,
      propertyMap: {
        ...BASE.propertyMap,
        fromDate: from.toISOString(),
        toDate: now.toISOString(),
      },
    };
    const r = await fetch(EP, { method: "POST", headers: H, body: JSON.stringify(body) });
    const status = r.status;
    const text = await r.text();
    res.set("Cache-Control", "no-store");
    res.type("text/plain").send(`status=${status}\n\n${text.slice(0, 2000)}`);
  } catch (e) {
    res.status(500).type("text/plain").send("error: " + (e.message || e));
  }
});

/* ---------- Flexible window: /api/redding?hours=N ---------- */
app.get("/api/redding", async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours, 10) || 72));
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const body = {
      ...BASE,
      propertyMap: {
        ...BASE.propertyMap,
        fromDate: from.toISOString(),
        toDate: now.toISOString(),
      },
    };

    const j = await fetchJSON(EP, {
      method: "POST",
      headers: H,
      body: JSON.stringify(body),
    });
    const raw = j?.result?.list?.incidents ?? [];

    // Map + augment fields
    const incidents = await Promise.all(
      raw.map(async (x) => {
        const lon = x.location?.coordinates?.[0] ?? null;
        const lat = x.location?.coordinates?.[1] ?? null;

        const id =
          x.id ??
          x.incidentId ??
          x.reportNumber ??
          x.caseNumber ??
          null;

        const type =
          x.incidentType ??
          x.type ??
          x.parentIncidentType ??
          "Unknown";

        const parent =
          x.parentIncidentType ??
          x.parentCategory ??
          x.category ??
          type ??
          "Unknown";

        const parentTypeId = x.parentIncidentTypeId ?? x.categoryId ?? null;

        // Datetime: prefer explicit field; otherwise derive from ObjectId
        const dt = extractDateISO(x) || objectIdToISO(id) || null;

        // Optional reverse geocode
        const addr = await reverseGeocode(lat, lon);

        return {
          id,
          type,
          parent,
          parentTypeId,
          lat,
          lon,
          zone: zoneFor(lat, lon),
          datetime: dt,    // ISO string or null
          address: addr,   // string or null (requires ENABLE_REVERSE_GEOCODE=true)
        };
      })
    );

    const categories = groupCount(incidents, (i) => i.parent);
    const zones = groupCount(incidents, (i) => i.zone);

    res.set("Cache-Control", "no-store");
    res.json({
      updated: now.toISOString(),
      hours,
      total: incidents.length,
      categories,
      zones,
      incidents,
    });
  } catch (e) {
    console.error("redding error:", e);
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

/* ---------- Backward-compat alias: /api/redding-72h ---------- */
app.get("/api/redding-72h", (req, res, next) => {
  req.query.hours = "72";
  return app._router.handle(req, res, next, "GET", "/api/redding");
});

app.listen(PORT, () => console.log("cityprotect-api on :" + PORT));
