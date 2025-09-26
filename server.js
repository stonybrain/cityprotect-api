// server.js — CommonJS, uses Node 18's global fetch
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
app.get("/api/test", (_, res) => res.json({ ok: true }));

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

// read nested path like "properties.address.line1"
function readPath(obj, path) {
  if (!obj) return undefined;
  return path.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

// pick first non-empty among many candidates
const pick = (...vals) => vals.find(v => v !== undefined && v !== null && v !== "");

// Try hard to find a timestamp string anywhere in record
function extractDateISO(x) {
  const tryKeys = [
    // common top-level
    "occurredDate", "occurredOn", "occurrenceDate", "occuredOn",
    "reportedDate", "reportDate", "reportedOn",
    "createdDate", "createDate", "createdOn", "timestamp", "eventDate", "dateTime",
    // nested
    "properties.occurredDate", "properties.occurredOn", "properties.reportedDate",
    "properties.createdDate", "properties.dateTime", "properties.timestamp"
  ];
  for (const k of tryKeys) {
    const v = k.includes(".") ? readPath(x, k) : x?.[k];
    if (v && typeof v === "string") {
      const dt = new Date(v);
      if (!isNaN(dt)) return dt.toISOString();
    }
  }
  // As a last resort, scan enumerable string fields that look like dates
  for (const [k, v] of Object.entries(x || {})) {
    if (typeof v === "string" && /date|time/i.test(k)) {
      const dt = new Date(v);
      if (!isNaN(dt)) return dt.toISOString();
    }
  }
  if (x?.properties) {
    for (const [k, v] of Object.entries(x.properties)) {
      if (typeof v === "string" && /date|time/i.test(k)) {
        const dt = new Date(v);
        if (!isNaN(dt)) return dt.toISOString();
      }
    }
  }
  return null;
}

// Build best-possible address string
function extractAddress(x) {
  // direct, already formatted
  const direct = pick(
    x.address, x.formattedAddress, x.commonPlaceName, x.locationName, x.blockAddress,
    readPath(x, "properties.address"), readPath(x, "properties.formattedAddress"),
    readPath(x, "properties.commonPlaceName"), readPath(x, "properties.locationName"),
    readPath(x, "properties.blockAddress")
  );
  if (direct) return String(direct);

  // try parts
  const parts = {
    number: pick(x.streetNumber, readPath(x, "properties.streetNumber")),
    street: pick(x.streetName, readPath(x, "properties.streetName")),
    line1: pick(readPath(x, "properties.address.line1")),
    line2: pick(readPath(x, "properties.address.line2")),
    city: pick(x.city, readPath(x, "properties.city")),
    state: pick(x.state, readPath(x, "properties.state")),
    postal: pick(x.postalCode, x.zip, readPath(x, "properties.postalCode"), readPath(x, "properties.zip"))
  };

  // Construct from line1/line2 if present
  if (parts.line1 || parts.line2) {
    const left = [parts.line1, parts.line2].filter(Boolean).join(", ");
    const right = [parts.city, parts.state, parts.postal].filter(Boolean).join(" ");
    return [left, right].filter(Boolean).join(", ");
  }

  // Construct from number + street
  const street = [parts.number, parts.street].filter(Boolean).join(" ").trim();
  const cityStateZip = [parts.city, parts.state, parts.postal].filter(Boolean).join(" ");
  const out = [street || null, cityStateZip || null].filter(Boolean).join(", ");
  return out || null;
}

// simple zones
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

  const incidents = raw.map((x) => {
    const lon = x.location?.coordinates?.[0] ?? null;
    const lat = x.location?.coordinates?.[1] ?? null;

    // IDs & types
    const incidentId = pick(x.id, x.incidentId, x.reportNumber, x.caseNumber);
    const type = pick(x.incidentType, x.type, x.parentIncidentType, "Unknown");
    const parent = pick(x.parentIncidentType, x.parentCategory, x.category, type, "Unknown");
    const parentTypeId = pick(x.parentIncidentTypeId, x.categoryId, null);

    // datetime & address (improved)
    const datetimeISO = extractDateISO(x);
    const address = extractAddress(x);

    return {
      id: incidentId || null,
      type,
      parent,
      parentTypeId,
      lat, lon,
      zone: zoneFor(lat, lon),
      datetime: datetimeISO,
      address: address
    };
  });

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

/* ---------- Start ---------- */
app.listen(PORT, () => console.log("cityprotect-api on :" + PORT));
