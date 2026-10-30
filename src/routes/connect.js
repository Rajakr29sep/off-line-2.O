// OfflineAid Connect: SOS requests, official alerts, two-way messages, delivery states and offline sync.
//
// Delivery states (sender's perspective):
//   STORED_LOCALLY / QUEUED  -> only on the sender device (IndexedDB), never set by the server
//   RELAYED                  -> accepted and persisted by this local server
//   RECEIVED                 -> rendered on the recipient's screen (recipient device posts a receipt)
//   ACKNOWLEDGED             -> recipient explicitly responded
const express = require("express");
const { db, all, get, run, now, newId, tx, audit } = require("../db");
const { requireAuth, requirePermission, can, rateLimit } = require("../auth");
const rt = require("../realtime");

const router = express.Router();
const CATEGORIES = ["fire", "medical", "earthquake", "flood", "building_collapse", "rescue", "other"];
const REQUEST_STATUSES = ["OPEN", "IN_PROGRESS", "RESOLVED"];
const RESPONSES = { SAFE: "I am safe", NEED_HELP: "I need help", NEED_EVACUATION: "I need evacuation", UPDATE: "Update" };
const STAFF = ["officer", "administrator"];
const ORDER = { RELAYED: 1, RECEIVED: 2, ACKNOWLEDGED: 3 };

const str = (v, max) => (v == null ? "" : String(v).trim().slice(0, max));
const validClientId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(v);
const advance = (current, next) => (ORDER[next] > (ORDER[current] || 0) ? next : current);

function mapRequest(r) {
  return r && {
    id: r.id, clientId: r.client_id, organisationId: r.organisation_id, organisationName: r.organisation_name || null,
    senderId: r.sender_id, senderName: r.sender_name, senderRole: r.sender_role, senderJob: r.sender_job,
    category: r.category, description: r.description, peopleAffected: r.people_affected,
    latitude: r.latitude, longitude: r.longitude, floorId: r.floor_id, zoneId: r.zone_id,
    status: r.status, deliveryStatus: r.delivery_status, createdAt: r.created_at, clientCreatedAt: r.client_created_at,
    receivedAt: r.received_at, acknowledgedAt: r.acknowledged_at, acknowledgedBy: r.acknowledged_by,
    updatedAt: r.updated_at, isSample: !!r.is_sample,
  };
}

function mapMessage(m) {
  return m && {
    id: m.id, clientId: m.client_id, requestId: m.request_id, alertId: m.alert_id, senderId: m.sender_id,
    senderName: m.sender_name, senderRole: m.sender_role, recipientId: m.recipient_id, messageType: m.message_type,
    payload: JSON.parse(m.payload), deliveryStatus: m.delivery_status, createdAt: m.created_at,
    receivedAt: m.received_at, acknowledgedAt: m.acknowledged_at, retryCount: m.retry_count,
  };
}

const REQUEST_SELECT = `SELECT r.*, o.name AS organisation_name FROM emergency_requests r
  LEFT JOIN organisations o ON o.id = r.organisation_id`;

// Organisation isolation lives here — every request read goes through this check.
function canReadRequest(user, r) {
  if (!r) return false;
  if (r.sender_id === user.id) return true;
  if (STAFF.includes(user.role)) return r.organisation_id === user.organisation_id;
  if (user.role === "government_operator") {
    if (!r.organisation_id) return true;
    const org = get("SELECT share_with_government FROM organisations WHERE id = ?", r.organisation_id);
    return !!(org && org.share_with_government);
  }
  return false;
}
const canManageRequest = (user, r) => r && r.sender_id !== user.id && canReadRequest(user, r)
  && (STAFF.includes(user.role) || user.role === "government_operator");

function notifyRequestWatchers(r, event) {
  if (r.organisation_id) rt.toOrgRoles(r.organisation_id, STAFF, event);
  // Same visibility rule as canReadRequest: government only sees citizen requests and orgs that opted in.
  const shared = !r.organisation_id || (get("SELECT share_with_government FROM organisations WHERE id = ?", r.organisation_id) || {}).share_with_government;
  if (shared) rt.toRole("government_operator", event);
  rt.toUser(r.sender_id, event);
}

