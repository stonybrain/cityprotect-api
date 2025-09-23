import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// CORS
app.use((_, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Health
app.get("/", (_, res) => res.send("ok"));
app.get("/api/test", (_, res) => res.json({ ok: true }));

// CityProtect
const EP = "https://ce-portal-service.commandcentral.com/api/v1.0/public/incidents";
const BASE_HEADERS = {
  "content-type": "application/json",
  "accept": "application/json",
  "origin": "https://www.cityprotect.com",
  "referer": "https://www.cityprotect.com/",
  "user-agent": "Mozilla/5.0"
};

// Polygon around Redding
const BASE = {
  limit: 2000,
  offset: 0,
  geoJson: { type: "Polygon", coordinates: [[
    [-122.20872933,40.37101482],[-122.55479867,40.37101482],
    [-122.55479867,40.77626157],[-122.20872933,40.77626157],
    [-122.20872933,40.37101482]
  ]]},
  projection: true,
  propertyMap: {
    pageSize:"2000",
    zoomLevel:"11", latitude:"40.573945", longitude:"-122.381764",
    days:"1,2,3,4,5,6,7", startHour:"0", endHour:"24",
    timezone:"+00:00", relativeDate:"custom",
    id:"5dfab4da933cf80011f565bc",
    agencyIds:"cityofredding.org,ci.anderson.ca.us"
  }
};

// helper
function toAbs(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("http")) return url;
  if (url.startsWith("/")) return "https://ce-portal-service.commandcentral.com" + url;
  return null;
}

// ---- ROUTES ----

// Debug: raw CityProtect JSON
app.get("/api/raw", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 72*60*60*1000); // 72h window

    const body = {
      ...BASE,
      propertyMap: {
        ...BASE.propertyMap,
        fromDate: from.toISOString(),
        toDate: now.toISOString(),
        parentIncidentTypeIds: "149,150,148,8,97,104,165,98,100,179,178,180,101,99,103,163,168,166,12,161,14,16,15"
      }
    };

    const resp = await fetch(EP, { method:"POST", headers: BASE_HEADERS, body: JSON.stringify(body) });
    const data = await resp.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

// Clean: mapped incidents
app.get("/api/redding-24h", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 72*60*60*1000); // 72h window for now

    const body = {
      ...BASE,
      propertyMap: {
        ...BASE.propertyMap,
        fromDate: from.toISOString(),
        toDate: now.toISOString(),
        parentIncidentTypeIds: "149,150,148,8,97,104,165,98,100,179,178,180,101,99,103,163,168,166,12,161,14,16,15"
      }
    };

    const r1 = await fetch(EP, { method:"POST", headers: BASE_HEADERS, body: JSON.stringify(body) });
    const j1 = await r1.json();
    let all = j1.incidents || [];

    // paginate if available
    let nextPath = j1.navigation?.nextPagePath;
    let nextData = j1.navigation?.nextPageData?.requestData || body;

    while (nextPath) {
      const nextUrl = toAbs(nextPath);
      if (!nextUrl) break;
      const r = await fetch(nextUrl, { method:"POST", headers: BASE_HEADERS, body: JSON.stringify(nextData) });
      const j = await r.json();
      all = all.concat(j.incidents || []);
      nextPath = j.navigation?.nextPagePath;
      nextData = j.navigation?.nextPageData?.requestData || nextData;
    }

    const incidents = all.map(x => ({
      time: x.occurredOn || x.incidentDate || x.date || null,
      type: x.parentIncidentTypeName || x.incidentType || x.type || "Unknown",
      address: x.blockAddress || x.address || x.location || "",
      city: x.city || "Redding",
      lat: x.latitude ?? x.geometry?.y ?? null,
      lon: x.longitude ?? x.geometry?.x ?? null
    }));

    res.json({ updated: now.toISOString(), hours: 72, total: incidents.length, incidents });
  } catch (e) {
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

app.listen(PORT, () => console.log("cityprotect-api on :"+PORT));
