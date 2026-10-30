/* Citizen offline map: local search + A* routing on the local OSM road graph. */
(async function () {
  await OA.init();
  const { $, esc } = OA;
  const DEMO_START = [28.6230, 77.2140];
  const m = await OAMap.create($("#map"));
  m.legend(["hospital", "clinic", "police", "fire_station", "shelter", "relief_camp"]);
  await m.loadHazards();
  let start = null, selected = null, results = [];

  function setStart(latlng, label) {
    start = { lat: latlng.lat ?? latlng[0], lon: latlng.lng ?? latlng[1] };
    m.setStart([start.lat, start.lon], (ll) => setStart(ll, "Moved manually"));
    $("#startInfo").textContent = `${label || "Start"}: ${start.lat.toFixed(5)}, ${start.lon.toFixed(5)}`;
    if (results.length) search($("#q").value || "hospital", false);
    if (selected) routeTo(selected);
  }
  setStart(DEMO_START, "Demo start (Patel Chowk, sample)");
  m.map.on("click", (e) => setStart(e.latlng, "Chosen on map"));
  $("#demoStart").onclick = () => setStart(DEMO_START, "Demo start (Patel Chowk, sample)");
  $("#gpsBtn").onclick = () => {
    if (!navigator.geolocation || !window.isSecureContext) return OA.toast("GPS needs https or localhost in the browser. Click the map to set your position instead.", "error", 6000);
    navigator.geolocation.getCurrentPosition((p) => {
      const ll = { lat: p.coords.latitude, lng: p.coords.longitude };
      const [w, s, e, n] = m.region.bbox;
      if (ll.lng < w || ll.lng > e || ll.lat < s || ll.lat > n) return OA.toast("Your location is outside the offline map region. Set a start point on the map.", "error", 6000);
      setStart(ll, `GPS ±${Math.round(p.coords.accuracy)} m`);
      m.map.setView(ll, 16);
    }, (err) => OA.toast(`GPS failed: ${esc(err.message)}. Click the map instead.`, "error"), { enableHighAccuracy: true, timeout: 10000 });
  };

  async function search(q, fit = true) {
    try {
      const out = await OA.api(`/api/maps/places/search?q=${encodeURIComponent(q)}&lat=${start.lat}&lon=${start.lon}&limit=25`);
      results = out.places;
      $("#resTitle").textContent = `${results.length} result${results.length === 1 ? "" : "s"} for “${q}”`;
      $("#results").innerHTML = results.length ? results.map((p, i) => {
        const [color, glyph, label] = OAMap.CAT[p.category] || ["#64748b", "?", p.category];
        return `<div class="result ${selected && selected.id === p.id ? "selected" : ""}" data-i="${i}"><span class="ico" style="background:${color}22;color:${color};font-weight:800">${glyph}</span>
          <div class="grow"><strong>${esc(p.name)}</strong><div class="dim" style="font-size:12px">${esc(label)} · ${(p.distanceMetres / 1000).toFixed(2)} km straight-line</div></div><i data-lucide="navigation"></i></div>`;
      }).join("") : '<div class="empty">No matching places in the offline region.</div>';
      OA.$$("#results [data-i]").forEach((el) => el.addEventListener("click", () => routeTo(results[Number(el.dataset.i)])));
      m.showPlaces(results, routeTo);
      if (fit && results.length) m.map.fitBounds(L.latLngBounds(results.slice(0, 8).map((p) => [p.lat, p.lon]).concat([[start.lat, start.lon]])).pad(0.2));
      OA.icons();
    } catch (e) { OA.toast(esc(e.message), "error"); }
  }

  async function routeTo(p) {
    selected = p;
    OA.$$("#results .result").forEach((el) => el.classList.toggle("selected", results[Number(el.dataset.i)] === p));
    const panel = $("#routePanel");
    panel.classList.remove("hidden");
    panel.innerHTML = '<div class="typing"><span></span><span></span><span></span> Calculating route on local road graph…</div>';
    try {
      const q = `fromLat=${start.lat}&fromLon=${start.lon}&toLat=${p.lat}&toLon=${p.lon}&mode=${$("#mode").value}${$("#avoidFlood").checked ? "&avoidFlood=1" : ""}`;
      const r = await OA.api(`/api/maps/route?${q}`);
      if (!r.ok) { m.showRoute(null); panel.innerHTML = `<div class="notice danger"><i data-lucide="triangle-alert"></i><div><strong>No route.</strong><br>${esc(r.reason)}</div></div>`; OA.icons(); return; }
      m.showRoute(r.coords, { flooded: r.crossesFloodZone });
      panel.innerHTML = `<div class="panel-head"><i data-lucide="navigation"></i><h2>Route to ${esc(p.name)}</h2></div>
        <div class="grid cols-2" style="gap:8px"><div class="stat cyan"><small>Distance</small><strong>${(r.distanceMetres / 1000).toFixed(2)} km</strong></div>
        <div class="stat"><small>${r.mode === "drive" ? "Drive (est.)" : "Walk (est.)"}</small><strong>${r.mode === "drive" ? r.driveMinutes : r.walkMinutes} min</strong></div></div>
        ${r.crossesFloodZone ? '<div class="notice warn" style="margin-top:10px"><i data-lucide="waves"></i><div>This route passes through a <strong>simulated flood zone</strong>. Tick “Avoid flood zones” to reroute.</div></div>' : ""}
        ${$("#avoidFlood").checked && !r.crossesFloodZone ? '<div class="notice ok" style="margin-top:10px"><i data-lucide="shield-check"></i>Route avoids simulated flood zones.</div>' : ""}
        <ol class="route-steps" style="margin-top:12px">${r.steps.filter((s) => s.metres >= 15).map((s) => `<li>${esc(s.road)} <span class="dim">· ${s.metres} m</span></li>`).join("")}</ol>
        <p class="dim" style="font-size:11.5px;margin-top:10px">A* on ${esc(m.region.name)} OSM graph · computed in ${r.computeMs} ms · start snapped ${r.snap.startMetres} m to road. Estimates only — follow official instructions.</p>`;
      OA.icons();
    } catch (e) { panel.innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; }
  }

  $("#searchForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#q").value.trim(); if (q) search(q); });
  OA.$$("[data-q]").forEach((b) => b.addEventListener("click", () => { $("#q").value = b.dataset.q; search(b.dataset.q); }));
  $("#avoidFlood").addEventListener("change", () => { if ($("#avoidFlood").checked) { $("#showFlood").checked = true; m.toggleFlood(true); } if (selected) routeTo(selected); });
  $("#showFlood").addEventListener("change", (e) => m.toggleFlood(e.target.checked));
  $("#mode").addEventListener("change", () => selected && routeTo(selected));
})();
