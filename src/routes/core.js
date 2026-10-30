// Auth, organisation dashboard, floor plans + evacuation plans (SafeRoute), maps, AI proxy and system status.
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const express = require("express");
const multer = require("multer");
const { DATA_DIR, DB_PATH, all, get, run, now, newId, audit } = require("../db");
const auth = require("../auth");
const { validateGraph, computeRoute } = require("../indoor");
const maps = require("../maps");
const rt = require("../realtime");

const router = express.Router();
const { requireAuth, requirePermission, rateLimit } = auth;
const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";
const UPLOAD_DIR = path.join(DATA_DIR, "uploads", "floorplans");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const fail = (res, status, error) => res.status(status).json({ error });
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ---------------------------------------------------------------- Auth
router.post("/auth/login", rateLimit("login", 15, 60000), (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase().slice(0, 60);
  const pin = String(req.body?.pin || "").slice(0, 32);
  const user = get(`SELECT u.*, o.name AS organisation_name, o.facility_name FROM users u
    LEFT JOIN organisations o ON o.id = u.organisation_id WHERE u.username = ?`, username);
  if (!user || !auth.verifyPin(pin, user.pin_hash)) {
    audit(null, "auth.failed", { username });
    return fail(res, 401, "Invalid username or PIN.");
  }
  const { token, expiresAt } = auth.createSession(user.id);
  audit(user.id, "auth.login");
  res.setHeader("Set-Cookie", `oa_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`);
  res.json({ token, expiresAt, user: auth.publicUser(user) });
});

router.post("/auth/logout", (req, res) => {
  auth.destroySession(req.token);
  res.setHeader("Set-Cookie", "oa_token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  res.json({ ok: true });
});

router.get("/auth/me", requireAuth, (req, res) => res.json({ user: auth.publicUser(req.user) }));

// Demo accounts are listed on the login screen (all clearly labelled sample data; PINs documented in README).
router.get("/auth/demo-accounts", (_req, res) => {
  res.json({ accounts: all("SELECT username, name, role, job_title FROM users WHERE is_sample = 1 ORDER BY role, username") });
});

// ---------------------------------------------------------------- Organisation
function orgGuard(req, res, next) {
  if (req.params.id !== req.user.organisation_id) return fail(res, 404, "Organisation not found.");
  next();
}

router.get("/organisations/:id", requireAuth, orgGuard, (req, res) => {
  res.json({ organisation: get("SELECT * FROM organisations WHERE id = ?", req.params.id) });
});

router.get("/organisations/:id/dashboard", requirePermission("org:read"), orgGuard, (req, res) => {
  const id = req.params.id;
  const org = get("SELECT * FROM organisations WHERE id = ?", id);
  const employees = all("SELECT id, name, job_title, safety_status, safety_updated_at, is_sample FROM users WHERE organisation_id = ? AND role = 'employee' ORDER BY name", id)
    .map((e) => ({ ...e, online: rt.isOnline(e.id) }));
  const count = (sql, ...p) => get(sql, ...p).c;
  res.json({
    organisation: org,
    stats: {
      employees: employees.length,
      activeSos: count("SELECT COUNT(*) c FROM emergency_requests WHERE organisation_id = ? AND status != 'RESOLVED'", id),
      safe: employees.filter((e) => e.safety_status === "SAFE").length,
      needAssistance: employees.filter((e) => ["NEEDS_HELP", "NEEDS_EVACUATION"].includes(e.safety_status)).length,
      unknown: employees.filter((e) => e.safety_status === "UNKNOWN").length,
      plans: count("SELECT COUNT(*) c FROM evacuation_plans WHERE organisation_id = ?", id),
      floorPlans: count("SELECT COUNT(*) c FROM floor_plans WHERE organisation_id = ?", id),
      activeAlerts: count("SELECT COUNT(*) c FROM alerts WHERE organisation_id = ? AND status = 'ACTIVE'", id),
    },
    employees,
    floorPlans: all("SELECT id, name, floor, updated_at, is_sample FROM floor_plans WHERE organisation_id = ? ORDER BY created_at", id),
  });
});

router.patch("/organisations/:id/emergency-status", requirePermission("alert:send"), orgGuard, (req, res) => {
  const status = ["NORMAL", "EMERGENCY"].includes(req.body?.status) ? req.body.status : null;
  if (!status) return fail(res, 400, "status must be NORMAL or EMERGENCY");
  run("UPDATE organisations SET emergency_status = ? WHERE id = ?", status, req.params.id);
  if (status === "NORMAL") {
    run("UPDATE alerts SET status = 'CLOSED' WHERE organisation_id = ?", req.params.id);
    run("UPDATE users SET safety_status = 'UNKNOWN' WHERE organisation_id = ? AND role = 'employee'", req.params.id);
  }
  audit(req.user.id, "org.emergency_status", { status });
  rt.toOrgRoles(req.params.id, ["employee", "officer", "administrator"], { type: "org.status", status });
  res.json({ ok: true, status });
});

// ---------------------------------------------------------------- Floor plans (SafeRoute)
const MAGIC = { "image/png": [0x89, 0x50, 0x4e, 0x47], "image/jpeg": [0xff, 0xd8, 0xff], "application/pdf": [0x25, 0x50, 0x44, 0x46] };
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.FLOORPLAN_MAX_MB || 15) * 1024 * 1024, files: 2 },
});

