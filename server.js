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
const H = {
  "content-type": "application/json",
  "accept": "application/json",
  "origin": "https://www.cityprotect.com",
  "referer": "https://www.cityprotect.com/",
  "user-agent": "Mozilla/5.0"
};

// Redding polygon + agencies
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
    // include both numeric + domain agency IDs (as seen in your raw)
    agencyIds: "112398,112005,ci.anderson.ca.us,cityofredding.org",
    // burglary/theft/etc. — keep for now
    parentIncidentTypeIds: "149,150,148,8,97,104,165,98,100,179,178,180,101,99,103,163,168,166,12,161,14,16,15"
  }
};

// helper: get incidents array from any page shape
const pickIncidents = (j) =>
  j?.result?.list?.incidents ?? j?.incidents ?? j?.items ?? [];

// ---- RAW (debug) ----
app.get("/api/raw", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 72*60*60*1000); // 72h
    const body = { ...BASE, propertyMap: { ...BASE.propertyMap, fromDate: from.toISOString(), toDate: now.toISOString() } };
    const r = await fetch(EP, { method: "POST", headers: H, body: JSON.stringify(body) });
    const j = await r.json();
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

// ---- CLEAN LIST ----
app.get("/api/redding-24h", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 72*60*60*1000); // use 72h to ensure results; change to 24h later if you want
    const firstBody = { ...BASE, propertyMap: { ...BASE.propertyMap, fromDate: from.toISOString(), toDate: now.toISOString() } };

    // page 1
    const r1 = await fetch(EP, { method: "POST", headers: H, body: JSON.stringify(firstBody) });
    const j1 = await r1.json();
    let all = pickIncidents(j1);

    // pagination (CityProtect uses nextPagePath.requestData, not a URL)
    let nextReq = j1?.navigation?.nextPagePath?.requestData || null;

    while (nextReq) {
      const r = await fetch(EP, { method: "POST", headers: H, body: JSON.stringify(nextReq) });
      const j = await r.json();
      all = all.concat(pickIncidents(j));
      nextReq = j?.navigation?.nextPagePath?.requestData || null;
    }

    const incidents = all.map(x => ({
      id: x.id || x._id || null,
      type: x.incidentType || x.parentIncidentType || "Unknown",
      parentTypeId: x.parentIncidentTypeId ?? null,
      // coords are [lon,lat]
      lon: x.location?.coordinates?.[0] ?? null,
      lat: x.location?.coordinates?.[1] ?? null
    }));

    res.json({ updated: now.toISOString(), hours: 72, total: incidents.length, incidents });
  } catch (e) {
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

app.listen(PORT, () => console.log("cityprotect-api on :"+PORT));
