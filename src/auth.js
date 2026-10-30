// PIN/token authentication, role permissions and organisation isolation.
const crypto = require("crypto");
const { get, run, now } = require("./db");

const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);

const PERMISSIONS = {
  employee: ["request:create", "request:read_own", "alert:read_own", "alert:respond", "map:read", "ai:ask"],
  officer: ["request:create", "request:read_org", "request:update", "alert:send", "alert:read_org", "message:send",
    "floorplan:read", "plan:read", "map:read", "ai:ask", "org:read"],
  administrator: ["request:create", "request:read_org", "request:update", "alert:send", "alert:read_org", "message:send",
    "floorplan:read", "floorplan:write", "plan:read", "plan:write", "map:read", "ai:ask", "ai:sources", "org:read"],
  citizen: ["request:create", "request:read_own", "map:read", "ai:ask"],
  government_operator: ["request:read_shared", "request:update_shared", "map:read", "ai:ask", "gov:read"],
};

function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(pin), salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, "hex"));
}

const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  run("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)", tokenHash(token), userId, now(), expires);
  run("DELETE FROM sessions WHERE expires_at < ?", now());
  return { token, expiresAt: expires };
}

function destroySession(token) {
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", tokenHash(token));
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, jobTitle: u.job_title,
    organisationId: u.organisation_id, organisationName: u.organisation_name || null,
    facilityName: u.facility_name || null, safetyStatus: u.safety_status,
    permissions: PERMISSIONS[u.role] || [],
  };
}

function userFromToken(token) {
  if (!token) return null;
  const row = get(`SELECT u.*, o.name AS organisation_name, o.facility_name FROM sessions s
    JOIN users u ON u.id = s.user_id LEFT JOIN organisations o ON o.id = u.organisation_id
    WHERE s.token_hash = ? AND s.expires_at > ?`, tokenHash(token), now());
  return row || null;
}

function extractToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  const cookie = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith("oa_token="));
  return cookie ? decodeURIComponent(cookie.slice(9)) : null;
}

function authenticate(req, _res, next) {
  req.token = extractToken(req);
  req.user = userFromToken(req.token);
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  next();
}

const can = (user, perm) => !!user && (PERMISSIONS[user.role] || []).includes(perm);

function requirePermission(...perms) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required." });
    if (!perms.some((p) => can(req.user, p))) return res.status(403).json({ error: "You do not have permission for this action." });
    next();
  };
}

// Simple fixed-window in-memory rate limiter (per IP + bucket).
const buckets = new Map();
function rateLimit(name, max, windowMs) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const t = Date.now();
    const b = buckets.get(key);
    if (!b || t - b.start > windowMs) {
      buckets.set(key, { start: t, count: 1 });
      return next();
    }
    if (++b.count > max) return res.status(429).json({ error: "Too many requests. Please wait a moment." });
    next();
  };
}

module.exports = {
  PERMISSIONS, hashPin, verifyPin, createSession, destroySession, publicUser, userFromToken, extractToken,
  authenticate, requireAuth, requirePermission, can, rateLimit,
};
