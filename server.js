require("dotenv").config();
const http = require("http");
const path = require("path");
const express = require("express");

const { authenticate } = require("./src/auth");
const { seed } = require("./src/seed");
const maps = require("./src/maps");
const rt = require("./src/realtime");
const connect = require("./src/routes/connect");
const core = require("./src/routes/core");

const PORT = Number(process.env.PORT || 3000);
// 0.0.0.0 so phones on the same hotspot/router can reach the laptop. Use HOST=127.0.0.1 for local-only.
const HOST = process.env.HOST || "0.0.0.0";

seed();
const mapStatus = maps.load();

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(self), microphone=(self)");
  next();
});

app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h" }));
// Front-end libraries are served from node_modules so nothing is fetched from a CDN at runtime.
const vendor = {
  leaflet: "leaflet/dist", pmtiles: "pmtiles/dist", "protomaps-leaflet": "protomaps-leaflet/dist",
  pdfjs: "pdfjs-dist/build", lucide: "lucide/dist/umd", three: "three/build", gsap: "gsap/dist",
};
for (const [name, dir] of Object.entries(vendor)) {
  app.use(`/vendor/${name}`, express.static(path.join(__dirname, "node_modules", dir), { maxAge: "7d" }));
}
// PMTiles needs HTTP range requests — express.static supports them.
app.use("/maps", express.static(path.join(__dirname, "data", "maps"), { maxAge: "1d", index: false,
  setHeaders: (res) => res.setHeader("Accept-Ranges", "bytes") }));

app.use(authenticate);
// JSON parsing for everything except the streamed ZIM upload.
app.use("/api", (req, res, next) => (req.path === "/ai/sources/upload" ? next() : express.json({ limit: "1mb" })(req, res, next)));
app.use("/api", connect.router);
app.use("/api", core.router);
app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

const PAGES = {
  "/": ["overview", "Overview"],
  "/login": ["login", "Sign in"],
  "/organisation": ["organisation", "Organisation"],
  "/saferoute": ["saferoute", "SafeRoute"],
  "/connect": ["connect", "Connect"],
  "/assistant": ["assistant", "AI Assistant"],
  "/map": ["map", "Offline Map"],
  "/government": ["government", "Government"],
  "/knowledge": ["knowledge", "Knowledge Sources"],
  "/settings": ["settings", "Settings"],
};
for (const [route, [view, title]] of Object.entries(PAGES)) {
  app.get(route, (req, res) => res.render(`pages/${view}`, { page: view, title }));
}
app.use((_req, res) => res.status(404).render("pages/notfound", { page: "notfound", title: "Not found" }));

// Never leak stack traces or file paths to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const status = err.status || (err.code === "LIMIT_FILE_SIZE" ? 413 : err.type === "entity.parse.failed" ? 400 : 500);
  if (status >= 500) console.error("[error]", err);
  const message = err.code === "LIMIT_FILE_SIZE" ? "File too large." : status < 500 ? (err.expose ? err.message : "Bad request.") : "Internal server error.";
  if (req.path.startsWith("/api")) return res.status(status).json({ error: message });
  res.status(status).send(message);
});

const server = http.createServer(app);
rt.attach(server);
server.listen(PORT, HOST, () => {
  console.log(`OfflineAid running on http://localhost:${PORT}`);
  core.lanAddresses().forEach((ip) => console.log(`  LAN: http://${ip}:${PORT}  (open this on phones on the same Wi-Fi/hotspot)`));
  console.log(`  Map package: tiles=${mapStatus.tiles} graph=${mapStatus.graph} pois=${mapStatus.pois} flood=${mapStatus.flood}`);
  console.log(`  AI service expected at ${process.env.PYTHON_API_URL || "http://127.0.0.1:8000"}`);
});

function shutdown() {
  console.log("Shutting down OfflineAid...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