// ---------------------------------------------------------------- Requests
function createRequest(user, body) {
  if (!validClientId(body.clientId)) throw httpError(400, "clientId (8-64 chars) is required for idempotent delivery.");
  const existing = get(`${REQUEST_SELECT} WHERE r.client_id = ?`, body.clientId);
  if (existing) {
    if (existing.sender_id !== user.id) throw httpError(409, "clientId already used.");
    return { request: mapRequest(existing), duplicate: true };
  }
  const category = str(body.category, 30).toLowerCase();
  if (!CATEGORIES.includes(category)) throw httpError(400, `category must be one of ${CATEGORIES.join(", ")}`);
  const people = Math.max(1, Math.min(10000, parseInt(body.peopleAffected, 10) || 1));
  const lat = body.latitude === "" || body.latitude == null ? null : Number(body.latitude);
  const lon = body.longitude === "" || body.longitude == null ? null : Number(body.longitude);
  if ((lat != null && !(lat >= -90 && lat <= 90)) || (lon != null && !(lon >= -180 && lon <= 180))) {
    throw httpError(400, "Invalid GPS coordinates.");
  }
  const t = now();
  const id = newId("REQ");
  run(`INSERT INTO emergency_requests (id, client_id, organisation_id, sender_id, sender_name, sender_role, sender_job,
      category, description, people_affected, latitude, longitude, floor_id, zone_id, client_created_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, body.clientId, user.organisation_id || null, user.id, user.name, user.role, user.job_title || null, category,
  str(body.description, 1000), people, lat, lon, str(body.floorId, 40) || null, str(body.zoneId, 60) || null,
  str(body.clientCreatedAt, 40) || null, t, t);
  audit(user.id, "request.create", { id, category });
  const r = get(`${REQUEST_SELECT} WHERE r.id = ?`, id);
  notifyRequestWatchers(r, { type: "request.new", request: mapRequest(r) });
  return { request: mapRequest(r), duplicate: false };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const wrap = (fn) => (req, res) => {
  try {
    const out = fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error("[connect]", err);
    res.status(500).json({ error: "Internal error." });
  }
};

router.post("/requests", requirePermission("request:create"), rateLimit("sos", 30, 60000), wrap((req, res) => {
  const out = createRequest(req.user, req.body || {});
  res.status(out.duplicate ? 200 : 201);
  return out;
}));

router.get("/requests", requireAuth, wrap((req) => {
  const u = req.user;
  const status = REQUEST_STATUSES.includes(req.query.status) ? req.query.status : null;
  let rows;
  if (STAFF.includes(u.role)) {
    rows = all(`${REQUEST_SELECT} WHERE r.organisation_id = ? ${status ? "AND r.status = ?" : ""} ORDER BY r.created_at DESC LIMIT 200`,
      ...(status ? [u.organisation_id, status] : [u.organisation_id]));
  } else if (u.role === "government_operator") {
    rows = all(`${REQUEST_SELECT} WHERE (r.organisation_id IS NULL OR o.share_with_government = 1) ${status ? "AND r.status = ?" : ""}
      ORDER BY r.created_at DESC LIMIT 300`, ...(status ? [status] : []));
  } else {
    rows = all(`${REQUEST_SELECT} WHERE r.sender_id = ? ORDER BY r.created_at DESC LIMIT 100`, u.id);
  }
  return { requests: rows.map(mapRequest) };
}));

router.get("/requests/:id", requireAuth, wrap((req) => {
  const r = get(`${REQUEST_SELECT} WHERE r.id = ?`, req.params.id);
  if (!canReadRequest(req.user, r)) throw httpError(404, "Request not found.");
  const messages = all("SELECT * FROM messages WHERE request_id = ? ORDER BY created_at", r.id).map(mapMessage);
  return { request: mapRequest(r), messages };
}));

function markRequest(user, id, target) {
  const r = get(`${REQUEST_SELECT} WHERE r.id = ?`, id);
  if (!canManageRequest(user, r)) throw httpError(404, "Request not found.");
  const next = advance(r.delivery_status, target);
  if (next !== r.delivery_status || (target === "RECEIVED" && !r.received_at)) {
    const t = now();
    run(`UPDATE emergency_requests SET delivery_status = ?, received_at = COALESCE(received_at, ?),
      acknowledged_at = CASE WHEN ? = 'ACKNOWLEDGED' THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END,
      acknowledged_by = CASE WHEN ? = 'ACKNOWLEDGED' THEN COALESCE(acknowledged_by, ?) ELSE acknowledged_by END,
      updated_at = ? WHERE id = ?`, next, t, next, t, next, `${user.name} (${user.role})`, t, id);
  }
  const updated = get(`${REQUEST_SELECT} WHERE r.id = ?`, id);
  notifyRequestWatchers(updated, { type: "request.updated", request: mapRequest(updated) });
  return updated;
}

router.post("/requests/:id/received", requireAuth, wrap((req) => ({ request: mapRequest(markRequest(req.user, req.params.id, "RECEIVED")) })));
router.post("/requests/:id/acknowledge", requireAuth, wrap((req) => {
  const r = markRequest(req.user, req.params.id, "ACKNOWLEDGED");
  audit(req.user.id, "request.acknowledge", { id: r.id });
  return { request: mapRequest(r) };
}));

router.patch("/requests/:id/status", requireAuth, wrap((req) => {
  const r = get(`${REQUEST_SELECT} WHERE r.id = ?`, req.params.id);
  if (!canManageRequest(req.user, r)) throw httpError(404, "Request not found.");
  const status = str(req.body.status, 20).toUpperCase();
  if (!REQUEST_STATUSES.includes(status)) throw httpError(400, `status must be one of ${REQUEST_STATUSES.join(", ")}`);
  run("UPDATE emergency_requests SET status = ?, updated_at = ? WHERE id = ?", status, now(), r.id);
  audit(req.user.id, "request.status", { id: r.id, status });
  return { request: mapRequest(markRequest(req.user, r.id, "ACKNOWLEDGED")) };
}));

// ---------------------------------------------------------------- Alerts
function mapAlert(a, recipient) {
  return a && {
    id: a.id, clientId: a.client_id, organisationId: a.organisation_id, senderId: a.sender_id, senderName: a.sender_name,
    senderRole: a.sender_role, title: a.title, message: a.message, category: a.category, severity: a.severity,
    requestId: a.request_id, evacuationPlanId: a.evacuation_plan_id, createdAt: a.created_at, status: a.status,
    ...(recipient ? { deliveryStatus: recipient.delivery_status, receivedAt: recipient.received_at,
      acknowledgedAt: recipient.acknowledged_at, response: recipient.response } : {}),
  };
}

function alertSummary(alertId) {
  const rows = all(`SELECT ar.*, u.name FROM alert_recipients ar JOIN users u ON u.id = ar.user_id WHERE alert_id = ?`, alertId);
  return {
    recipients: rows.map((r) => ({ userId: r.user_id, name: r.name, deliveryStatus: r.delivery_status, receivedAt: r.received_at,
      acknowledgedAt: r.acknowledged_at, response: r.response, retryCount: r.retry_count })),
    counts: rows.reduce((acc, r) => { acc[r.delivery_status] = (acc[r.delivery_status] || 0) + 1; return acc; }, {}),
  };
}

router.post("/alerts", requirePermission("alert:send"), rateLimit("alerts", 30, 60000), wrap((req, res) => {
  const u = req.user, b = req.body || {};
  if (!validClientId(b.clientId)) throw httpError(400, "clientId is required.");
  const dup = get("SELECT * FROM alerts WHERE client_id = ?", b.clientId);
  if (dup) return { alert: { ...mapAlert(dup), ...alertSummary(dup.id) }, duplicate: true };
  const title = str(b.title, 120), message = str(b.message, 1500);
  if (!title || !message) throw httpError(400, "title and message are required.");
  const category = CATEGORIES.includes(b.category) ? b.category : "other";
  const severity = ["critical", "warning", "info"].includes(b.severity) ? b.severity : "critical";
  let recipients = all("SELECT id FROM users WHERE organisation_id = ? AND role = 'employee'", u.organisation_id).map((r) => r.id);
  if (Array.isArray(b.recipientIds) && b.recipientIds.length) recipients = recipients.filter((id) => b.recipientIds.includes(id));
  if (!recipients.length) throw httpError(400, "No employees in your organisation to alert.");
  if (b.requestId) {
    const r = get("SELECT organisation_id FROM emergency_requests WHERE id = ?", b.requestId);
    if (!r || r.organisation_id !== u.organisation_id) throw httpError(400, "Linked request not found in your organisation.");
  }
  if (b.evacuationPlanId) {
    const p = get("SELECT organisation_id FROM evacuation_plans WHERE id = ?", b.evacuationPlanId);
    if (!p || p.organisation_id !== u.organisation_id) throw httpError(400, "Evacuation plan not found in your organisation.");
  }
  const id = newId("ALT");
  const t = now();
  tx(() => {
    run(`INSERT INTO alerts (id, client_id, organisation_id, sender_id, sender_name, sender_role, title, message, category, severity,
      request_id, evacuation_plan_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, b.clientId, u.organisation_id, u.id, u.name, u.role, title, message, category, severity,
    b.requestId || null, b.evacuationPlanId || null, t);
    const ins = db.prepare("INSERT INTO alert_recipients (alert_id, user_id, last_retry_at) VALUES (?,?,?)");
    recipients.forEach((rid) => ins.run(id, rid, t));
    if (severity === "critical") run("UPDATE organisations SET emergency_status = 'EMERGENCY' WHERE id = ?", u.organisation_id);
  });
  audit(u.id, "alert.send", { id, recipients: recipients.length });
  const a = get("SELECT * FROM alerts WHERE id = ?", id);
  recipients.forEach((rid) => rt.toUser(rid, { type: "alert.new", alert: mapAlert(a, { delivery_status: "RELAYED" }) }));
  rt.toOrgRoles(u.organisation_id, STAFF, { type: "alert.updated", alert: { ...mapAlert(a), ...alertSummary(id) } });
  res.status(201);
  return { alert: { ...mapAlert(a), ...alertSummary(id) } };
}));

