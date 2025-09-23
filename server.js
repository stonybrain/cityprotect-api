import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

const EP = "https://ce-portal-service.commandcentral.com/api/v1.0/public/incidents";

// Base payload derived from your Network capture.
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
    parentIncidentTypeIds: "149,150,148,8,97,104,165,98,100,179,178,180,101,99,103,163,168,166,12,161,14,16,15",
    zoomLevel: "11",
    latitude: "40.573945",
    longitude: "-122.381764",
    days: "1,2,3,4,5,6,7",
    startHour: "0",
    endHour: "24",
    timezone: "+00:00",
    relativeDate: "custom",
    id: "5dfab4da933cf80011f565bc",
    agencyIds: "cityofredding.org,ci.anderson.ca.us"
  }
};

// Helper to page through results if needed
async function fetchAll(body) {
  const headers = { "content-type":"application/json", "accept":"application/json" };
  const first = await fetch(EP, { method: "POST", headers, body: JSON.stringify(body) });
  const j1 = await first.json();
  let all = j1.incidents || [];
  let next = j1.navigation?.nextPagePath;
  let nextData = j1.navigation?.nextPageData?.requestData;

  while (next) {
    const r = await fetch("https://ce-portal-service.commandcentral.com" + next, {
      method: "POST",
      headers,
      body: JSON.stringify(nextData || body)
    });
    const j = await r.json();
    all = all.concat(j.incidents || []);
    next = j.navigation?.nextPagePath;
    nextData = j.navigation?.nextPageData?.requestData;
  }
  return all;
}

// Main endpoint: rolling last 24 hours for Redding area polygon & chosen incident categories
app.get("/api/redding-24h", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const body = {
      ...BASE,
      propertyMap: {
        ...BASE.propertyMap,
        fromDate: from.toISOString(),
        toDate: now.toISOString()
      }
    };
    const all = await fetchAll(body);
    const incidents = all.map(x => ({
      time: x.occurredOn || x.incidentDate || x.date || null,
      type: x.parentIncidentTypeName || x.incidentType || x.type || "Unknown",
      address: x.blockAddress || x.address || x.location || "",
      city: x.city || "Redding",
      lat: x.latitude ?? x.geometry?.y ?? null,
      lon: x.longitude ?? x.geometry?.x ?? null
    }));
    res.json({ updated: now.toISOString(), hours: 24, total: incidents.length, incidents });
  } catch (e) {
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

app.listen(PORT, () => {
  console.log("cityprotect-api on :" + PORT);
});
