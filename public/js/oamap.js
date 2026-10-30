/* Shared offline map component (Citizen + Government). Leaflet + local PMTiles vector basemap — no tile servers. */
(function () {
  const CAT = {
    hospital: ["#ef4444", "H", "Hospital"], clinic: ["#f472b6", "C", "Clinic"], pharmacy: ["#34d399", "Rx", "Pharmacy"],
    police: ["#3b82f6", "P", "Police"], fire_station: ["#f97316", "F", "Fire station"], shelter: ["#22c55e", "S", "Assembly point / shelter"],
    emergency_service: ["#eab308", "E", "Emergency service"], relief_camp: ["#4ade80", "R", "Relief camp (SIMULATED)"],
    incident: ["#f04444", "!", "Incident"],
  };

  function icon(cat, extra = "") {
    const [color, glyph] = CAT[cat] || ["#64748b", "?"];
    return L.divIcon({ className: "", html: `<div class="poi-marker" style="background:${color};${extra}">${glyph}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  async function create(el, opts = {}) {
    const info = await OA.api("/api/maps/region");
    const region = info.region;
    const [w, s, e, n] = region.bbox;
    const bounds = L.latLngBounds([s, w], [n, e]);
    const map = L.map(el, { maxBounds: bounds.pad(0.15), minZoom: 13, maxZoom: 18, zoomControl: true, attributionControl: true });
    map.fitBounds(bounds);
    if (info.tiles) {
      protomapsL.leafletLayer({ url: info.tiles, flavor: "dark", lang: "en", maxDataZoom: 16 }).addTo(map);
    } else {
      OA.toast("Offline basemap not installed — showing data layers only.", "error");
    }
    map.attributionControl.setPrefix(false);
    map.attributionControl.addAttribution(`${region.attribution} · offline package: ${region.name}`);
    L.rectangle(bounds, { color: "#22d3ee", weight: 1, fill: false, dashArray: "4 6", interactive: false }).addTo(map);

    const layers = { places: L.layerGroup().addTo(map), route: L.layerGroup().addTo(map), flood: L.layerGroup(), incidents: L.layerGroup().addTo(map), start: L.layerGroup().addTo(map) };
    const api = { map, region, layers, CAT, icon };

    api.showPlaces = (places, onClick) => {
      layers.places.clearLayers();
      places.forEach((p) => {
        const m = L.marker([p.lat, p.lon], { icon: icon(p.category), title: p.name }).addTo(layers.places);
        m.bindPopup(`<strong>${OA.esc(p.name)}</strong><br><span style="color:#8d9bb5">${OA.esc((CAT[p.category] || [])[2] || p.category)}${p.distanceMetres != null ? " · " + (p.distanceMetres / 1000).toFixed(2) + " km" : ""}</span>${p.address ? "<br>" + OA.esc(p.address) : ""}<br><small>Source: OpenStreetMap</small>`);
        if (onClick) m.on("click", () => onClick(p));
      });
    };

    api.showRoute = (coords, { flooded } = {}) => {
      layers.route.clearLayers();
      if (!coords) return;
      L.polyline(coords, { color: "#0e7490", weight: 10, opacity: 0.5 }).addTo(layers.route);
      L.polyline(coords, { color: flooded ? "#f5a524" : "#22d3ee", weight: 5, dashArray: flooded ? "8 8" : null }).addTo(layers.route);
      L.circleMarker(coords[coords.length - 1], { radius: 7, color: "#fff", fillColor: "#22c55e", fillOpacity: 1 }).addTo(layers.route);
      map.fitBounds(L.latLngBounds(coords).pad(0.25));
    };

    api.setStart = (latlng, onMove) => {
      layers.start.clearLayers();
      const m = L.marker(latlng, { draggable: true, icon: L.divIcon({ className: "", html: '<div class="poi-marker" style="background:#22d3ee;color:#03202a;width:30px;height:30px">You</div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(layers.start);
      m.bindTooltip("Start (drag to move)");
      if (onMove) m.on("dragend", () => onMove(m.getLatLng()));
      return m;
    };

    api.loadHazards = async () => {
      layers.flood.clearLayers();
      try {
        const gj = await OA.api("/api/maps/hazards");
        L.geoJSON(gj, {
          style: (f) => ({ color: f.properties.severity === "high" ? "#3b82f6" : "#60a5fa", weight: 2, fillColor: "#2563eb", fillOpacity: 0.35, dashArray: "5 5" }),
          pointToLayer: (f, ll) => L.marker(ll, { icon: icon(f.properties.kind === "relief_camp" ? "relief_camp" : "shelter") }),
          onEachFeature: (f, l) => l.bindPopup(`<strong>${OA.esc(f.properties.name)}</strong><br><span style="color:#f5a524">SIMULATED demo data — not a real hazard or shelter.</span>${f.properties.capacity ? "<br>Capacity " + f.properties.capacity : ""}`),
        }).addTo(layers.flood);
        return gj;
      } catch (e) { OA.toast(OA.esc(e.message), "error"); return null; }
    };
    api.toggleFlood = (on) => { if (on) layers.flood.addTo(map); else map.removeLayer(layers.flood); };

    api.legend = (cats) => {
      const ctl = L.control({ position: "bottomleft" });
      ctl.onAdd = () => {
        const d = L.DomUtil.create("div");
        d.style.cssText = "background:rgba(7,13,26,.88);padding:8px 10px;border-radius:8px;border:1px solid rgba(148,170,210,.2);font-size:12px;color:#e6edf8;line-height:1.9";
        d.innerHTML = cats.map((c) => `<div><span class="poi-marker" style="display:inline-grid;width:16px;height:16px;font-size:8px;border-width:1px;vertical-align:middle;background:${(CAT[c] || CAT.incident)[0]}">${(CAT[c] || CAT.incident)[1]}</span> ${(CAT[c] || [0, 0, c])[2]}</div>`).join("")
          + (cats.includes("flood") ? "" : "");
        return d;
      };
      ctl.addTo(map);
    };
    return api;
  }

  window.OAMap = { create, CAT };
})();