router.get("/alerts", requireAuth, wrap((req) => {
  const u = req.user;
  if (STAFF.includes(u.role)) {
    const alerts = all("SELECT * FROM alerts WHERE organisation_id = ? ORDER BY created_at DESC LIMIT 50", u.organisation_id);
    return { alerts: alerts.map((a) => ({ ...mapAlert(a), ...alertSummary(a.id) })) };
  }
  const rows = all(`SELECT a.*, ar.delivery_status, ar.received_at, ar.acknowledged_at, ar.response FROM alert_recipients ar
    JOIN alerts a ON a.id = ar.alert_id WHERE ar.user_id = ? ORDER BY a.created_at DESC LIMIT 50`, u.id);
  return { alerts: rows.map((r) => mapAlert(r, r)) };
}));

function updateRecipient(user, alertId, target, response) {
  const rec = get("SELECT * FROM alert_recipients WHERE alert_id = ? AND user_id = ?", alertId, user.id);
  if (!rec) throw httpError(404, "Alert not found.");
  const t = now();
  const next = advance(rec.delivery_status, target);
  run(`UPDATE alert_recipients SET delivery_status = ?, received_at = COALESCE(received_at, ?),
    acknowledged_at = CASE WHEN ? = 'ACKNOWLEDGED' THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END,
    response = COALESCE(?, response) WHERE alert_id = ? AND user_id = ?`, next, t, next, t, response || null, alertId, user.id);
  const a = get("SELECT * FROM alerts WHERE id = ?", alertId);
  rt.toOrgRoles(a.organisation_id, STAFF, { type: "alert.updated", alert: { ...mapAlert(a), ...alertSummary(alertId) } });
  const r = get("SELECT * FROM alert_recipients WHERE alert_id = ? AND user_id = ?", alertId, user.id);
  return mapAlert(a, r);
}

