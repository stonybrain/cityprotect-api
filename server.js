import express from "express";
import fetch from "node-fetch";

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
  if (!r.ok) throw new Error(`Upstream ${r.status}`);
  return r.json();
};

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

/* ---------- RAW peek (param hours) ---------- */
app.get("/api/raw", async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(72, parseInt(req.query.hours, 10) || 72));
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

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

/* ---------- JSON for widget (param hours) ---------- */
app.get("/api/redding", async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(72, parseInt(req.query.hours, 10) || 72));
    const now = new Date();
    const from = new Date(now.getTime() - hours * 60 * 60 * 1000);

    const body = {
      ...BASE,
      propertyMap: { ...BASE.propertyMap, fromDate: from.toISOString(), toDate: now.toISOString() },
    };

    const j = await fetchJSON(EP, { method: "POST", headers: H, body: JSON.stringify(body) });
    const raw = j?.result?.list?.incidents ?? [];

    const incidents = raw.map((x) => {
      const lon = x.location?.coordinates?.[0] ?? null;
      const lat = x.location?.coordinates?.[1] ?? null;
      return {
        id: x.id || null,
        type: x.incidentType || x.parentIncidentType || "Unknown",
        parent: x.parentIncidentType || "Unknown",
        parentTypeId: x.parentIncidentTypeId ?? null,
        lon, lat,
        zone: zoneFor(lat, lon),
      };
    });

    const categories = groupCount(incidents, (i) => i.parent);
    const zones = groupCount(incidents, (i) => i.zone);

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

/* ---------- legacy alias (kept for your existing widget) ---------- */
app.get("/api/redding-72h", (req, res) => {
  req.query.hours = "72";
  app._router.handle(req, res, () => {}, "GET", "/api/redding");
});

app.listen(PORT, () => console.log("cityprotect-api on :" + PORT));
