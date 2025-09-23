import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

// ✅ Allow Squarespace/JSFiddle to call your API
app.use((_, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  next();
});

const EP = "https://ce-portal-service.commandcentral.com/api/v1.0/public/incidents";

// Base payload for Redding
const payload = {
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
    toDate: "2025-09-23T23:59:59.999Z",
    fromDate: "2025-09-20T00:00:00.000Z",
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

// Headers to mimic browser request
const headers = {
  "content-type": "application/json",
  "accept": "application/json",
  "origin": "https://www.cityprotect.com",
  "referer": "https://www.cityprotect.com/",
  "user-agent": "Mozilla/5.0"
};

app.get("/api/redding-24h", async (req, res) => {
  try {
    const resp = await fetch(EP, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    res.json({
      total: data.total || data.count || (data.items ? data.items.length : 0),
      incidents: (data.items || []).map(x => ({
        type: x.incidentCategory || x.type || "Unknown",
        address: x.address || "Unknown",
        time: x.occurredOn || x.time
      }))
    });
  } catch (err) {
    console.error("Error fetching incidents:", err);
    res.status(500).json({ error: "Failed to fetch incidents" });
  }
});

app.listen(PORT, () => {
  console.log(`cityprotect-api running on :${PORT}`);
});