router.post("/alerts/:id/received", requireAuth, wrap((req) => ({ alert: updateRecipient(req.user, req.params.id, "RECEIVED") })));

function respondToAlert(user, alertId, body) {
  const code = str(body.response, 20).toUpperCase();
  if (!RESPONSES[code]) throw httpError(400, `response must be one of ${Object.keys(RESPONSES).join(", ")}`);
  if (!validClientId(body.clientId)) throw httpError(400, "clientId is required.");
  const dup = get("SELECT * FROM messages WHERE client_id = ?", body.clientId);
  if (dup) return { message: mapMessage(dup), duplicate: true };
  const alert = updateRecipient(user, alertId, "ACKNOWLEDGED", code);
  const safety = { SAFE: "SAFE", NEED_HELP: "NEEDS_HELP", NEED_EVACUATION: "NEEDS_EVACUATION" }[code];
  if (safety) run("UPDATE users SET safety_status = ?, safety_updated_at = ? WHERE id = ?", safety, now(), user.id);
  const msg = insertMessage(user, {
    clientId: body.clientId, alertId, recipientId: null, messageType: "response",
    payload: { response: code, label: RESPONSES[code], note: str(body.note, 500), alertTitle: alert.title },
    clientCreatedAt: body.clientCreatedAt,
  });
  return { alert, message: msg, duplicate: false };
}