function sniff(buf) {
  return Object.keys(MAGIC).find((type) => MAGIC[type].every((b, i) => buf[i] === b)) || null;
}

function mapPlan(fp, includeGraph = true) {
  return {
    id: fp.id, organisationId: fp.organisation_id, name: fp.name, floor: fp.floor, width: fp.width, height: fp.height,
    imageUrl: `/api/floorplans/${fp.id}/image`, hasOriginalPdf: !!(fp.original_path && fp.original_path.endsWith(".pdf")),
    isSample: !!fp.is_sample, createdAt: fp.created_at, updatedAt: fp.updated_at,
    ...(includeGraph ? { nodes: parse(fp.nodes, []), edges: parse(fp.edges, []) } : {}),
  };
}

function loadPlan(req, res) {
  const fp = get("SELECT * FROM floor_plans WHERE id = ?", req.params.id);
  if (!fp || fp.organisation_id !== req.user.organisation_id) { fail(res, 404, "Floor plan not found."); return null; }
  return fp;
}

// Multipart: "image" (PNG/JPG — for PDFs the browser renders the chosen page to PNG with pdf.js) + optional "original" PDF.
router.post("/floorplans", requirePermission("floorplan:write"), upload.fields([{ name: "image", maxCount: 1 }, { name: "original", maxCount: 1 }]), (req, res) => {
  const image = req.files?.image?.[0];
  if (!image) return fail(res, 400, "A PNG or JPG floor-plan image is required (PDF pages are rendered to PNG in the browser).");
  const imgType = sniff(image.buffer);
  if (!["image/png", "image/jpeg"].includes(imgType)) return fail(res, 415, "Floor-plan image must be PNG or JPG.");
  const original = req.files?.original?.[0];
  if (original && sniff(original.buffer) !== "application/pdf") return fail(res, 415, "Original document must be a PDF.");
  const name = String(req.body?.name || "Floor plan").trim().slice(0, 80) || "Floor plan";
  const floor = String(req.body?.floor || "Ground").trim().slice(0, 40) || "Ground";
  const width = Math.max(1, Math.min(20000, parseInt(req.body?.width, 10) || 0)) || null;
  const height = Math.max(1, Math.min(20000, parseInt(req.body?.height, 10) || 0)) || null;
  const id = newId("FP");
  const orgDir = path.join(UPLOAD_DIR, req.user.organisation_id);
  fs.mkdirSync(orgDir, { recursive: true });
  // Server-generated filenames only — user-supplied names never touch the filesystem (path traversal protection).
  const imageFile = path.join(orgDir, `${id}.${imgType === "image/png" ? "png" : "jpg"}`);
  fs.writeFileSync(imageFile, image.buffer);
  let originalFile = null;
  if (original) { originalFile = path.join(orgDir, `${id}.pdf`); fs.writeFileSync(originalFile, original.buffer); }
  const t = now();
  run(`INSERT INTO floor_plans (id, organisation_id, name, floor, image_path, original_path, width, height, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, id, req.user.organisation_id, name, floor, path.relative(DATA_DIR, imageFile),
  originalFile ? path.relative(DATA_DIR, originalFile) : null, width, height, t, t);
  audit(req.user.id, "floorplan.upload", { id });
  res.status(201).json({ floorPlan: mapPlan(get("SELECT * FROM floor_plans WHERE id = ?", id)) });
});

router.get("/floorplans", requirePermission("floorplan:read", "alert:respond"), (req, res) => {
  const rows = all("SELECT * FROM floor_plans WHERE organisation_id = ? ORDER BY created_at", req.user.organisation_id);
  res.json({ floorPlans: rows.map((r) => mapPlan(r, req.query.graph === "1")) });
});

router.get("/floorplans/:id", requirePermission("floorplan:read", "alert:respond"), (req, res) => {
  const fp = loadPlan(req, res);
  if (fp) res.json({ floorPlan: mapPlan(fp) });
});

function sendDataFile(res, rel) {
  const abs = path.resolve(DATA_DIR, rel || "");
  if (!abs.startsWith(path.resolve(DATA_DIR) + path.sep) || !fs.existsSync(abs)) return fail(res, 404, "File not found.");
  res.setHeader("Cache-Control", "private, max-age=300");
  res.sendFile(abs);
}

router.get("/floorplans/:id/image", requirePermission("floorplan:read", "alert:respond"), (req, res) => {
  const fp = loadPlan(req, res);
  if (fp) sendDataFile(res, fp.image_path);
});
router.get("/floorplans/:id/original", requirePermission("floorplan:read"), (req, res) => {
  const fp = loadPlan(req, res);
  if (fp) sendDataFile(res, fp.original_path);
});

router.put("/floorplans/:id", requirePermission("floorplan:write"), (req, res) => {
  const fp = loadPlan(req, res);
  if (!fp) return;
  let graph;
  try { graph = validateGraph(req.body?.nodes || [], req.body?.edges || []); } catch (e) { return fail(res, 400, e.message); }
  const name = String(req.body?.name || fp.name).trim().slice(0, 80);
  const floor = String(req.body?.floor || fp.floor).trim().slice(0, 40);
  run("UPDATE floor_plans SET name = ?, floor = ?, nodes = ?, edges = ?, updated_at = ? WHERE id = ?",
    name, floor, JSON.stringify(graph.nodes), JSON.stringify(graph.edges), now(), fp.id);
  audit(req.user.id, "floorplan.save", { id: fp.id, nodes: graph.nodes.length, edges: graph.edges.length });
  res.json({ floorPlan: mapPlan(get("SELECT * FROM floor_plans WHERE id = ?", fp.id)) });
});

router.post("/floorplans/:id/route", requirePermission("floorplan:read", "alert:respond"), (req, res) => {
  const fp = loadPlan(req, res);
  if (!fp) return;
  const graph = { nodes: parse(fp.nodes, []), edges: parse(fp.edges, []) };
  res.json(computeRoute(graph, {
    start: String(req.body?.start || ""), destination: String(req.body?.destination || "nearest_safe"),
    blockedNodes: Array.isArray(req.body?.blockedNodes) ? req.body.blockedNodes.map(String) : [],
    blockedEdges: Array.isArray(req.body?.blockedEdges) ? req.body.blockedEdges.map(String) : [],
  }));
});

// ---------------------------------------------------------------- Evacuation plans
const EMERGENCY_TYPES = ["fire", "earthquake", "medical", "flood", "chemical", "other"];
function mapEvac(p) {
  return {
    id: p.id, organisationId: p.organisation_id, floorPlanId: p.floor_plan_id, name: p.name, emergencyType: p.emergency_type,
    startNode: p.start_node, destinationNode: p.destination_node, route: parse(p.route, []), blockedNodes: parse(p.blocked_nodes, []),
    blockedEdges: parse(p.blocked_edges, []), instructions: p.instructions, isSample: !!p.is_sample,
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

function planInput(req, res, fp) {
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) { fail(res, 400, "Plan name is required."); return null; }
  const emergencyType = EMERGENCY_TYPES.includes(b.emergencyType) ? b.emergencyType : null;
  if (!emergencyType) { fail(res, 400, `emergencyType must be one of ${EMERGENCY_TYPES.join(", ")}`); return null; }
  const graph = { nodes: parse(fp.nodes, []), edges: parse(fp.edges, []) };
  const blockedNodes = Array.isArray(b.blockedNodes) ? b.blockedNodes.map(String).slice(0, 500) : [];
  const blockedEdges = Array.isArray(b.blockedEdges) ? b.blockedEdges.map(String).slice(0, 500) : [];
  const route = computeRoute(graph, { start: String(b.startNode || ""), destination: String(b.destinationNode || ""), blockedNodes, blockedEdges });
  return { name, emergencyType, startNode: String(b.startNode), destinationNode: String(b.destinationNode), blockedNodes, blockedEdges,
    instructions: String(b.instructions || "").slice(0, 3000), route };
}

router.post("/evacuation-plans", requirePermission("plan:write"), (req, res) => {
  const fp = get("SELECT * FROM floor_plans WHERE id = ?", String(req.body?.floorPlanId || ""));
  if (!fp || fp.organisation_id !== req.user.organisation_id) return fail(res, 404, "Floor plan not found.");
  const p = planInput(req, res, fp);
  if (!p) return;
  const id = newId("EVP");
  const t = now();
  run(`INSERT INTO evacuation_plans (id, organisation_id, floor_plan_id, name, emergency_type, start_node, destination_node, route,
    blocked_nodes, blocked_edges, instructions, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, req.user.organisation_id, fp.id, p.name, p.emergencyType, p.startNode, p.destinationNode,
  JSON.stringify(p.route.ok ? p.route.path : []), JSON.stringify(p.blockedNodes), JSON.stringify(p.blockedEdges), p.instructions, t, t);
  audit(req.user.id, "plan.create", { id });
  res.status(201).json({ plan: mapEvac(get("SELECT * FROM evacuation_plans WHERE id = ?", id)), route: p.route });
});

router.put("/evacuation-plans/:id", requirePermission("plan:write"), (req, res) => {
  const ep = get("SELECT * FROM evacuation_plans WHERE id = ?", req.params.id);
  if (!ep || ep.organisation_id !== req.user.organisation_id) return fail(res, 404, "Plan not found.");
  const fp = get("SELECT * FROM floor_plans WHERE id = ?", ep.floor_plan_id);
  const p = planInput(req, res, fp);
  if (!p) return;
  run(`UPDATE evacuation_plans SET name=?, emergency_type=?, start_node=?, destination_node=?, route=?, blocked_nodes=?, blocked_edges=?,
    instructions=?, updated_at=? WHERE id=?`, p.name, p.emergencyType, p.startNode, p.destinationNode,
  JSON.stringify(p.route.ok ? p.route.path : []), JSON.stringify(p.blockedNodes), JSON.stringify(p.blockedEdges), p.instructions, now(), ep.id);
  res.json({ plan: mapEvac(get("SELECT * FROM evacuation_plans WHERE id = ?", ep.id)), route: p.route });
});

router.delete("/evacuation-plans/:id", requirePermission("plan:write"), (req, res) => {
  const ep = get("SELECT * FROM evacuation_plans WHERE id = ?", req.params.id);
  if (!ep || ep.organisation_id !== req.user.organisation_id) return fail(res, 404, "Plan not found.");
  run("DELETE FROM evacuation_plans WHERE id = ?", ep.id);
  res.json({ ok: true });
});

router.get("/evacuation-plans", requirePermission("plan:read", "alert:respond"), (req, res) => {
  const rows = req.query.floorPlanId
    ? all("SELECT * FROM evacuation_plans WHERE organisation_id = ? AND floor_plan_id = ? ORDER BY created_at", req.user.organisation_id, String(req.query.floorPlanId))
    : all("SELECT * FROM evacuation_plans WHERE organisation_id = ? ORDER BY created_at", req.user.organisation_id);
  res.json({ plans: rows.map(mapEvac) });
});

router.get("/evacuation-plans/:id", requirePermission("plan:read", "alert:respond"), (req, res) => {
  const ep = get("SELECT * FROM evacuation_plans WHERE id = ?", req.params.id);
  if (!ep || ep.organisation_id !== req.user.organisation_id) return fail(res, 404, "Plan not found.");
  res.json({ plan: mapEvac(ep) });
});

// Recalculate with the plan's saved blocks plus any live extra blocks (e.g. a corridor reported on fire).
router.post("/evacuation-plans/:id/calculate-route", requirePermission("plan:read", "alert:respond"), (req, res) => {
  const ep = get("SELECT * FROM evacuation_plans WHERE id = ?", req.params.id);
  if (!ep || ep.organisation_id !== req.user.organisation_id) return fail(res, 404, "Plan not found.");
  const fp = get("SELECT * FROM floor_plans WHERE id = ?", ep.floor_plan_id);
  const extraNodes = Array.isArray(req.body?.blockedNodes) ? req.body.blockedNodes.map(String) : [];
  const extraEdges = Array.isArray(req.body?.blockedEdges) ? req.body.blockedEdges.map(String) : [];
  const route = computeRoute({ nodes: parse(fp.nodes, []), edges: parse(fp.edges, []) }, {
    start: String(req.body?.start || ep.start_node), destination: String(req.body?.destination || ep.destination_node),
    blockedNodes: [...parse(ep.blocked_nodes, []), ...extraNodes], blockedEdges: [...parse(ep.blocked_edges, []), ...extraEdges],
  });
  res.json({ plan: mapEvac(ep), route });
});

// ---------------------------------------------------------------- Maps
router.get("/maps/region", (_req, res) => {
  const region = maps.getRegion();
  if (!region) return fail(res, 404, "Offline map package not installed.");
  res.json({ region, tiles: fs.existsSync(maps.FILES.tiles) ? "/maps/region.pmtiles" : null, graph: maps.graphInfo() });
});

router.get("/maps/places/search", requirePermission("map:read"), (req, res) => {
  const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
  const category = /^[a-z_]{2,30}$/.test(req.query.category || "") ? req.query.category : null;
  res.json({ places: maps.searchPlaces(String(req.query.q || "").slice(0, 80), { lat, lon, category, limit: Math.min(50, parseInt(req.query.limit, 10) || 20) }) });
});

router.get("/maps/places", requirePermission("map:read"), (req, res) => {
  const cats = String(req.query.categories || "hospital,shelter,police,fire_station").split(",").filter((c) => /^[a-z_]+$/.test(c));
  res.json({ places: all(`SELECT * FROM places WHERE category IN (${cats.map(() => "?").join(",")})`, ...cats) });
});

router.get("/maps/route", requirePermission("map:read"), rateLimit("route", 60, 60000), (req, res) => {
  const q = req.query;
  const nums = ["fromLat", "fromLon", "toLat", "toLon"].map((k) => parseFloat(q[k]));
  if (nums.some((n) => !Number.isFinite(n))) return fail(res, 400, "fromLat, fromLon, toLat, toLon are required numbers.");
  const avoidRoads = String(q.avoidRoads || "").split("|").map((s) => s.trim()).filter(Boolean).slice(0, 10);
  const t0 = Date.now();
  const out = maps.route({ fromLat: nums[0], fromLon: nums[1], toLat: nums[2], toLon: nums[3], avoidFlood: q.avoidFlood === "1", avoidRoads, mode: q.mode === "drive" ? "drive" : "walk" });
  res.json({ ...out, computeMs: Date.now() - t0 });
});

router.get("/maps/hazards", requirePermission("map:read"), (_req, res) => {
  const flood = maps.getFlood();
  if (!flood) return fail(res, 404, "No hazard overlay installed.");
  res.json(flood);
});

// ---------------------------------------------------------------- AI (proxy to local FastAPI — never to a cloud API)
function proxyJson(method, pathName, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathName, PYTHON_API_URL);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(url, { method, timeout: timeoutMs, headers: payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {} }, (r) => {
      let data = "";
      r.on("data", (c) => { data += c; });
      r.on("end", () => resolve({ status: r.statusCode, body: parse(data, { error: data.slice(0, 300) }) }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function relay(res, out) {
  const body = out.body && out.body.detail && !out.body.error ? { error: typeof out.body.detail === "string" ? out.body.detail : "Request rejected." } : out.body;
  res.status(out.status).json(body);
}

const aiDown = (res) => fail(res, 503, "AI service (FastAPI) is not running. Start it with start.bat. No online AI fallback is used.");

router.get("/ai/health", async (_req, res) => {
  try { relay(res, await proxyJson("GET", "/health", null, 5000)); } catch { aiDown(res); }
});

router.post("/ai/ask", requirePermission("ai:ask"), rateLimit("ai", 20, 60000), async (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 1000);
  if (question.length < 2) return fail(res, 400, "Please enter a question.");
  const t0 = Date.now();
  try {
    const out = await proxyJson("POST", "/ask", { question }, 120000);
    if (out.status === 200) out.body.roundTripMs = Date.now() - t0;
    audit(req.user.id, "ai.ask", { q: question.slice(0, 120), ms: Date.now() - t0, status: out.status });
    relay(res, out);
  } catch { aiDown(res); }
});

// Streaming variant: NDJSON events piped straight through so words appear as Llama generates them.
router.post("/ai/ask/stream", requirePermission("ai:ask"), rateLimit("ai", 20, 60000), (req, res) => {
  const question = String(req.body?.question || "").trim().slice(0, 1000);
  if (question.length < 2) return fail(res, 400, "Please enter a question.");
  const payload = Buffer.from(JSON.stringify({ question }));
  const t0 = Date.now();
  const up = http.request(new URL("/ask/stream", PYTHON_API_URL), { method: "POST", timeout: 180000,
    headers: { "Content-Type": "application/json", "Content-Length": payload.length } }, (r) => {
    if (r.statusCode !== 200) {
      let data = "";
      r.on("data", (c) => { data += c; });
      r.on("end", () => relay(res, { status: r.statusCode, body: parse(data, { error: "AI request failed." }) }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
    r.pipe(res);
    r.on("end", () => audit(req.user.id, "ai.ask", { q: question.slice(0, 120), ms: Date.now() - t0, stream: true }));
  });
  up.on("timeout", () => up.destroy(new Error("timeout")));
  up.on("error", () => { if (!res.headersSent) aiDown(res); else res.end(); });
  up.end(payload);
});

router.get("/ai/sources", requireAuth, async (_req, res) => {
  try { relay(res, await proxyJson("GET", "/sources", null, 5000)); } catch { aiDown(res); }
});
router.get("/ai/sources/:id/status", requireAuth, async (req, res) => {
  try { relay(res, await proxyJson("GET", `/sources/${encodeURIComponent(req.params.id)}`, null, 5000)); } catch { aiDown(res); }
});
router.post("/ai/sources/:id/reindex", requirePermission("ai:sources"), async (req, res) => {
  try { relay(res, await proxyJson("POST", `/sources/${encodeURIComponent(req.params.id)}/reindex`, null, 10000)); } catch { aiDown(res); }
});
router.delete("/ai/sources/:id", requirePermission("ai:sources"), async (req, res) => {
  try { relay(res, await proxyJson("DELETE", `/sources/${encodeURIComponent(req.params.id)}`, null, 60000)); } catch { aiDown(res); }
});

// Voice: audio recorded in the browser is transcribed on this laptop (faster-whisper); Piper returns WAV.
router.post("/ai/voice/transcribe", requirePermission("ai:ask"), rateLimit("voice", 20, 60000), (req, res) => {
  const up = http.request(new URL("/voice/transcribe", PYTHON_API_URL), { method: "POST", timeout: 60000,
    headers: { "content-type": req.headers["content-type"] || "", ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}) } }, (r) => {
    let data = "";
    r.on("data", (c) => { data += c; });
    r.on("end", () => relay(res, { status: r.statusCode, body: parse(data, { error: "Transcription failed." }) }));
  });
  up.on("error", () => { if (!res.headersSent) aiDown(res); });
  req.pipe(up);
});

router.post("/ai/voice/speak", requirePermission("ai:ask"), rateLimit("voice", 40, 60000), (req, res) => {
  const text = String(req.body?.text || "").slice(0, 2000);
  if (!text.trim()) return fail(res, 400, "text required");
  const payload = Buffer.from(JSON.stringify({ text }));
  const up = http.request(new URL("/voice/speak", PYTHON_API_URL), { method: "POST", timeout: 60000,
    headers: { "Content-Type": "application/json", "Content-Length": payload.length } }, (r) => {
    if (r.statusCode !== 200) return relay(res, { status: r.statusCode, body: { error: "Speech synthesis unavailable." } });
    res.writeHead(200, { "Content-Type": "audio/wav" });
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) aiDown(res); });
  up.end(payload);
});

// Stream the multipart ZIM upload straight through to FastAPI (no buffering of large files in Node).
router.post("/ai/sources/upload", requirePermission("ai:sources"), (req, res) => {
  const url = new URL("/sources/upload", PYTHON_API_URL);
  const headers = { "content-type": req.headers["content-type"] || "" };
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
  const up = http.request(url, { method: "POST", headers }, (r) => {
    let data = "";
    r.on("data", (c) => { data += c; });
    r.on("end", () => relay(res, { status: r.statusCode, body: parse(data, { error: "Upload failed." }) }));
  });
  up.on("error", () => { if (!res.headersSent) aiDown(res); });
  req.pipe(up);
  audit(req.user.id, "ai.source_upload");
});

// ---------------------------------------------------------------- System
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
}

function internetCheck() {
  // Purely informational: a DNS lookup tells us whether the laptop currently has internet. Nothing depends on it.
  return new Promise((resolve) => {
    require("dns").lookup("one.one.one.one", (err) => resolve(!err));
    setTimeout(() => resolve(false), 1500).unref();
  });
}

router.get("/health", (_req, res) => res.json({ status: "ok", service: "node", time: now() }));

router.get("/system/status", async (_req, res) => {
  const checks = {};
  checks.node = { state: "online", detail: `Node ${process.version}` };
  try {
    get("SELECT 1 AS ok");
    checks.sqlite = { state: "online", detail: path.basename(DB_PATH) };
  } catch (e) { checks.sqlite = { state: "offline", detail: "Database unavailable" }; }
  let ai = null;
  try {
    const out = await proxyJson("GET", "/health", null, 4000);
    ai = out.body;
    checks.fastapi = { state: "online", detail: "AI service responding" };
  } catch { checks.fastapi = { state: "offline", detail: "Not running on " + PYTHON_API_URL }; }
  if (ai) {
    checks.ollama = { state: ai.ollama.reachable ? "online" : "offline", detail: ai.ollama.reachable ? "Local runtime reachable" : "Start Ollama" };
    checks.llm = { state: ai.llm.available ? (ai.llm.warm ? "online" : "degraded") : (ai.ollama.reachable ? "not_configured" : "offline"),
      detail: `${ai.llm.model}${ai.llm.available ? (ai.llm.warm ? " · loaded" : " · not yet loaded") : " · missing"}` };
    checks.embedding = { state: ai.embedding.available ? "online" : (ai.ollama.reachable ? "not_configured" : "offline"), detail: ai.embedding.model };
    checks.knowledge = { state: ai.index.sources_ready ? (ai.index.indexing.length ? "degraded" : "online") : (ai.index.indexing.length ? "degraded" : "not_configured"),
      detail: `${ai.index.chunks} chunks · ${ai.index.sources_ready}/${ai.index.sources_total} packs ready${ai.index.indexing.length ? " · indexing" : ""}` };
  } else {
    ["ollama", "llm", "embedding", "knowledge"].forEach((k) => { checks[k] = { state: "offline", detail: "AI service offline" }; });
  }
  const gi = maps.graphInfo();
  const region = maps.getRegion();
  checks.maps = { state: fs.existsSync(maps.FILES.tiles) && gi ? "online" : (gi || fs.existsSync(maps.FILES.tiles) ? "degraded" : "not_configured"),
    detail: region ? `${region.name} · ${gi ? gi.nodes + " road nodes" : "no graph"}` : "Run scripts/prepare_map.py" };
  const internet = await internetCheck();
  const lan = lanAddresses();
  checks.network = { state: lan.length ? "online" : "degraded",
    detail: `${lan.length ? "LAN " + lan.join(", ") : "No LAN interface"} · internet ${internet ? "available" : "unavailable (offline mode)"}`, internet };
  res.json({ checks, websocketClients: rt.connectionCount(), lan, port: Number(process.env.PORT || 3000), time: now() });
});

module.exports = { router, lanAddresses };
