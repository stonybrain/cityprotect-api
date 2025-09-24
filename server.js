import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 8080;

/* ---------- ENV (Discord) ---------- */
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";
const NOTIFY_SECRET = process.env.NOTIFY_SECRET || ""; // optional but recommended

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

// Base body
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
  // try text -> json to improve error logging if bad JSON
  const text = await r.text();
  try { return JSON.parse(text); } catch {
    // if not JSON, throw with body included
    const err = new Error(`Bad JSON from ${url} (status ${r.status}): ${text.slice(0,200)}`);
    err.status = r.status;
    throw err;
  }
};

// Very simple zone classifier for Redding
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

/* ---------- 72h + zones + categories (one page) ---------- */
app.get("/api/redding-72h", async (_req, res) => {
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
      hours: 72,
      total: incidents.length,
      categories,
      zones,
      incidents,
    });
  } catch (e) {
    console.error("72H error:", e);
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});

/* ======================================================================
   ==============   DISCORD NOTIFICATIONS (optional)  ====================
   ====================================================================== */

/** Minimal in-memory sent-id set (resets on redeploy). */
const SENT_IDS = new Set();

/** Format a short Discord message for a batch of incidents. */
function formatDiscordMessage(newItems, totalCount) {
  const lines = [];
  lines.push(`**Redding Crime — New Incidents (${newItems.length})**`);
  const take = newItems.slice(0, 10); // show first 10
  for (const i of take) {
    const z = i.zone || "Unknown";
    const ll = (i.lat != null && i.lon != null)
      ? ` (${i.lat.toFixed(4)}, ${i.lon.toFixed(4)})` : "";
    lines.push(`• ${i.type} — ${z}${ll}`);
  }
  if (newItems.length > take.length) {
    lines.push(`…and ${newItems.length - take.length} more.`);
  }
  lines.push(`_Window: last 72 hours. Total in window: ${totalCount}._`);
  return lines.join("\n");
}

/** Post to Discord webhook. */
async function postToDiscord(content) {
  if (!DISCORD_WEBHOOK_URL) {
    throw new Error("DISCORD_WEBHOOK_URL not set");
  }
  const payload = {
    content,
    username: "AAX Crime Alerts",
    allowed_mentions: { parse: [] }
  };
  const r = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Discord webhook failed (${r.status}): ${t.slice(0,200)}`);
  }
}

/**
 * GET /api/notify?key=SECRET
 * - Fetches /api/redding-72h internally
 * - Filters out incidents we've already sent (by id)
 * - Sends a batch message to Discord if there are new ones
 */
app.get("/api/notify", async (req, res) => {
  try {
    if (NOTIFY_SECRET) {
      const key = (req.query.key || "").toString();
      if (key !== NOTIFY_SECRET) return res.status(401).json({ error: "unauthorized" });
    }

    // Pull the current 72h snapshot
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const r = await fetch(`${baseUrl}/api/redding-72h`, { headers: { "cache-control": "no-store" }});
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Failed to fetch redding-72h (${r.status}): ${t.slice(0,200)}`);
    }
    const data = await r.json();
    const incidents = data?.incidents || [];

    // Determine which are new (by id)
    const newOnes = incidents.filter(i => i?.id && !SENT_IDS.has(i.id));

    if (newOnes.length === 0) {
      return res.json({ ok: true, sent: 0, message: "No new incidents." });
    }

    // Mark them as sent (so the next call only sends new stuff)
    newOnes.forEach(i => SENT_IDS.add(i.id));

    // Build + send the message
    const msg = formatDiscordMessage(newOnes, data.total || incidents.length);
    await postToDiscord(msg);

    res.json({ ok: true, sent: newOnes.length });
  } catch (e) {
    console.error("notify error:", e);
    res.status(500).json({ error: e?.message || "notify-failed" });
  }
});

/**
 * GET /api/notify-test?key=SECRET
 * - Sends a simple test message to confirm webhook works
 */
app.get("/api/notify-test", async (req, res) => {
  try {
    if (NOTIFY_SECRET) {
      const key = (req.query.key || "").toString();
      if (key !== NOTIFY_SECRET) return res.status(401).json({ error: "unauthorized" });
    }
    await postToDiscord("✅ Test from AAX Crime Alerts — webhook is working.");
    res.json({ ok: true });
  } catch (e) {
    console.error("notify-test error:", e);
    res.status(500).json({ error: e?.message || "notify-test-failed" });
  }
});

app.listen(PORT, () => console.log("cityprotect-api on :" + PORT));
