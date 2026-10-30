// Offline maps: local POI search (SQLite FTS5) + A* road routing on a precomputed OSM graph.
const fs = require("fs");
const path = require("path");
const { db, all, tx } = require("./db");
const { astar } = require("./astar");

const MAP_DIR = path.join(__dirname, "..", "data", "maps");
const FILES = {
  tiles: path.join(MAP_DIR, "region.pmtiles"),
  graph: path.join(MAP_DIR, "roadgraph.json"),
  pois: path.join(MAP_DIR, "pois.json"),
  region: path.join(MAP_DIR, "region.json"),
  flood: path.join(MAP_DIR, "flood_simulated.geojson"),
};

let graph = null; // { lat:Float64Array, lon:Float64Array, adj:Array<Array<[to, metres, edgeIdx]>>, edges }
let region = null;
let flood = null;

function haversine(lat1, lon1, lat2, lon2) {
  const r = 6371000, toRad = Math.PI / 180;
  const dp = (lat2 - lat1) * toRad, dl = (lon2 - lon1) * toRad;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function pointInPolygon(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const NON_DRIVABLE = new Set(["footway", "path", "steps", "pedestrian", "track"]);

// Snap only to the largest connected component so isolated fragments (e.g. a lone footpath) never strand a route.
function largestComponent(undirected, n) {
  const comp = new Int32Array(n).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let i = 0; i < n; i++) {
    if (comp[i] !== -1 || !undirected[i].length) continue;
    const stack = [i];
    comp[i] = id;
    let size = 0;
    while (stack.length) {
      const k = stack.pop();
      size++;
      for (const j of undirected[k]) if (comp[j] === -1) { comp[j] = id; stack.push(j); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  const main = new Uint8Array(n);
  for (let i = 0; i < n; i++) main[i] = comp[i] === best ? 1 : 0;
  return main;
}

function inFlood(lat, lon) {
  if (!flood) return false;
  return flood.features.some((f) => f.geometry.type === "Polygon" && pointInPolygon(lon, lat, f.geometry.coordinates[0]));
}

function load() {
  const status = { tiles: fs.existsSync(FILES.tiles), graph: false, pois: 0, flood: false };
  if (fs.existsSync(FILES.region)) region = JSON.parse(fs.readFileSync(FILES.region, "utf8"));
  if (fs.existsSync(FILES.flood)) { flood = JSON.parse(fs.readFileSync(FILES.flood, "utf8")); status.flood = true; }
  if (fs.existsSync(FILES.graph)) {
    const raw = JSON.parse(fs.readFileSync(FILES.graph, "utf8"));
    const n = raw.nodes.length;
    const lat = new Float64Array(n), lon = new Float64Array(n);
    raw.nodes.forEach(([a, b], i) => { lat[i] = a; lon[i] = b; });
    const edges = raw.edges.map(([from, to, metres, oneway, wayId, name, highway]) => {
      const midLat = (lat[from] + lat[to]) / 2, midLon = (lon[from] + lon[to]) / 2;
      return { from, to, metres, oneway: !!oneway, wayId, name, highway, flooded: inFlood(midLat, midLon) };
    });
    const modes = {};
    for (const mode of ["walk", "drive"]) {
      const adj = Array.from({ length: n }, () => []);
      const undirected = Array.from({ length: n }, () => []);
      edges.forEach((ed, idx) => {
        if (mode === "drive" && NON_DRIVABLE.has(ed.highway)) return;
        adj[ed.from].push([ed.to, ed.metres, idx]);
        if (mode === "walk" || !ed.oneway) adj[ed.to].push([ed.from, ed.metres, idx]);
        undirected[ed.from].push(ed.to);
        undirected[ed.to].push(ed.from);
      });
      modes[mode] = { adj, main: largestComponent(undirected, n) };
    }
    graph = { lat, lon, edges, n, modes };
    status.graph = true;
  }
  if (fs.existsSync(FILES.pois)) {
    const pois = JSON.parse(fs.readFileSync(FILES.pois, "utf8"));
    tx(() => {
      db.exec("DELETE FROM places; DELETE FROM places_fts;");
      const ins = db.prepare("INSERT INTO places (id,name,category,lat,lon,address,phone,source) VALUES (?,?,?,?,?,?,?,?)");
      const fts = db.prepare("INSERT INTO places_fts (id,name,category,address) VALUES (?,?,?,?)");
      for (const p of pois) {
        ins.run(p.id, p.name, p.category, p.lat, p.lon, p.address || "", p.phone || "", p.source || "OpenStreetMap");
        // Category is indexed with readable synonyms so "fire", "police station", "doctor" etc. match.
        fts.run(p.id, p.name, `${p.category.replace("_", " ")} ${SYNONYMS[p.category] || ""}`, p.address || "");
      }
    });
    status.pois = pois.length;
  }
  return status;
}

const SYNONYMS = {
  hospital: "hospital medical emergency ambulance health",
  clinic: "clinic doctor medical health dispensary",
  pharmacy: "pharmacy chemist medicine medical",
  police: "police station law",
  fire_station: "fire brigade station rescue",
  shelter: "shelter assembly point refuge evacuation",
  emergency_service: "emergency ambulance service",
};

function searchPlaces(q, { lat, lon, category, limit = 20 } = {}) {
  const terms = String(q || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  let rows;
  if (terms.length) {
    const match = terms.map((t) => `"${t}"*`).join(" ");
    rows = all(`SELECT p.* FROM places_fts f JOIN places p ON p.id = f.id WHERE places_fts MATCH ? ${category ? "AND p.category = ?" : ""} LIMIT 200`,
      ...(category ? [match, category] : [match]));
  } else if (category) {
    rows = all("SELECT * FROM places WHERE category = ? LIMIT 200", category);
  } else {
    rows = [];
  }
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    rows.forEach((r) => { r.distanceMetres = Math.round(haversine(lat, lon, r.lat, r.lon)); });
    rows.sort((a, b) => a.distanceMetres - b.distanceMetres);
  }
  return rows.slice(0, limit);
}

function nearestNode(lat, lon, main) {
  let best = -1, bestD = Infinity;
  for (let i = 0; i < graph.n; i++) {
    if (!main[i]) continue;
    const d = haversine(lat, lon, graph.lat[i], graph.lon[i]);
    if (d < bestD) { bestD = d; best = i; }
  }
  return { node: best, metres: bestD };
}

function route({ fromLat, fromLon, toLat, toLon, avoidFlood = false, avoidRoads = [], mode = "walk" }) {
  if (!graph) return { ok: false, reason: "Road graph not installed. Run scripts/prepare_map.py." };
  const [w, s, e, n] = region.bbox;
  for (const [la, lo] of [[fromLat, fromLon], [toLat, toLon]]) {
    if (!(lo >= w && lo <= e && la >= s && la <= n)) return { ok: false, reason: "Location is outside the offline map region." };
  }
  const m = graph.modes[mode] || graph.modes.walk;
  const a = nearestNode(fromLat, fromLon, m.main), b = nearestNode(toLat, toLon, m.main);
  if (a.metres > 500 || b.metres > 500) return { ok: false, reason: "No road within 500 m of the start or destination." };
  const avoid = new Set(avoidRoads.map((r) => String(r).toLowerCase()));
  const tLat = graph.lat[b.node], tLon = graph.lon[b.node];
  const res = astar({
    start: a.node,
    isGoal: (k) => k === b.node,
    neighbours: (k) => m.adj[k].filter(([, , idx]) => {
      const ed = graph.edges[idx];
      if (avoidFlood && ed.flooded) return false;
      return !(ed.name && avoid.has(ed.name.toLowerCase()));
    }),
    heuristic: (k) => haversine(graph.lat[k], graph.lon[k], tLat, tLon),
  });
  if (!res) return { ok: false, reason: avoidFlood || avoid.size ? "No route avoids the selected hazards/roads." : "No connected road route found." };
  const coords = res.path.map((k) => [graph.lat[k], graph.lon[k]]);
  // Collapse consecutive edges on the same road into simple instructions.
  const steps = [];
  res.edges.forEach((idx) => {
    const ed = graph.edges[idx];
    const name = ed.name || `unnamed ${ed.highway.replace("_", " ")}`;
    const last = steps[steps.length - 1];
    if (last && last.road === name) last.metres += ed.metres;
    else steps.push({ road: name, metres: ed.metres });
  });
  steps.forEach((s2) => { s2.metres = Math.round(s2.metres); });
  const floodedEdges = res.edges.filter((idx) => graph.edges[idx].flooded).length;
  return {
    ok: true, mode: graph.modes[mode] ? mode : "walk", coords, distanceMetres: Math.round(res.cost), walkMinutes: Math.round(res.cost / 80),
    driveMinutes: Math.max(1, Math.round(res.cost / 400)), steps, crossesFloodZone: floodedEdges > 0,
    snap: { startMetres: Math.round(a.metres), endMetres: Math.round(b.metres) }, nodesExpanded: res.expansions,
  };
}

const getRegion = () => region;
const getFlood = () => flood;
const graphInfo = () => (graph ? { nodes: graph.n, edges: graph.edges.length, floodedEdges: graph.edges.filter((e) => e.flooded).length,
  mainComponentNodes: graph.modes.walk.main.reduce((a, b) => a + b, 0) } : null);

module.exports = { FILES, load, searchPlaces, route, getRegion, getFlood, graphInfo, haversine };
