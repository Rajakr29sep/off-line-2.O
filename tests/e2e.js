// End-to-end API test against a running OfflineAid server.
//   node tests/e2e.js [baseUrl]
// Use the LAN URL (e.g. http://192.168.0.115:3000) to test over the network interface rather than localhost.
const WebSocket = require("ws");
const crypto = require("crypto");

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const results = [];
const check = (name, cond, detail = "") => { results.push({ name, ok: !!cond, detail }); console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };
const cid = () => crypto.randomUUID();

async function api(token, path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await res.json(); } catch { /* */ }
  return { status: res.status, data };
}
const login = async (username, pin) => (await api(null, "/api/auth/login", { method: "POST", body: { username, pin } })).data.token;

function socket(token) {
  const events = [];
  const waiters = [];
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws?token=${encodeURIComponent(token)}`);
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    m._at = Date.now();
    events.push(m);
    waiters.slice().forEach((w) => { if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  });
  const opened = new Promise((r) => ws.on("open", r));
  const waitFor = (pred, ms = 5000) => new Promise((resolve) => {
    const hit = events.find(pred);
    if (hit) return resolve(hit);
    const w = { pred, resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); resolve(null); } }, ms);
  });
  return { ws, opened, waitFor, events };
}

(async () => {
  console.log(`OfflineAid e2e against ${BASE}\n`);
  const health = await api(null, "/api/health");
  check("Node health endpoint", health.status === 200);
  const bad = await api(null, "/api/auth/login", { method: "POST", body: { username: "emp1", pin: "0000" } });
  check("Wrong PIN rejected", bad.status === 401);

  const [emp, emp2, off, other, gov, cit, admin] = await Promise.all([
    login("emp1", "3333"), login("emp2", "4444"), login("officer", "2222"), login("other-officer", "7777"), login("gov", "6666"), login("citizen", "5555"), login("admin", "1111")]);
  check("All demo accounts can log in", emp && emp2 && off && other && gov && cit && admin);
  check("Unauthenticated API blocked", (await api(null, "/api/requests")).status === 401);

  const offWs = socket(off), empWs = socket(emp);
  await Promise.all([offWs.opened, empWs.opened]);
  check("WebSocket connects for officer and employee", true);
  const badWs = new WebSocket(`${BASE.replace("http", "ws")}/ws?token=bogus`);
  const badClose = await new Promise((r) => badWs.on("close", (code) => r(code)));
  check("WebSocket rejects invalid token", badClose === 4401, `close code ${badClose}`);

  // ---- SOS via the offline-sync endpoint (same path the IndexedDB outbox uses)
  const clientId = cid();
  const t0 = Date.now();
  const sync = await api(emp, "/api/messages/sync", { method: "POST", body: { items: [{ kind: "sos", clientId, clientCreatedAt: new Date().toISOString(), payload: { category: "fire", peopleAffected: 3, description: "e2e: smoke near Line A", zoneId: "Assembly Line A", floorId: "FP-sample-plant2" } }] } });
  const r0 = sync.data.results && sync.data.results[0];
  check("SOS accepted by server -> RELAYED", r0 && r0.ok && r0.deliveryStatus === "RELAYED", r0 && r0.serverId);
  const reqId = r0.serverId;
  const pushed = await offWs.waitFor((m) => m.type === "request.new" && m.request.id === reqId);
  check("Officer dashboard receives SOS over WebSocket", !!pushed, pushed ? `${pushed._at - t0} ms after send` : "timeout");
  const dup = await api(emp, "/api/messages/sync", { method: "POST", body: { items: [{ kind: "sos", clientId, payload: { category: "fire" } }] } });
  check("Retried SOS (same clientId) is de-duplicated", dup.data.results[0].duplicate === true && dup.data.results[0].serverId === reqId);
  const pend = await api(off, "/api/messages/pending");
  check("Server outbox lists SOS as pending for officer", pend.data.requests.some((r) => r.id === reqId));

  const rec = await api(off, `/api/requests/${reqId}/received`, { method: "POST" });
  check("Officer receipt -> RECEIVED", rec.data.request.deliveryStatus === "RECEIVED");
  const empSaw = await empWs.waitFor((m) => m.type === "request.updated" && m.request.id === reqId && m.request.deliveryStatus === "RECEIVED");
  check("Employee notified of RECEIVED", !!empSaw);
  const instr = await api(off, "/api/messages", { method: "POST", body: { clientId: cid(), requestId: reqId, text: "Leave via West Exit now." } });
  check("Officer instruction sent", instr.status === 201);
  const empInstr = await empWs.waitFor((m) => m.type === "message.new" && m.message.requestId === reqId);
  check("Employee receives officer instruction", !!empInstr);
  const ackd = await empWs.waitFor((m) => m.type === "request.updated" && m.request.id === reqId && m.request.deliveryStatus === "ACKNOWLEDGED");
  check("Officer response -> SOS ACKNOWLEDGED", !!ackd, ackd && ackd.request.acknowledgedBy);

  // ---- Alerts
  const empAlertForbidden = await api(emp, "/api/alerts", { method: "POST", body: { clientId: cid(), title: "x", message: "y", category: "fire" } });
  check("Employees cannot issue official alerts", empAlertForbidden.status === 403);
  const t1 = Date.now();
  const alert = await api(off, "/api/alerts", { method: "POST", body: { clientId: cid(), title: "e2e FIRE — evacuate", message: "Use your route.", category: "fire", severity: "critical", evacuationPlanId: "EVP-sample-fire", requestId: reqId } });
  check("Officer sends alert to all employees", alert.status === 201 && alert.data.alert.recipients.length === 2, `${alert.data.alert && alert.data.alert.recipients.length} recipients`);
  const alertId = alert.data.alert.id;
  const empAlert = await empWs.waitFor((m) => m.type === "alert.new" && m.alert.id === alertId);
  check("Employee device receives alert over WebSocket", !!empAlert, empAlert ? `${empAlert._at - t1} ms` : "timeout");
  check("Alert carries sender name and role", empAlert && empAlert.alert.senderName === "Rahul Verma" && empAlert.alert.senderRole === "officer");
  const emp2Pending = await api(emp2, "/api/messages/pending");
  check("Offline employee's alert waits in server outbox", emp2Pending.data.alerts.some((a) => a.id === alertId));
  await api(emp, `/api/alerts/${alertId}/received`, { method: "POST" });
  const offSaw = await offWs.waitFor((m) => m.type === "alert.updated" && m.alert.id === alertId && m.alert.counts.RECEIVED === 1);
  check("Officer sees alert RECEIVED by employee", !!offSaw);
  const respClient = cid();
  const resp = await api(emp, "/api/messages/sync", { method: "POST", body: { items: [{ kind: "alert_response", clientId: respClient, payload: { alertId, response: "SAFE" } }] } });
  check("Employee 'I am safe' relayed", resp.data.results[0].ok, resp.data.results[0].deliveryStatus);
  const offResp = await offWs.waitFor((m) => m.type === "message.new" && m.message.messageType === "response" && m.message.payload.response === "SAFE");
  check("Officer receives 'I am safe' over WebSocket", !!offResp);
  const offAck = await offWs.waitFor((m) => m.type === "alert.updated" && m.alert.id === alertId && m.alert.counts.ACKNOWLEDGED === 1);
  check("Alert ACKNOWLEDGED for that employee", !!offAck);
  const ackMsg = await api(off, `/api/messages/${offResp.message.id}/acknowledge`, { method: "POST" });
  check("Officer acknowledges response", ackMsg.data.message.deliveryStatus === "ACKNOWLEDGED");
  const empAckSeen = await empWs.waitFor((m) => m.type === "message.updated" && m.message.id === offResp.message.id && m.message.deliveryStatus === "ACKNOWLEDGED");
  check("Employee sees response ACKNOWLEDGED", !!empAckSeen);
  const dash = await api(off, "/api/organisations/org-sunrise/dashboard");
  check("Dashboard counts employee as safe", dash.data.stats.safe >= 1, JSON.stringify(dash.data.stats));

  // ---- Isolation / permissions
  check("Other organisation cannot read the request", (await api(other, `/api/requests/${reqId}`)).status === 404);
  check("Other organisation's list excludes it", !(await api(other, "/api/requests")).data.requests.some((r) => r.id === reqId));
  check("Other organisation cannot read dashboard", (await api(other, "/api/organisations/org-sunrise/dashboard")).status === 404);
  check("Other organisation cannot read floor plan", (await api(other, "/api/floorplans/FP-sample-plant2")).status === 404);
  const govList = (await api(gov, "/api/requests")).data.requests;
  check("Government sees shared org + citizen requests", govList.some((r) => r.id === reqId) && govList.some((r) => r.isSample));
  check("Employee cannot edit floor plans", (await api(emp, "/api/floorplans/FP-sample-plant2", { method: "PUT", body: { nodes: [], edges: [] } })).status === 403);
  const citSos = await api(cit, "/api/requests", { method: "POST", body: { clientId: cid(), category: "flood", description: "e2e citizen", latitude: 28.62, longitude: 77.21 } });
  check("Citizen SOS goes to government feed", citSos.status === 201 && (await api(gov, "/api/requests")).data.requests.some((r) => r.id === citSos.data.request.id));
  check("Citizen SOS not visible to factory officer", !(await api(off, "/api/requests")).data.requests.some((r) => r.id === citSos.data.request.id));

  // ---- SafeRoute
  const plan = await api(emp, "/api/evacuation-plans/EVP-sample-fire/calculate-route", { method: "POST", body: {} });
  check("Fire plan route computed on sample floor plan", plan.data.route.ok, plan.data.route.ok && plan.data.route.path.join(">"));
  const firstEdge = plan.data.route.edges[2];
  const blocked = await api(emp, "/api/evacuation-plans/EVP-sample-fire/calculate-route", { method: "POST", body: { blockedEdges: [firstEdge] } });
  check("Blocked corridor -> alternative route", blocked.data.route.ok && !blocked.data.route.edges.includes(firstEdge), blocked.data.route.ok && blocked.data.route.path.join(">"));
  const cut = await api(emp, "/api/evacuation-plans/EVP-sample-fire/calculate-route", { method: "POST", body: { blockedEdges: ["D_A--R_A"] } });
  check("Fully cut off -> clear 'no route' warning", cut.data.route.ok === false, cut.data.route.reason);

  // ---- Maps
  const search = await api(cit, "/api/maps/places/search?q=hospital&lat=28.6230&lon=77.2140");
  check("Offline hospital search (FTS5)", search.data.places.length > 5, search.data.places.slice(0, 2).map((p) => p.name).join("; "));
  const rml = search.data.places.find((p) => /Lohia/.test(p.name));
  const route = await api(cit, `/api/maps/route?fromLat=28.6230&fromLon=77.2140&toLat=${rml.lat}&toLon=${rml.lon}`);
  check("Road route on local OSM graph", route.data.ok, `${route.data.distanceMetres} m, ${route.data.coords && route.data.coords.length} pts, ${route.data.computeMs} ms`);
  const avoid = await api(cit, `/api/maps/route?fromLat=28.6230&fromLon=77.2140&toLat=${rml.lat}&toLon=${rml.lon}&avoidFlood=1`);
  check("Avoid-flood route avoids hazard", avoid.data.ok && !avoid.data.crossesFloodZone && route.data.crossesFloodZone, `${avoid.data.distanceMetres} m`);

  offWs.ws.close(); empWs.ws.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
