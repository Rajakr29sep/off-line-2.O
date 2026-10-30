/* Government Mode: shared incident feed + regional map with simulated flood overlay. Reuses OAMap. */
(async function () {
  await OA.init({ roles: ["government_operator"] });
  const { $, esc } = OA;
  const m = await OAMap.create($("#map"));
  m.legend(["incident", "hospital", "shelter", "relief_camp", "police", "fire_station"]);
  await m.loadHazards();
  m.toggleFlood(true);
  const places = (await OA.api("/api/maps/places?categories=hospital,shelter,police,fire_station")).places;
  const groups = { hosp: L.layerGroup(), shelter: L.layerGroup(), services: L.layerGroup() };
  places.forEach((p) => {
    const g = p.category === "hospital" ? groups.hosp : p.category === "shelter" ? groups.shelter : groups.services;
    L.marker([p.lat, p.lon], { icon: m.icon(p.category), title: p.name }).bindPopup(`<strong>${esc(p.name)}</strong><br>${esc(OAMap.CAT[p.category][2])} · OpenStreetMap`).addTo(g);
  });
  groups.hosp.addTo(m.map); groups.shelter.addTo(m.map);
  const toggle = (id, layer) => $(id).addEventListener("change", (e) => (e.target.checked ? layer.addTo(m.map) : m.map.removeLayer(layer)));
  toggle("#layHosp", groups.hosp); toggle("#layShelter", groups.shelter); toggle("#layServices", groups.services); toggle("#layInc", m.layers.incidents);
  $("#layFlood").addEventListener("change", (e) => m.toggleFlood(e.target.checked));

  let requests = [];
  const markers = new Map();
  async function load() {
    try { requests = (await OA.api("/api/requests")).requests; } catch (e) { return OA.toast(esc(e.message), "error"); }
    // Delivery receipt for citizen requests shown on this dashboard.
    requests.filter((r) => !r.organisationId && r.deliveryStatus === "RELAYED").forEach((r) => OA.api(`/api/requests/${r.id}/received`, { method: "POST" }).catch(() => {}));
    const open = requests.filter((r) => r.status === "OPEN");
    $("#gOpen").textContent = open.length;
    $("#gProg").textContent = requests.filter((r) => r.status === "IN_PROGRESS").length;
    $("#gRes").textContent = requests.filter((r) => r.status === "RESOLVED").length;
    $("#gPeople").textContent = requests.filter((r) => r.status !== "RESOLVED").reduce((a, r) => a + r.peopleAffected, 0);
    m.layers.incidents.clearLayers(); markers.clear();
    requests.filter((r) => r.latitude != null && r.status !== "RESOLVED").forEach((r) => {
      const mk = L.marker([r.latitude, r.longitude], { icon: m.icon("incident", r.status === "OPEN" ? "animation:pulse 1.4s infinite" : "opacity:.75"), zIndexOffset: 1000 })
        .bindPopup(`<strong>${esc(OA.catLabel(r.category))}</strong> · ${esc(r.id)}${r.isSample ? " (SAMPLE)" : ""}<br>${esc(r.description || "")}<br>${r.peopleAffected} affected · ${esc(r.status)}`).addTo(m.layers.incidents);
      markers.set(r.id, mk);
    });
    $("#feed").innerHTML = requests.length ? requests.map((r) => `<div class="item ${r.status === "OPEN" ? "new" : ""}" data-id="${r.id}">
      <div class="item-head"><strong>${esc(OA.catLabel(r.category))}</strong><span class="pill ${r.status}">${r.status.replace("_", " ")}</span>${r.isSample ? '<span class="pill sample">SAMPLE</span>' : ""}<span class="grow"></span><span class="dim" style="font-size:12px">${OA.ago(r.createdAt)}</span></div>
      <div class="item-meta">${esc(r.organisationName || "Citizen")} · ${esc(r.senderName)} · ${r.peopleAffected} affected</div>
      <div class="item-meta">${esc(r.description || "")}</div>
      <div class="item-meta">${r.latitude != null ? `<a href="#" data-locate="${r.id}">${r.latitude.toFixed(4)}, ${r.longitude.toFixed(4)}</a>` : "No GPS location"}</div>
      ${r.status !== "RESOLVED" ? `<div class="row" style="margin-top:8px">${r.status === "OPEN" ? `<button class="btn sm warn" data-st="IN_PROGRESS" data-r="${r.id}">Dispatch / in progress</button>` : ""}<button class="btn sm success" data-st="RESOLVED" data-r="${r.id}">Resolve</button></div>` : ""}
    </div>`).join("") : '<div class="empty">No shared requests.</div>';
    OA.$$("[data-locate]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); const mk = markers.get(a.dataset.locate); if (mk) { m.map.setView(mk.getLatLng(), 16); mk.openPopup(); } }));
    OA.$$("[data-st]").forEach((b) => b.addEventListener("click", async () => {
      try { await OA.api(`/api/requests/${b.dataset.r}/status`, { method: "PATCH", body: { status: b.dataset.st } }); load(); } catch (e) { OA.toast(esc(e.message), "error"); }
    }));
    OA.icons();
  }
  let t;
  const reload = () => { clearTimeout(t); t = setTimeout(load, 250); };
  OA.on("request.new", (ev) => { OA.toast(`<strong>New ${esc(OA.catLabel(ev.request.category))} request</strong> · ${esc(ev.request.organisationName || "citizen")}`, "alert", 6000); reload(); });
  ["request.updated", "ws.open"].forEach((ev) => OA.on(ev, reload));
  setInterval(() => { if (OA.wsState !== "live") load(); }, 10000);
  load();
})();
