/* OfflineAid Connect — employee/citizen SOS + officer dashboard. */
(async function () {
  const user = await OA.init({ roles: ["employee", "citizen", "officer", "administrator"] });
  const { $, esc } = OA;
  const CATS = ["fire", "medical", "earthquake", "flood", "building_collapse", "rescue", "other"];
  const CAT_ICON = { fire: "flame", medical: "heart-pulse", earthquake: "activity", flood: "waves", building_collapse: "building", rescue: "life-buoy", other: "circle-help" };
  const RESP = { SAFE: ["I am safe", "success", "shield-check"], NEED_HELP: ["I need help", "danger", "hand-helping"], NEED_EVACUATION: ["I need evacuation", "warn", "door-open"], UPDATE: ["Send update", "", "message-square"] };
  const isStaff = ["officer", "administrator"].includes(user.role);

  function debounce(fn, ms = 250) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // Short local alarm tone (Web Audio — no network, no files).
  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.35, 0.7].forEach((t) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.2, ctx.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t + 0.3);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.3);
      });
    } catch { /* audio blocked until user gesture */ }
    if (navigator.vibrate) navigator.vibrate([300, 150, 300]);
  }

  if (isStaff) officerView(); else senderView();

  // ================================================================ SENDER (employee / citizen)
  async function senderView() {
    $("#senderView").classList.remove("hidden");
    $("#senderName").textContent = user.name;
    $("#senderOrg").textContent = user.organisationName ? `${user.jobTitle || OA.roleLabel(user.role)} · ${user.organisationName} · ${user.facilityName || ""}` : "Citizen · requests go to the government control room";
    $("#sosTarget").textContent = user.role === "citizen" ? "government control room" : "safety officer";
    let requests = [], alerts = [], messages = [], floorPlans = [];
    let serverOk = true;

    async function load() {
      try {
        const [r, a, m] = await Promise.all([OA.api("/api/requests"), OA.api("/api/alerts"), OA.api("/api/messages")]);
        requests = r.requests; alerts = a.alerts || []; messages = m.messages; serverOk = true;
        const pending = await OA.api("/api/messages/pending");
        for (const al of pending.alerts) await markAlertReceived(al.id, false);
        for (const msg of pending.messages) await OA.api(`/api/messages/${msg.id}/received`, { method: "POST" }).catch(() => {});
        if (pending.alerts.length || pending.messages.length) {
          const a2 = await OA.api("/api/alerts"); alerts = a2.alerts;
          const m2 = await OA.api("/api/messages"); messages = m2.messages;
        }
        // Reconcile outbox items with authoritative server states.
        for (const r2 of requests) await OA.outbox.updateByServerId(r2.id, r2.deliveryStatus);
        for (const m2 of messages) if (m2.senderId === user.id) await OA.outbox.updateByServerId(m2.id, m2.deliveryStatus);
      } catch (e) { serverOk = false; }
      render();
    }
    const reload = debounce(load);

    async function markAlertReceived(id, refresh = true) {
      try { await OA.api(`/api/alerts/${id}/received`, { method: "POST" }); } catch { /* retried via pending */ }
      if (refresh) reload();
    }

    async function render() {
      const items = await OA.outbox.all();
      // Safety status
      const myResponses = alerts.filter((a) => a.response);
      const latest = myResponses[0];
      const safetyMap = { SAFE: ["SAFE", "You reported: safe"], NEED_HELP: ["NEEDS_HELP", "You reported: need help"], NEED_EVACUATION: ["NEEDS_EVACUATION", "You reported: need evacuation"] };
      const sm = latest && safetyMap[latest.response];
      $("#senderSafety").className = `pill ${sm ? sm[0] : "UNKNOWN"}`;
      $("#senderSafety").innerHTML = `<span class="dot"></span>${sm ? sm[1] : "Status unknown"}`;

      // Active alert banner(s)
      const active = alerts.filter((a) => a.status === "ACTIVE");
      $("#alertArea").innerHTML = active.slice(0, 2).map((a) => {
        const pendingResp = items.find((i) => i.kind === "alert_response" && i.payload.alertId === a.id && ["STORED_LOCALLY", "QUEUED"].includes(i.state));
        return `<div class="alert-banner">
          <div class="row between wrap"><span class="pill danger live"><span class="dot"></span>OFFICIAL ALERT · ${esc(a.severity.toUpperCase())}</span><span class="dim" style="font-size:12px">${OA.time(a.createdAt)}</span></div>
          <h3 style="margin-top:10px">${esc(a.title)}</h3>
          <p style="margin-top:6px;white-space:pre-wrap">${esc(a.message)}</p>
          <p class="dim" style="margin-top:8px;font-size:12px">Issued by ${esc(a.senderName)} (${esc(OA.roleLabel(a.senderRole))}) · verified sender</p>
          ${a.evacuationPlanId ? `<a class="btn primary" style="margin-top:10px" href="/saferoute?plan=${encodeURIComponent(a.evacuationPlanId)}"><i data-lucide="route"></i>Show my evacuation route</a>` : ""}
          ${a.response ? `<div class="notice ok" style="margin-top:12px"><i data-lucide="check-circle"></i>You responded “${esc(RESP[a.response][0])}” · ${OA.time(a.acknowledgedAt)}. You can update your status below.</div>` : ""}
          ${pendingResp ? `<div class="notice warn" style="margin-top:12px"><i data-lucide="clock"></i>Your response “${esc(RESP[pendingResp.payload.response][0])}” is ${pendingResp.state.replace("_", " ").toLowerCase()} on this device and will be sent automatically.</div>` : ""}
          <div class="response-grid">${Object.entries(RESP).map(([code, [label, kind, icon]]) => `<button class="btn ${kind} lg" data-resp="${code}" data-alert="${a.id}"><i data-lucide="${icon}"></i>${label}</button>`).join("")}</div>
        </div>`;
      }).join("") + (!serverOk ? '<div class="notice warn"><i data-lucide="wifi-off"></i><div><strong>Cannot reach the OfflineAid server.</strong> SOS and responses are stored on this device and will be sent when the local network returns.</div></div>' : "");
      OA.$$("[data-resp]").forEach((b) => b.addEventListener("click", () => respond(b.dataset.alert, b.dataset.resp)));

      // Alert history
      $("#alertHistory").innerHTML = alerts.length ? alerts.map((a) => `<div class="item">
        <div class="item-head"><strong>${esc(a.title)}</strong><span class="pill ${a.status === "ACTIVE" ? "danger" : ""}">${a.status}</span></div>
        <div class="item-meta">${esc(a.senderName)} · ${OA.time(a.createdAt)}${a.response ? ` · you: ${esc(RESP[a.response][0])}` : ""}</div>
        ${OA.timeline(a.deliveryStatus, { skipQueued: true }).replace("STORED LOCALLY", "SENT")}</div>`).join("") : '<div class="empty">No alerts received.</div>';

      // My requests (outbox + server)
      const rows = [];
      const seen = new Set();
      for (const r of requests) {
        const ob = items.find((i) => i.serverId === r.id || i.clientId === r.clientId);
        if (ob) seen.add(ob.clientId);
        rows.push({ type: "sos", at: r.createdAt, r, state: r.deliveryStatus });
      }
      for (const i of items) {
        if (seen.has(i.clientId)) continue;
        if (i.kind === "sos") rows.push({ type: "sos", at: i.createdAt, local: i, state: i.state });
        if (i.kind === "alert_response") rows.push({ type: "resp", at: i.createdAt, local: i, state: i.state });
      }
      for (const m of messages.filter((m2) => m2.senderId === user.id && m2.messageType === "response")) {
        if (!items.find((i) => i.serverId === m.id)) rows.push({ type: "resp", at: m.createdAt, m, state: m.deliveryStatus });
        else { const i = items.find((x) => x.serverId === m.id); rows.push({ type: "resp", at: m.createdAt, m, state: m.deliveryStatus, local: i }); }
      }
      rows.sort((a, b) => b.at.localeCompare(a.at));
      $("#myItems").innerHTML = rows.length ? rows.map((row) => {
        if (row.type === "sos") {
          const r = row.r, p = r || row.local.payload;
          const instr = r ? messages.filter((m) => m.requestId === r.id && m.messageType === "instruction") : [];
          return `<div class="item">
            <div class="item-head"><i data-lucide="${CAT_ICON[p.category] || "siren"}"></i><strong>SOS · ${esc(OA.catLabel(p.category))}</strong>
              ${r ? `<span class="pill ${r.status}">${r.status.replace("_", " ")}</span><span class="mono dim">${esc(r.id)}</span>` : ""}
              ${row.local && row.local.state === "FAILED" ? '<span class="pill FAILED">REJECTED</span>' : ""}</div>
            <div class="item-meta">${esc(p.description || "No description")} · ${p.peopleAffected || 1} affected · ${OA.time(row.at)}</div>
            ${OA.timeline(row.state)}
            ${row.local && row.local.state === "QUEUED" ? `<div class="item-meta">Retry #${row.local.retryCount} · ${esc(row.local.error || "")}</div>` : ""}
            ${r && r.acknowledgedBy ? `<div class="item-meta">Acknowledged by ${esc(r.acknowledgedBy)} at ${OA.time(r.acknowledgedAt)}</div>` : ""}
            ${instr.map((m) => `<div class="notice info" style="margin-top:8px"><i data-lucide="message-circle"></i><div class="grow"><strong>${esc(m.senderName)}:</strong> ${esc(m.payload.text)}
              <div class="dim" style="font-size:11px">${OA.time(m.createdAt)} · ${m.deliveryStatus}</div></div>
              ${m.deliveryStatus !== "ACKNOWLEDGED" ? `<button class="btn sm" data-ackmsg="${m.id}">Got it</button>` : '<span class="pill ok">ACK</span>'}</div>`).join("")}
          </div>`;
        }
        const p = row.local ? row.local.payload : row.m.payload;
        return `<div class="item"><div class="item-head"><i data-lucide="message-square-reply"></i><strong>Response · ${esc(RESP[p.response] ? RESP[p.response][0] : p.label)}</strong></div>
          <div class="item-meta">${p.note ? esc(p.note) + " · " : ""}${OA.time(row.at)}</div>${OA.timeline(row.state)}</div>`;
      }).join("") : '<div class="empty">No requests yet.</div>';
      OA.$$("[data-ackmsg]").forEach((b) => b.addEventListener("click", async () => {
        try { await OA.api(`/api/messages/${b.dataset.ackmsg}/acknowledge`, { method: "POST" }); reload(); } catch (e) { OA.toast(esc(e.message), "error"); }
      }));
      OA.icons();
    }

    async function respond(alertId, code) {
      let note = "";
      if (code === "UPDATE") {
        note = prompt("Short update for the safety officer:", "") || "";
        if (!note.trim()) return;
      }
      await OA.outbox.enqueue("alert_response", { alertId, response: code, note });
      OA.toast(`Response “${esc(RESP[code][0])}” saved — sending…`, "ok");
      render();
      setTimeout(reload, 600);
    }

    // ---- SOS form ----
    $("#sosBtn").addEventListener("click", async () => {
      if (user.organisationId && !floorPlans.length) {
        try { floorPlans = (await OA.api("/api/floorplans")).floorPlans; } catch { /* offline */ }
      }
      const m = OA.modal(`<div class="stack">
        <div class="row between"><h2 style="color:#fecaca"><i data-lucide="siren"></i> Send SOS</h2><button class="btn ghost sm" data-close>✕</button></div>
        <div class="field"><label>Emergency type</label><div class="chips" id="catChips">${CATS.map((c) => `<button type="button" class="chip" data-cat="${c}"><i data-lucide="${CAT_ICON[c]}"></i>${OA.catLabel(c)}</button>`).join("")}</div></div>
        <div class="grid cols-2" style="gap:10px">
          <div class="field"><label for="sosPeople">People affected</label><input class="input" id="sosPeople" type="number" min="1" max="10000" value="1" /></div>
          ${user.organisationId ? `<div class="field"><label for="sosFloor">Floor</label><select class="input" id="sosFloor"><option value="">Unknown</option>${floorPlans.map((f) => `<option value="${esc(f.id)}">${esc(f.floor)} · ${esc(f.name)}</option>`).join("")}</select></div>` : ""}
        </div>
        ${user.organisationId ? '<div class="field"><label for="sosZone">Zone / room</label><input class="input" id="sosZone" maxlength="60" placeholder="e.g. Assembly Line A" /></div>' : ""}
        <div class="field"><label for="sosDesc">What is happening?</label><textarea class="input" id="sosDesc" maxlength="1000" placeholder="Short description (optional)"></textarea></div>
        <div class="field"><label>Location (optional)</label>
          <div class="row"><input class="input" id="sosLat" placeholder="Latitude" inputmode="decimal" /><input class="input" id="sosLon" placeholder="Longitude" inputmode="decimal" />
          <button type="button" class="btn sm" id="gpsBtn" title="Use GPS"><i data-lucide="locate-fixed"></i></button></div>
          <small class="dim" id="gpsNote">${window.isSecureContext ? "GPS available on this device if permitted." : "Browsers only allow GPS on https or localhost. Enter coordinates manually or describe the location."}</small></div>
        <button class="btn danger lg" id="sosSend" disabled><i data-lucide="send"></i>Send SOS now</button>
      </div>`);
      let category = null;
      m.el.querySelector("[data-close]").addEventListener("click", m.close);
      m.el.querySelectorAll("[data-cat]").forEach((b) => b.addEventListener("click", () => {
        m.el.querySelectorAll("[data-cat]").forEach((x) => x.classList.remove("selected"));
        b.classList.add("selected"); category = b.dataset.cat; m.el.querySelector("#sosSend").disabled = false;
      }));
      m.el.querySelector("#gpsBtn").addEventListener("click", () => {
        if (!navigator.geolocation || !window.isSecureContext) { m.el.querySelector("#gpsNote").textContent = "GPS unavailable here — enter location manually."; return; }
        m.el.querySelector("#gpsNote").textContent = "Locating…";
        navigator.geolocation.getCurrentPosition((pos) => {
          m.el.querySelector("#sosLat").value = pos.coords.latitude.toFixed(6);
          m.el.querySelector("#sosLon").value = pos.coords.longitude.toFixed(6);
          m.el.querySelector("#gpsNote").textContent = `Accuracy ±${Math.round(pos.coords.accuracy)} m`;
        }, (err) => { m.el.querySelector("#gpsNote").textContent = `GPS failed: ${err.message}. Enter manually.`; }, { enableHighAccuracy: true, timeout: 10000 });
      });
      m.el.querySelector("#sosSend").addEventListener("click", async () => {
        const v = (id) => (m.el.querySelector(id) ? m.el.querySelector(id).value.trim() : "");
        const payload = { category, peopleAffected: Number(v("#sosPeople")) || 1, description: v("#sosDesc"),
          latitude: v("#sosLat") || null, longitude: v("#sosLon") || null, floorId: v("#sosFloor") || null, zoneId: v("#sosZone") || null };
        await OA.outbox.enqueue("sos", payload);
        m.close();
        OA.toast("SOS stored on this device — delivering…", "ok");
        render();
        setTimeout(reload, 700);
      });
    });

    OA.on("outbox.changed", debounce(render, 100));
    OA.on("alert.new", (m) => { beep(); OA.toast(`<strong>OFFICIAL ALERT:</strong> ${esc(m.alert.title)}`, "alert", 8000); markAlertReceived(m.alert.id); });
    OA.on("request.updated", async (m) => { await OA.outbox.updateByServerId(m.request.id, m.request.deliveryStatus); reload(); });
    OA.on("message.new", async (m) => { if (m.message.recipientId === user.id) { beep(); OA.toast(`<strong>${esc(m.message.senderName)}:</strong> ${esc(m.message.payload.text || "")}`, "alert", 8000); await OA.api(`/api/messages/${m.message.id}/received`, { method: "POST" }).catch(() => {}); } reload(); });
    OA.on("message.updated", async (m) => { await OA.outbox.updateByServerId(m.message.id, m.message.deliveryStatus); reload(); });
    OA.on("org.status", reload);
    OA.on("ws.open", reload);
    load();
  }

  // ================================================================ OFFICER
  async function officerView() {
    $("#officerView").classList.remove("hidden");
    $("#alertSigner").textContent = `${user.name} (${OA.roleLabel(user.role)})`;
    $("#alertCat").innerHTML = CATS.map((c) => `<option value="${c}">${OA.catLabel(c)}</option>`).join("");
    let requests = [], messages = [], alerts = [], plans = [], dash = null, selected = null;
    const seenIds = new Set(JSON.parse(sessionStorage.getItem("oa_seen") || "[]"));

    try { plans = (await OA.api("/api/evacuation-plans")).plans; } catch { plans = []; }
    $("#alertPlan").innerHTML = '<option value="">None</option>' + plans.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");

    const TEMPLATES = {
      evac: ["FIRE — Evacuate Plant 2 now", "Fire reported. Stop machines, leave by the nearest safe exit shown in OfflineAid and go to your assembly point. Do not use the Paint Shop corridor. Tap “I am safe” when you arrive.", "fire", "critical", "EVP-sample-fire"],
      quake: ["EARTHQUAKE — Drop, cover, hold", "Drop, cover and hold on until shaking stops. Then evacuate calmly using your route and report your status.", "earthquake", "critical", "EVP-sample-quake"],
      clear: ["All clear", "The emergency is over. Return to your work area only when your supervisor confirms.", "other", "info", ""],
    };
    $("#alertTemplate").addEventListener("change", (e) => {
      const t = TEMPLATES[e.target.value];
      if (!t) return;
      [$("#alertTitle").value, $("#alertMsg").value, $("#alertCat").value, $("#alertSev").value] = t;
      $("#alertPlan").value = plans.find((p) => p.id === t[4]) ? t[4] : "";
    });

    async function load() {
      try {
        const status = $("#reqFilter").value;
        const [r, m, a, d] = await Promise.all([
          OA.api(`/api/requests${status ? "?status=" + status : ""}`), OA.api("/api/messages"), OA.api("/api/alerts"),
          OA.api(`/api/organisations/${user.organisationId}/dashboard`),
        ]);
        requests = r.requests; messages = m.messages; alerts = a.alerts; dash = d;
        // Delivery receipts: this dashboard has now displayed these items.
        const pending = await OA.api("/api/messages/pending");
        await Promise.all([
          ...pending.requests.map((x) => OA.api(`/api/requests/${x.id}/received`, { method: "POST" }).catch(() => {})),
          ...pending.messages.map((x) => OA.api(`/api/messages/${x.id}/received`, { method: "POST" }).catch(() => {})),
        ]);
        if (pending.requests.length || pending.messages.length) {
          requests = (await OA.api(`/api/requests${status ? "?status=" + status : ""}`)).requests;
          messages = (await OA.api("/api/messages")).messages;
        }
        render();
        if (selected) openDetail(selected, false);
      } catch (e) { OA.toast(esc(e.message), "error"); }
    }
    const reload = debounce(load);

    function render() {
      const s = dash.stats;
      $("#stActive").textContent = s.activeSos;
      $("#stNeed").textContent = s.needAssistance;
      $("#stSafe").textContent = `${s.safe}/${s.employees}`;
      $("#stOnline").textContent = `${dash.employees.filter((e) => e.online).length}/${s.employees}`;
      const navCount = $("#navSosCount");
      navCount.textContent = s.activeSos; navCount.classList.toggle("hidden", !s.activeSos);

      $("#reqList").innerHTML = requests.length ? requests.map((r) => `<div class="item ${!seenIds.has(r.id) && r.status === "OPEN" ? "new" : ""} ${selected === r.id ? "selected" : ""}" data-req="${r.id}" style="cursor:pointer">
        <div class="item-head"><i data-lucide="${CAT_ICON[r.category] || "siren"}"></i><strong>${esc(OA.catLabel(r.category))}</strong>
          <span class="pill ${r.status}">${r.status.replace("_", " ")}</span><span class="mono dim">${esc(r.id)}</span>${r.isSample ? '<span class="pill sample">SAMPLE</span>' : ""}<span class="grow"></span><span class="dim" style="font-size:12px">${OA.ago(r.createdAt)}</span></div>
        <div class="item-meta"><strong style="color:var(--text)">${esc(r.senderName)}</strong> · ${esc(r.senderJob || OA.roleLabel(r.senderRole))} · ${r.peopleAffected} affected${r.zoneId ? " · " + esc(r.zoneId) : ""}</div>
        <div class="item-meta">${esc(r.description || "No description")}</div>
        ${OA.timeline(r.deliveryStatus, { skipQueued: true }).replace("STORED LOCALLY", "SENT")}
      </div>`).join("") : '<div class="empty">No requests.</div>';
      OA.$$("[data-req]").forEach((el) => el.addEventListener("click", () => openDetail(el.dataset.req)));

      const responses = messages.filter((m) => m.messageType === "response");
      $("#responseList").innerHTML = responses.length ? responses.slice(0, 30).map((m) => `<div class="item">
        <div class="item-head"><span class="pill ${{ SAFE: "SAFE", NEED_HELP: "NEEDS_HELP", NEED_EVACUATION: "NEEDS_EVACUATION" }[m.payload.response] || "info"}">${esc(m.payload.label)}</span><strong>${esc(m.senderName)}</strong><span class="grow"></span><span class="dim" style="font-size:12px">${OA.time(m.createdAt)}</span></div>
        <div class="item-meta">Re: ${esc(m.payload.alertTitle || "alert")}${m.payload.note ? ` · “${esc(m.payload.note)}”` : ""}</div>
        <div class="row between">${OA.timeline(m.deliveryStatus, { skipQueued: true }).replace("STORED LOCALLY", "SENT")}
        ${m.deliveryStatus !== "ACKNOWLEDGED" ? `<button class="btn sm" data-ackresp="${m.id}">Acknowledge</button>` : ""}</div></div>`).join("") : '<div class="empty">No responses yet.</div>';
      OA.$$("[data-ackresp]").forEach((b) => b.addEventListener("click", async () => {
        try { await OA.api(`/api/messages/${b.dataset.ackresp}/acknowledge`, { method: "POST" }); reload(); } catch (e) { OA.toast(esc(e.message), "error"); }
      }));

      $("#alertList").innerHTML = alerts.length ? alerts.slice(0, 10).map((a) => `<div class="item">
        <div class="item-head"><strong>${esc(a.title)}</strong><span class="pill ${a.status === "ACTIVE" ? "danger" : ""}">${a.status}</span><span class="grow"></span><span class="dim" style="font-size:12px">${OA.time(a.createdAt)}</span></div>
        <div class="item-meta">${["RELAYED", "RECEIVED", "ACKNOWLEDGED"].map((k) => `<span class="pill ${k}" style="margin-right:4px">${k} ${a.counts[k] || 0}</span>`).join("")}</div>
        <table class="table" style="margin-top:6px"><tbody>${a.recipients.map((r) => `<tr><td>${esc(r.name)}</td><td><span class="pill ${r.deliveryStatus}">${r.deliveryStatus}</span></td><td class="dim">${r.response ? esc(RESP[r.response][0]) : r.deliveryStatus === "RELAYED" ? `waiting · ${r.retryCount} retries` : OA.time(r.receivedAt)}</td></tr>`).join("")}</tbody></table>
      </div>`).join("") : '<div class="empty">No alerts sent.</div>';

      $("#roster").innerHTML = dash.employees.map((e) => `<div class="item row between"><div><strong>${esc(e.name)}</strong> <span class="dim">· ${esc(e.job_title || "")}</span></div>
        <div class="row"><span class="pill ${e.online ? "online" : "not_configured"}" title="WebSocket connection"><span class="dot"></span>${e.online ? "online" : "offline"}</span><span class="pill ${e.safety_status}">${e.safety_status.replace("_", " ")}</span></div></div>`).join("") || '<div class="empty">No employees.</div>';
      OA.icons();
    }

    async function openDetail(id, markSeen = true) {
      selected = id;
      if (markSeen) { seenIds.add(id); sessionStorage.setItem("oa_seen", JSON.stringify([...seenIds])); }
      let d;
      try { d = await OA.api(`/api/requests/${id}`); } catch (e) { return OA.toast(esc(e.message), "error"); }
      const r = d.request;
      $("#reqDetail").innerHTML = `<div class="panel-head"><i data-lucide="${CAT_ICON[r.category]}"></i><h2>${esc(OA.catLabel(r.category))} · <span class="mono">${esc(r.id)}</span></h2><div class="spacer"></div><span class="pill ${r.status}">${r.status.replace("_", " ")}</span></div>
        <table class="table"><tbody>
          <tr><td class="dim">Employee</td><td><strong>${esc(r.senderName)}</strong> · ${esc(r.senderJob || OA.roleLabel(r.senderRole))}</td></tr>
          <tr><td class="dim">Organisation</td><td>${esc(r.organisationName || "Public")}</td></tr>
          <tr><td class="dim">Description</td><td>${esc(r.description || "—")}</td></tr>
          <tr><td class="dim">People affected</td><td>${r.peopleAffected}</td></tr>
          <tr><td class="dim">Location</td><td>${esc([r.floorId, r.zoneId].filter(Boolean).join(" · ") || "—")}${r.latitude != null ? ` · ${r.latitude.toFixed(5)}, ${r.longitude.toFixed(5)}` : ""}</td></tr>
          <tr><td class="dim">Sent / received</td><td>${OA.time(r.clientCreatedAt || r.createdAt)} → server ${OA.time(r.createdAt)} → dashboard ${OA.time(r.receivedAt)}</td></tr>
          <tr><td class="dim">Delivery</td><td>${OA.timeline(r.deliveryStatus, { skipQueued: true }).replace("STORED LOCALLY", "SENT")}</td></tr>
        </tbody></table>
        <div class="row wrap" style="margin-top:12px">
          ${r.deliveryStatus !== "ACKNOWLEDGED" ? '<button class="btn primary" data-act="ack"><i data-lucide="check"></i>Acknowledge</button>' : ""}
          <button class="btn warn" data-act="IN_PROGRESS"><i data-lucide="loader"></i>In progress</button>
          <button class="btn success" data-act="RESOLVED"><i data-lucide="check-check"></i>Resolve</button>
          <button class="btn danger" data-act="alert"><i data-lucide="megaphone"></i>Evacuation alert</button>
        </div>
        <div class="kicker" style="margin-top:16px">Messages</div>
        <div class="list" style="margin-top:8px">${d.messages.map((m) => `<div class="item"><strong>${esc(m.senderName)}</strong> <span class="dim">${OA.time(m.createdAt)}</span><div>${esc(m.payload.text || m.payload.label || "")}</div>
          <span class="pill ${m.deliveryStatus}" style="margin-top:4px">${m.deliveryStatus}</span></div>`).join("") || '<div class="dim">No messages yet.</div>'}</div>
        <form class="composer" id="instrForm" style="margin-top:10px"><textarea class="input" id="instrText" maxlength="1000" placeholder="Send instruction to ${esc(r.senderName)}…" required></textarea><button class="btn primary"><i data-lucide="send"></i></button></form>`;
      OA.icons();
      $("#reqDetail").querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
        const act = b.dataset.act;
        try {
          if (act === "ack") await OA.api(`/api/requests/${r.id}/acknowledge`, { method: "POST" });
          else if (act === "alert") {
            $("#alertTemplate").value = r.category === "earthquake" ? "quake" : "evac";
            $("#alertTemplate").dispatchEvent(new Event("change"));
            $("#alertForm").dataset.requestId = r.id;
            $("#alertTitle").focus();
            return OA.toast("Alert form pre-filled and linked to this request.");
          } else await OA.api(`/api/requests/${r.id}/status`, { method: "PATCH", body: { status: act } });
          reload();
        } catch (e) { OA.toast(esc(e.message), "error"); }
      }));
      $("#instrForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
          await OA.api("/api/messages", { method: "POST", body: { clientId: OA.uuid(), requestId: r.id, text: $("#instrText").value } });
          OA.toast("Instruction sent.", "ok"); reload();
        } catch (ex) { OA.toast(esc(ex.message), "error"); }
      });
      render();
    }

    $("#alertForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { clientId: OA.uuid(), title: $("#alertTitle").value, message: $("#alertMsg").value, category: $("#alertCat").value,
        severity: $("#alertSev").value, evacuationPlanId: $("#alertPlan").value || undefined, requestId: $("#alertForm").dataset.requestId || undefined };
      try {
        const out = await OA.api("/api/alerts", { method: "POST", body });
        OA.toast(`Alert relayed to ${out.alert.recipients.length} employees.`, "ok");
        delete $("#alertForm").dataset.requestId;
        $("#alertForm").reset();
        reload();
      } catch (ex) { OA.toast(esc(ex.message), "error"); }
    });
    $("#clearEmergency").addEventListener("click", async () => {
      if (!confirm("Stand down: close all alerts and reset employee safety statuses to UNKNOWN?")) return;
      try { await OA.api(`/api/organisations/${user.organisationId}/emergency-status`, { method: "PATCH", body: { status: "NORMAL" } }); reload(); } catch (ex) { OA.toast(esc(ex.message), "error"); }
    });
    $("#reqFilter").addEventListener("change", load);

    OA.on("request.new", (m) => { beep(); OA.toast(`<strong>NEW SOS · ${esc(OA.catLabel(m.request.category))}</strong><br>${esc(m.request.senderName)}: ${esc(m.request.description || "")}`, "alert", 8000); reload(); });
    ["request.updated", "message.new", "message.updated", "alert.updated", "org.status", "ws.open"].forEach((t) => OA.on(t, reload));
    setInterval(() => { if (OA.wsState !== "live") load(); }, 10000); // polling fallback when the socket is down
    load();
  }
})();
