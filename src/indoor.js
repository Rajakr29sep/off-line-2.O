// Indoor evacuation routing over a floor-plan graph (nodes in image pixel coordinates).
const { astar } = require("./astar");

const NODE_TYPES = ["entrance", "exit", "corridor", "room", "stairs", "assembly", "extinguisher", "first_aid",
  "medical", "restricted", "hazard"];
const IMPASSABLE_TYPES = new Set(["restricted", "hazard"]);
const SAFE_DESTINATION_TYPES = ["assembly", "exit"];

const edgeId = (a, b) => [a, b].sort().join("--");

function validateGraph(nodes, edges) {
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error("nodes and edges must be arrays");
  if (nodes.length > 2000 || edges.length > 5000) throw new Error("Graph too large");
  const ids = new Set();
  const cleanNodes = nodes.map((n) => {
    const id = String(n.id || "").slice(0, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate node id: ${id}`);
    ids.add(id);
    if (!NODE_TYPES.includes(n.type)) throw new Error(`Invalid node type for ${id}`);
    const x = Number(n.x), y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Invalid coordinates for ${id}`);
    return { id, x: Math.round(x), y: Math.round(y), type: n.type, label: String(n.label || "").slice(0, 60),
      blocked: !!n.blocked, floorId: n.floorId ? String(n.floorId).slice(0, 40) : null };
  });
  const seen = new Set();
  const cleanEdges = [];
  for (const e of edges) {
    const s = String(e.source), d = String(e.destination);
    if (!ids.has(s) || !ids.has(d) || s === d) throw new Error(`Edge references unknown node: ${s}-${d}`);
    const id = edgeId(s, d);
    if (seen.has(id)) continue;
    seen.add(id);
    const cost = e.cost == null || e.cost === "" ? null : Number(e.cost);
    cleanEdges.push({ id, source: s, destination: d, cost: Number.isFinite(cost) && cost > 0 ? cost : null, blocked: !!e.blocked });
  }
  return { nodes: cleanNodes, edges: cleanEdges };
}

/**
 * destination: node id, or one of "nearest_exit" / "nearest_assembly" / "nearest_safe".
 * Extra blocked nodes/edges (from an evacuation plan or live incident) are applied on top of the saved graph.
 */
function computeRoute({ nodes, edges }, { start, destination, blockedNodes = [], blockedEdges = [] }) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(start)) return { ok: false, reason: "Start node not found on this floor plan." };
  const blockedN = new Set([...blockedNodes, ...nodes.filter((n) => n.blocked).map((n) => n.id)]);
  const blockedE = new Set([...blockedEdges, ...edges.filter((e) => e.blocked).map((e) => e.id)]);
  if (blockedN.has(start)) return { ok: false, reason: "The start location itself is blocked." };

  let goalTypes = null;
  if (destination === "nearest_exit") goalTypes = ["exit"];
  else if (destination === "nearest_assembly") goalTypes = ["assembly"];
  else if (destination === "nearest_safe") goalTypes = SAFE_DESTINATION_TYPES;
  else if (!byId.has(destination)) return { ok: false, reason: "Destination node not found on this floor plan." };

  const goals = goalTypes ? new Set(nodes.filter((n) => goalTypes.includes(n.type) && !blockedN.has(n.id)).map((n) => n.id))
    : new Set([destination]);
  if (!goals.size || [...goals].every((g) => blockedN.has(g))) {
    return { ok: false, reason: "Every destination is blocked. No safe route exists — follow officer instructions." };
  }

  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (blockedE.has(e.id)) continue;
    const a = byId.get(e.source), b = byId.get(e.destination);
    const cost = e.cost || Math.hypot(a.x - b.x, a.y - b.y);
    adj.get(e.source).push([e.destination, cost, e.id]);
    adj.get(e.destination).push([e.source, cost, e.id]);
  }
  const passable = (id) => !blockedN.has(id) && (!IMPASSABLE_TYPES.has(byId.get(id).type) || goals.has(id));
  const target = !goalTypes ? byId.get(destination) : null;
  const result = astar({
    start,
    isGoal: (id) => goals.has(id),
    neighbours: (id) => adj.get(id).filter(([next]) => passable(next)),
    heuristic: target ? (id) => { const n = byId.get(id); return Math.hypot(n.x - target.x, n.y - target.y); } : () => 0,
  });
  if (!result) {
    return { ok: false, reason: "No route available: blocked corridors or hazards cut off every path to the destination." };
  }
  const end = byId.get(result.path[result.path.length - 1]);
  return {
    ok: true, path: result.path, edges: result.edges, cost: Math.round(result.cost),
    destination: end.id, destinationLabel: end.label || end.type,
    steps: result.path.map((id) => { const n = byId.get(id); return { id, label: n.label || n.type, type: n.type }; }),
  };
}

module.exports = { NODE_TYPES, validateGraph, computeRoute, edgeId };
