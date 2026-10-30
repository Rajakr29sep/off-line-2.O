// WebSocket push hub. State changes go through REST (persisted in SQLite first);
// WebSocket only notifies connected clients. Clients re-sync via /api/messages/pending on (re)connect,
// so nothing is lost if a socket is down when an event is published.
const { WebSocketServer } = require("ws");
const { userFromToken, extractToken } = require("./auth");

const sockets = new Map(); // userId -> Set<ws>
let wss;

function attach(server) {
  wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://local");
    const user = userFromToken(url.searchParams.get("token") || extractToken(req));
    if (!user) {
      ws.close(4401, "unauthorised");
      return;
    }
    ws.user = { id: user.id, role: user.role, organisationId: user.organisation_id };
    ws.isAlive = true;
    if (!sockets.has(user.id)) sockets.set(user.id, new Set());
    sockets.get(user.id).add(ws);
    ws.on("pong", () => { ws.isAlive = true; });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong", at: Date.now() }));
      } catch { /* ignore malformed frames */ }
    });
    ws.on("close", () => {
      const set = sockets.get(user.id);
      if (set) { set.delete(ws); if (!set.size) sockets.delete(user.id); }
    });
    ws.send(JSON.stringify({ type: "hello", userId: user.id, at: new Date().toISOString() }));
  });
  // Heartbeat: drop dead connections so presence is accurate.
  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, 15000).unref();
}

function send(ws, event) {
  if (ws.readyState === 1) ws.send(JSON.stringify(event));
}

function toUser(userId, event) {
  (sockets.get(userId) || []).forEach((ws) => send(ws, event));
}

function toOrgRoles(orgId, roles, event) {
  if (!wss) return;
  wss.clients.forEach((ws) => {
    if (ws.user && ws.user.organisationId === orgId && roles.includes(ws.user.role)) send(ws, event);
  });
}

function toRole(role, event) {
  if (!wss) return;
  wss.clients.forEach((ws) => { if (ws.user && ws.user.role === role) send(ws, event); });
}

const isOnline = (userId) => sockets.has(userId);
const connectionCount = () => (wss ? wss.clients.size : 0);

module.exports = { attach, toUser, toOrgRoles, toRole, isOnline, connectionCount };
