app.get("/api/redding-24h", async (_req, res) => {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 72 * 60 * 60 * 1000); // 72h test

    const body = {
      ...BASE,
      propertyMap: {
        ...BASE.propertyMap,
        fromDate: from.toISOString(),
        toDate: now.toISOString()
      }
    };

    const j = await fetchJSON(EP, {
      method: "POST",
      headers: H,
      body: JSON.stringify(body)
    });

    // just 1 page of incidents
    const all = pickIncidents(j);

    const incidents = all.map(x => ({
      id: x.id || null,
      type: x.incidentType || x.parentIncidentType || "Unknown",
      parentTypeId: x.parentIncidentTypeId ?? null,
      lon: x.location?.coordinates?.[0] ?? null,
      lat: x.location?.coordinates?.[1] ?? null
    }));

    res.json({
      updated: now.toISOString(),
      hours: 72,
      total: incidents.length,
      incidents
    });
  } catch (e) {
    console.error("CLEAN error:", e);
    res.status(500).json({ error: e?.message || "fetch-failed" });
  }
});