/* OfflineAid shared client: auth, API, WebSocket, IndexedDB outbox, UI helpers. */
(function () {
  const OA = (window.OA = {});
  const listeners = {};
  OA.user = null;
  OA.token = localStorage.getItem("oa_token");

  // ---------- helpers ----------
  OA.$ = (sel, root = document) => root.querySelector(sel);
  OA.$$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  OA.esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  OA.icons = () => window.lucide && window.lucide.createIcons();
  // crypto.randomUUID only exists in secure contexts; phones on http://<LAN-IP> are not secure contexts.
  OA.uuid = () => {
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  OA.time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
  OA.ago = (iso) => {
    if (!iso) return "—";
    const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.max(0, s)}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  };
  OA.roleLabel = (r) => ({ employee: "Employee", officer: "Safety Officer", administrator: "Administrator", citizen: "Citizen", government_operator: "Government operator" })[r] || r;
  OA.catLabel = (c) => ({ fire: "Fire", medical: "Medical", earthquake: "Earthquake", flood: "Flood", building_collapse: "Building collapse", rescue: "Rescue", other: "Other", chemical: "Chemical" })[c] || c;
  OA.can = (perm) => !!OA.user && OA.user.permissions.includes(perm);

  OA.toast = (msg, kind = "", ms = 4000) => {
    const host = OA.$("#toastHost");
    if (!host) return;
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), ms);
  };

  OA.on = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  OA.emit = (type, data) => { (listeners[type] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); (listeners["*"] || []).forEach((fn) => fn(type, data)); };

  // ---------- API ----------
  OA.api = async (path, { method = "GET", body, form, timeout = 20000 } = {}) => {
    const headers = {};
    if (OA.token) headers.Authorization = `Bearer ${OA.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(path, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined), signal: ctrl.signal });
    } catch (e) {
      const err = new Error(e.name === "AbortError" ? "Request timed out." : "Cannot reach the OfflineAid server.");
      err.network = true;
      throw err;
    } finally { clearTimeout(timer); }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (res.status === 401 && !path.startsWith("/api/auth/login")) { OA.logout(true); }
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; err.data = data; throw err; }
    return data;
  };

  OA.logout = async (expired) => {
    try { if (!expired && OA.token) await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${OA.token}` } }); } catch { /* offline */ }
    localStorage.removeItem("oa_token");
    localStorage.removeItem("oa_user");
    if (location.pathname !== "/login") location.href = `/login${expired ? "?expired=1" : ""}`;
  };

  // ---------- WebSocket (push only; REST is the source of truth) ----------
  let ws, wsRetry = 0, wsTimer;
  OA.wsState = "connecting";
  function setWs(state) {
    OA.wsState = state;
    const pill = OA.$("#wsPill");
    if (pill) {
      const map = { live: ["online live", "Live link to server"], connecting: ["degraded", "Connecting…"], down: ["offline", "Server unreachable"] };
      pill.className = `pill ${map[state][0]}`;
      pill.innerHTML = `<span class="dot"></span>${map[state][1]}`;
    }
    OA.emit("ws.state", state);
  }
  OA.connectWs = () => {
    if (!OA.token) return;
    clearTimeout(wsTimer);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(OA.token)}`);
    setWs("connecting");
    ws.onopen = () => { wsRetry = 0; setWs("live"); OA.emit("ws.open"); OA.outbox.flush(); };
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); OA.emit(m.type, m); } catch { /* ignore */ } };
    ws.onclose = (ev) => {
      setWs("down");
      if (ev.code === 4401) return OA.logout(true);
      wsTimer = setTimeout(OA.connectWs, Math.min(10000, 1000 * 2 ** wsRetry++));
    };
    ws.onerror = () => ws.close();
  };
  setInterval(() => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "ping" })); }, 20000);

  // ---------- IndexedDB outbox ----------
  // Every outgoing SOS/response is written here FIRST (STORED_LOCALLY), then sent. If the server cannot be
  // reached it stays QUEUED and is retried; the server de-duplicates on clientId so retries are safe.
  const DB_NAME = "offlineaid", STORE = "outbox";
  let dbp;
  function idb() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { const s = req.result.createObjectStore(STORE, { keyPath: "clientId" }); s.createIndex("state", "state"); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbp;
  }
  async function store(mode, fn) {
    const db = await idb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  let flushing = false;
  OA.outbox = {
    async put(item) { await store("readwrite", (s) => s.put(item)); OA.emit("outbox.changed", item); updateOutboxPill(); return item; },
    async all() {
      const items = await store("readonly", (s) => s.getAll());
      return (items || []).filter((i) => !OA.user || i.userId === OA.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async get(clientId) { return store("readonly", (s) => s.get(clientId)); },
    async enqueue(kind, payload) {
      const item = { clientId: OA.uuid(), kind, payload, userId: OA.user.id, state: "STORED_LOCALLY", createdAt: new Date().toISOString(),
        retryCount: 0, lastRetryAt: null, serverId: null, error: null };
      await OA.outbox.put(item);
      OA.outbox.flush();
      return item;
    },
    async flush() {
      if (flushing || !OA.user) return;
      flushing = true;
      try {
        const pending = (await OA.outbox.all()).filter((i) => i.state === "STORED_LOCALLY" || i.state === "QUEUED");
        if (!pending.length) return;
        let res;
        try {
          res = await OA.api("/api/messages/sync", { method: "POST", body: { items: pending.map((i) => ({ kind: i.kind, clientId: i.clientId, clientCreatedAt: i.createdAt, payload: i.payload })) }, timeout: 10000 });
        } catch (e) {
          const t = new Date().toISOString();
          for (const i of pending) { i.state = "QUEUED"; i.retryCount++; i.lastRetryAt = t; i.error = e.message; await OA.outbox.put(i); }
          return;
        }
        for (const r of res.results) {
          const i = pending.find((p) => p.clientId === r.clientId);
          if (!i) continue;
          if (r.ok) { i.state = r.deliveryStatus || "RELAYED"; i.serverId = r.serverId; i.error = null; }
          else if (r.permanent) { i.state = "FAILED"; i.error = r.error; }
          else { i.state = "QUEUED"; i.retryCount++; i.lastRetryAt = new Date().toISOString(); i.error = r.error; }
          await OA.outbox.put(i);
        }
      } finally { flushing = false; }
    },
    // Server pushed a newer delivery state for an item we sent (RECEIVED / ACKNOWLEDGED).
    async updateByServerId(serverId, state) {
      const items = await OA.outbox.all();
      const order = { STORED_LOCALLY: 0, QUEUED: 1, RELAYED: 2, RECEIVED: 3, ACKNOWLEDGED: 4 };
      for (const i of items) {
        if (i.serverId === serverId && (order[state] || 0) > (order[i.state] || 0)) { i.state = state; await OA.outbox.put(i); }
      }
    },
  };
  async function updateOutboxPill() {
    const pill = OA.$("#outboxPill");
    if (!pill || !OA.user) return;
    const n = (await OA.outbox.all()).filter((i) => i.state === "QUEUED" || i.state === "STORED_LOCALLY").length;
    pill.classList.toggle("hidden", n === 0);
    pill.className = `pill warn ${n ? "" : "hidden"}`;
    pill.querySelector("span").textContent = `${n} queued`;
  }
  setInterval(() => OA.outbox.flush(), 5000);
  window.addEventListener("online", () => OA.outbox.flush());

  // ---------- delivery-state timeline ----------
  OA.STATES = ["STORED_LOCALLY", "QUEUED", "RELAYED", "RECEIVED", "ACKNOWLEDGED"];
  OA.timeline = (state, { skipQueued } = {}) => {
    const states = OA.STATES.filter((s) => !(skipQueued && s === "QUEUED" && state !== "QUEUED"));
    const idx = states.indexOf(state);
    return `<div class="timeline">${states.map((s, i) => `${i ? '<span class="arrow">›</span>' : ""}<span class="step ${i < idx ? "done" : i === idx ? "current" : ""}">${s.replace("_", " ")}</span>`).join("")}</div>`;
  };

  // ---------- connectivity pill (internet, informational only) ----------
  async function refreshNet() {
    try {
      const s = await OA.api("/api/system/status", { timeout: 8000 });
      const internet = s.checks.network.internet;
      const pill = OA.$("#netPill");
      if (pill) { pill.className = `pill ${internet ? "info" : "warn"}`; pill.innerHTML = `<span class="dot"></span>${internet ? "Internet available" : "Offline mode · no internet"}`; }
      const foot = OA.$("#footNet");
      if (foot) foot.textContent = s.lan.length ? `LAN: http://${s.lan[0]}:${s.port}` : "No LAN interface";
      OA.emit("system.status", s);
    } catch {
      const pill = OA.$("#netPill");
      if (pill) { pill.className = "pill offline"; pill.innerHTML = '<span class="dot"></span>Server unreachable'; }
    }
  }

  // ---------- page bootstrap ----------
  OA.init = async ({ roles } = {}) => {
    OA.icons();
    OA.$("#menuBtn")?.addEventListener("click", () => OA.$("#sidebar").classList.toggle("open"));
    OA.$("#logoutBtn")?.addEventListener("click", () => OA.logout());
    if (!OA.token) { location.href = "/login"; return new Promise(() => {}); }
    try {
      OA.user = (await OA.api("/api/auth/me")).user;
      localStorage.setItem("oa_user", JSON.stringify(OA.user));
    } catch (e) {
      // Server unreachable: keep working from the cached identity so queued SOS still works.
      if (!e.network) return new Promise(() => {});
      OA.user = JSON.parse(localStorage.getItem("oa_user") || "null");
      if (!OA.user) { location.href = "/login"; return new Promise(() => {}); }
      OA.toast("Server unreachable — working offline. Messages will be queued on this device.", "error", 6000);
    }
    const u = OA.user;
    OA.$("#userName").textContent = u.name;
    OA.$("#userRole").textContent = `${OA.roleLabel(u.role)}${u.organisationName ? " · " + u.organisationName.replace(" (sample)", "") : ""}`;
    OA.$("#userAvatar").textContent = u.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
    const page = document.body.dataset.page;
    OA.$$("#nav [data-roles]").forEach((a) => {
      const allowed = a.dataset.roles === "*" || a.dataset.roles.split(",").includes(u.role);
      a.classList.toggle("hidden", !allowed);
      if (a.dataset.page === page) a.classList.add("active");
    });
    if (roles && !roles.includes(u.role)) {
      OA.$("#content").innerHTML = `<div class="notice danger"><i data-lucide="lock"></i><div><strong>Not available for your role.</strong><br>${OA.esc(OA.roleLabel(u.role))} accounts cannot open this page. Sign in with an authorised account.</div></div>`;
      OA.icons();
      return new Promise(() => {});
    }
    OA.connectWs();
    refreshNet();
    setInterval(refreshNet, 15000);
    updateOutboxPill();
    OA.on("org.status", (m) => setOrgStatus(m.status));
    if (u.organisationId) {
      OA.api(`/api/organisations/${u.organisationId}`).then((d) => setOrgStatus(d.organisation.emergency_status)).catch(() => {});
    }
    return u;
  };
  function setOrgStatus(status) {
    const pill = OA.$("#orgStatusPill");
    if (!pill) return;
    pill.className = `pill ${status === "EMERGENCY" ? "EMERGENCY live" : "NORMAL"}`;
    pill.innerHTML = `<span class="dot"></span>${status === "EMERGENCY" ? "EMERGENCY ACTIVE" : "Normal operations"}`;
  }

  OA.modal = (html) => {
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
    back.addEventListener("click", (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    OA.icons();
    return { el: back.firstChild, close: () => back.remove() };
  };
})();