router.post("/alerts/:id/respond", requirePermission("alert:respond"), wrap((req) => respondToAlert(req.user, req.params.id, req.body || {})));

// ---------------------------------------------------------------- Messages
function insertMessage(user, { clientId, requestId = null, alertId = null, recipientId = null, messageType, payload, clientCreatedAt }) {
  const id = newId("MSG");
  run(`INSERT INTO messages (id, client_id, organisation_id, request_id, alert_id, sender_id, sender_name, sender_role,
    recipient_id, message_type, payload, client_created_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  id, clientId, user.organisation_id || null, requestId, alertId, user.id, user.name, user.role, recipientId, messageType,
  JSON.stringify(payload), str(clientCreatedAt, 40) || null, now());
  const m = mapMessage(get("SELECT * FROM messages WHERE id = ?", id));
  if (recipientId) rt.toUser(recipientId, { type: "message.new", message: m });
  else if (user.organisation_id) rt.toOrgRoles(user.organisation_id, STAFF, { type: "message.new", message: m });
  rt.toUser(user.id, { type: "message.updated", message: m });
  return m;
}

function createMessage(user, b) {
  if (!validClientId(b.clientId)) throw httpError(400, "clientId is required.");
  const dup = get("SELECT * FROM messages WHERE client_id = ?", b.clientId);
  if (dup) return { message: mapMessage(dup), duplicate: true };
  const text = str(b.text, 1000);
  if (!text) throw httpError(400, "text is required.");
  const r = b.requestId ? get(`${REQUEST_SELECT} WHERE r.id = ?`, b.requestId) : null;
  if (!r || !canReadRequest(user, r)) throw httpError(404, "Request not found.");
  const fromStaff = r.sender_id !== user.id;
  if (fromStaff && !can(user, "message:send") && user.role !== "government_operator") throw httpError(403, "Not allowed.");
  const message = insertMessage(user, {
    clientId: b.clientId, requestId: r.id, recipientId: fromStaff ? r.sender_id : null,
    messageType: fromStaff ? "instruction" : "update", payload: { text }, clientCreatedAt: b.clientCreatedAt,
  });
  if (fromStaff) markRequest(user, r.id, "ACKNOWLEDGED");
  return { message, duplicate: false };
}

router.post("/messages", requireAuth, rateLimit("messages", 60, 60000), wrap((req, res) => {
  const out = createMessage(req.user, req.body || {});
  res.status(out.duplicate ? 200 : 201);
  return out;
}));

function canReceiveMessage(user, m) {
  if (m.recipient_id) return m.recipient_id === user.id;
  return STAFF.includes(user.role) && m.organisation_id === user.organisation_id && m.sender_id !== user.id;
}

function markMessage(user, id, target) {
  const m = get("SELECT * FROM messages WHERE id = ?", id);
  if (!m || !canReceiveMessage(user, m)) throw httpError(404, "Message not found.");
  const next = advance(m.delivery_status, target);
  const t = now();
  run(`UPDATE messages SET delivery_status = ?, received_at = COALESCE(received_at, ?),
    acknowledged_at = CASE WHEN ? = 'ACKNOWLEDGED' THEN COALESCE(acknowledged_at, ?) ELSE acknowledged_at END WHERE id = ?`,
  next, t, next, t, id);
  const updated = mapMessage(get("SELECT * FROM messages WHERE id = ?", id));
  rt.toUser(m.sender_id, { type: "message.updated", message: updated });
  if (m.organisation_id) rt.toOrgRoles(m.organisation_id, STAFF, { type: "message.updated", message: updated });
  return updated;
}

router.post("/messages/:id/received", requireAuth, wrap((req) => ({ message: markMessage(req.user, req.params.id, "RECEIVED") })));
router.post("/messages/:id/acknowledge", requireAuth, wrap((req) => ({ message: markMessage(req.user, req.params.id, "ACKNOWLEDGED") })));

router.get("/messages", requireAuth, wrap((req) => {
  const u = req.user;
  const rows = STAFF.includes(u.role)
    ? all("SELECT * FROM messages WHERE organisation_id = ? ORDER BY created_at DESC LIMIT 200", u.organisation_id)
    : all("SELECT * FROM messages WHERE sender_id = ? OR recipient_id = ? ORDER BY created_at DESC LIMIT 200", u.id, u.id);
  return { messages: rows.map(mapMessage) };
}));

// Server-side outbox: everything addressed to this user that has not yet been confirmed RECEIVED.
// Each poll counts as a delivery retry so the officer can see retry counts for unreachable devices.
router.get("/messages/pending", requireAuth, wrap((req) => {
  const u = req.user;
  const t = now();
  const alerts = all(`SELECT a.*, ar.delivery_status, ar.received_at, ar.acknowledged_at, ar.response FROM alert_recipients ar
    JOIN alerts a ON a.id = ar.alert_id WHERE ar.user_id = ? AND ar.delivery_status = 'RELAYED'`, u.id);
  if (alerts.length) run(`UPDATE alert_recipients SET retry_count = retry_count + 1, last_retry_at = ? WHERE user_id = ? AND delivery_status = 'RELAYED'`, t, u.id);
  const messages = all("SELECT * FROM messages WHERE recipient_id = ? AND delivery_status = 'RELAYED'", u.id);
  if (messages.length) run("UPDATE messages SET retry_count = retry_count + 1, last_retry_at = ? WHERE recipient_id = ? AND delivery_status = 'RELAYED'", t, u.id);
  let requests = [], orgMessages = [];
  if (STAFF.includes(u.role)) {
    requests = all(`${REQUEST_SELECT} WHERE r.organisation_id = ? AND r.delivery_status = 'RELAYED'`, u.organisation_id);
    orgMessages = all("SELECT * FROM messages WHERE organisation_id = ? AND recipient_id IS NULL AND sender_id != ? AND delivery_status = 'RELAYED'", u.organisation_id, u.id);
  } else if (u.role === "government_operator") {
    requests = all(`${REQUEST_SELECT} WHERE r.organisation_id IS NULL AND r.delivery_status = 'RELAYED'`);
  }
  return {
    alerts: alerts.map((a) => mapAlert(a, a)), messages: [...messages, ...orgMessages].map(mapMessage),
    requests: requests.map(mapRequest), serverTime: t,
  };
}));

// Batch sync of items queued in the browser's IndexedDB while offline. Idempotent on clientId.
router.post("/messages/sync", requireAuth, rateLimit("sync", 30, 60000), wrap((req) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
  const results = items.map((item) => {
    try {
      const p = { ...(item.payload || {}), clientId: item.clientId, clientCreatedAt: item.clientCreatedAt };
      if (item.kind === "sos") {
        if (!can(req.user, "request:create")) throw httpError(403, "Not allowed.");
        const out = createRequest(req.user, p);
        return { clientId: item.clientId, ok: true, kind: "sos", serverId: out.request.id, deliveryStatus: out.request.deliveryStatus, duplicate: out.duplicate };
      }
      if (item.kind === "alert_response") {
        const out = respondToAlert(req.user, p.alertId, p);
        return { clientId: item.clientId, ok: true, kind: item.kind, serverId: out.message.id, deliveryStatus: out.message.deliveryStatus, duplicate: out.duplicate };
      }
      if (item.kind === "message") {
        const out = createMessage(req.user, p);
        return { clientId: item.clientId, ok: true, kind: item.kind, serverId: out.message.id, deliveryStatus: out.message.deliveryStatus, duplicate: out.duplicate };
      }
      throw httpError(400, "Unknown item kind.");
    } catch (err) {
      return { clientId: item.clientId, ok: false, error: err.status ? err.message : "Internal error.", permanent: !!err.status && err.status < 500 };
    }
  });
  return { results, serverTime: now() };
}));

module.exports = { router, mapRequest, CATEGORIES };
