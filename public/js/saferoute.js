/* SafeRoute — floor-plan editor + indoor evacuation routing. */
(async function () {
  const user = await OA.init({ roles: ["administrator", "officer", "employee"] });
  const { $, esc } = OA;
  const canEdit = OA.can("floorplan:write");
  const NS = "http://www.w3.org/2000/svg";
  const TYPES = {
    exit: ["#22c55e", "Emergency exit", "E"], assembly: ["#4ade80", "Assembly point", "A"], entrance: ["#22d3ee", "Entrance", "In"],
    corridor: ["#64748b", "Corridor", ""], room: ["#3b82f6", "Room", ""], stairs: ["#a78bfa", "Staircase", "S"],
    extinguisher: ["#ef4444", "Fire extinguisher", "F"], first_aid: ["#10b981", "First aid", "+"], medical: ["#14b8a6", "Medical facility", "M"],
    restricted: ["#dc2626", "Restricted zone", "!"], hazard: ["#f97316", "Hazard", "⚠"],
  };
  const DESTS = [["nearest_safe", "Nearest exit or assembly point"], ["nearest_assembly", "Nearest assembly point"], ["nearest_exit", "Nearest exit"]];

  if (!canEdit)OA.$$(".editor-only").forEach((el) => el.classList.add("hidden"));
  $("#addType").innerHTML = Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v[1]}</option>`).join("");
  $("#addType").value = "corridor";
  $("#legend").innerHTML = Object.entries(TYPES).map(([, v]) => `<span><i style="background:${v[0]}"></i>${v[1]}</span>`).join("") + '<span><i style="background:var(--cyan)"></i>Route</span><span><i style="background:repeating-linear-gradient(90deg,#ef4444 0 3px,transparent 3px 5px)"></i>Blocked</span>';

  const svg = $("#svg"), stage = $("#stage");
  let plans = [], floorPlans = [], fp = null, nodes = [], edges = [], dirty = false;
  let mode = "select", selectedNode = null, connectFrom = null;
  let tempBlockedNodes = new Set(), tempBlockedEdges = new Set();
  let route = null, view = { x: 0, y: 0, w: 1600, h: 1000 };
  const byId = () => new Map(nodes.map((n) => [n.id, n]));
  const edgeId = (a, b) => [a, b].sort().join("--");

  function setDirty(v) { dirty = v; $("#dirtyPill").classList.toggle("hidden", !v); }
  window.addEventListener("beforeunload", (e) => { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  // ---------------------------------------------------------------- data
  async function loadFloorPlans(selectId) {
    floorPlans = (await OA.api("/api/floorplans")).floorPlans;
    $("#fpSelect").innerHTML = floorPlans.map((f) => `<option value="${f.id}">${esc(f.floor)} · ${esc(f.name)}</option>`).join("") || "<option>No floor plans yet</option>";
    if (!floorPlans.length) { svg.innerHTML = ""; return; }
    await openFloorPlan(selectId && floorPlans.find((f) => f.id === selectId) ? selectId : floorPlans[0].id);
  }

  async function openFloorPlan(id) {
    if (dirty && !confirm("Discard unsaved changes?")) { $("#fpSelect").value = fp.id; return; }
    fp = (await OA.api(`/api/floorplans/${id}`)).floorPlan;
    $("#fpSelect").value = fp.id;
    $("#fpSample").classList.toggle("hidden", !fp.isSample);
    nodes = fp.nodes; edges = fp.edges; route = null; selectedNode = null; connectFrom = null;
    tempBlockedNodes = new Set(); tempBlockedEdges = new Set();
    setDirty(false);
    // Load image via authenticated fetch -> blob URL (images are org-scoped, not public).
    const res = await fetch(fp.imageUrl, { headers: { Authorization: `Bearer ${OA.token}` } });
    fp.blobUrl = URL.createObjectURL(await res.blob());
    await new Promise((resolve) => { const img = new Image(); img.onload = () => { fp.width = fp.width || img.naturalWidth; fp.height = fp.height || img.naturalHeight; resolve(); }; img.src = fp.blobUrl; });
    plans = (await OA.api(`/api/evacuation-plans?floorPlanId=${fp.id}`)).plans;
    $("#planSelect").innerHTML = '<option value="">— Ad-hoc route —</option>' + plans.map((p) => `<option value="${p.id}">${esc(p.name)}${p.isSample ? " (sample)" : ""}</option>`).join("");
    fillSelectors();
    fit();
    render();
    renderRoute();
  }

  function fillSelectors() {
    const named = nodes.filter((n) => n.type !== "corridor" || n.label).sort((a, b) => (a.label || a.id).localeCompare(b.label || b.id));
    const opt = (n) => `<option value="${n.id}">${esc(n.label || n.id)} · ${TYPES[n.type][1]}</option>`;
    const s = $("#startSel").value, d = $("#destSel").value;
    $("#startSel").innerHTML = named.map(opt).join("");
    $("#destSel").innerHTML = DESTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("") + named.filter((n) => ["exit", "assembly", "first_aid", "medical", "entrance"].includes(n.type)).map(opt).join("");
    if (s && nodes.some((n) => n.id === s)) $("#startSel").value = s; else if (nodes.find((n) => n.type === "room")) $("#startSel").value = nodes.find((n) => n.type === "room").id;
    if (d) $("#destSel").value = d;
  }

  // ---------------------------------------------------------------- view (pan / zoom via viewBox)
  function applyView() { svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`); }
  function fit() {
    const r = stage.getBoundingClientRect();
    const W = fp.width, H = fp.height, aspect = r.width / r.height;
    if (W / H > aspect) view = { x: 0, y: -(W / aspect - H) / 2, w: W, h: W / aspect };
    else view = { x: -(H * aspect - W) / 2, y: 0, w: H * aspect, h: H };
    applyView();
  }
  function zoom(f, cx, cy) {
    cx = cx ?? view.x + view.w / 2; cy = cy ?? view.y + view.h / 2;
    const nw = Math.min(Math.max(view.w * f, 150), fp.width * 4);
    const k = nw / view.w;
    view = { x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k, w: nw, h: view.h * k };
    applyView();
  }
  function toSvg(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }
  $("#zoomIn").onclick = () => zoom(0.8);
  $("#zoomOut").onclick = () => zoom(1.25);
  $("#fitBtn").onclick = fit;
  $("#resetBtn").onclick = () => { view = { x: 0, y: 0, w: fp.width, h: fp.height }; applyView(); };
  svg.addEventListener("wheel", (e) => { e.preventDefault(); const p = toSvg(e); zoom(e.deltaY > 0 ? 1.15 : 0.87, p.x, p.y); }, { passive: false });

  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    const target = e.target.closest("[data-node],[data-edge]");
    const p = toSvg(e);
    if (mode === "add" && !target) return addNode(p);
    if (target && target.dataset.node) return nodeClick(target.dataset.node, e);
    if (target && target.dataset.edge) return edgeClick(target.dataset.edge);
    drag = { kind: "pan", sx: e.clientX, sy: e.clientY, view: { ...view } };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      const r = stage.getBoundingClientRect();
      view.x = drag.view.x - ((e.clientX - drag.sx) * drag.view.w) / r.width;
      view.y = drag.view.y - ((e.clientY - drag.sy) * drag.view.h) / r.height;
      applyView();
    } else if (drag.kind === "node") {
      const p = toSvg(e);
      const n = nodes.find((x) => x.id === drag.id);
      n.x = Math.round(Math.max(0, Math.min(fp.width, p.x))); n.y = Math.round(Math.max(0, Math.min(fp.height, p.y)));
      setDirty(true); render();
    }
  });
  svg.addEventListener("pointerup", () => { if (drag && drag.kind === "node") renderNodePanel(); drag = null; });

  // ---------------------------------------------------------------- editing
  function nextId(type) {
    const prefix = { exit: "EXIT", assembly: "AP", corridor: "C", room: "R" }[type] || type.toUpperCase().slice(0, 4);
    let i = 1;
    while (nodes.some((n) => n.id === `${prefix}_${i}`)) i++;
    return `${prefix}_${i}`;
  }
  function addNode(p) {
    const type = $("#addType").value;
    const n = { id: nextId(type), x: Math.round(p.x), y: Math.round(p.y), type, label: type === "corridor" ? "" : TYPES[type][1], blocked: false, floorId: fp.floor };
    nodes.push(n);
    if (selectedNode && type === "corridor" && nodes.find((x) => x.id === selectedNode)) edges.push({ id: edgeId(selectedNode, n.id), source: selectedNode, destination: n.id, cost: null, blocked: false });
    selectedNode = n.id;
    setDirty(true); fillSelectors(); render(); renderNodePanel();
  }
  function nodeClick(id, e) {
    if (mode === "delete") {
      nodes = nodes.filter((n) => n.id !== id); edges = edges.filter((x) => x.source !== id && x.destination !== id);
      if (selectedNode === id) selectedNode = null;
      setDirty(true); fillSelectors(); render(); renderNodePanel(); return;
    }
    if (mode === "block") {
      tempBlockedNodes.has(id) ? tempBlockedNodes.delete(id) : tempBlockedNodes.add(id);
      render(); if (route) calculate(); return;
    }
    if (mode === "connect") {
      if (!connectFrom) { connectFrom = id; render(); $("#hint").textContent = "Now click the node to connect to"; return; }
      if (connectFrom !== id) {
        const eid = edgeId(connectFrom, id);
        if (edges.some((x) => x.id === eid)) edges = edges.filter((x) => x.id !== eid);
        else edges.push({ id: eid, source: connectFrom, destination: id, cost: null, blocked: false });
        setDirty(true);
      }
      connectFrom = null; $("#hint").textContent = "Click a node, then another, to connect / disconnect"; render(); return;
    }
    selectedNode = id;
    if (mode === "move") { drag = { kind: "node", id }; svg.setPointerCapture(e.pointerId); }
    render(); renderNodePanel();
  }
  function edgeClick(id) {
    if (mode === "delete") { edges = edges.filter((x) => x.id !== id); setDirty(true); render(); return; }
    if (mode === "block" || mode === "select") {
      tempBlockedEdges.has(id) ? tempBlockedEdges.delete(id) : tempBlockedEdges.add(id);
      render(); if (route) calculate();
    }
  }

  OA.$$("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    mode = b.dataset.mode; connectFrom = null;
    OA.$$("[data-mode]").forEach((x) => x.classList.toggle("active", x === b));
    stage.className = `fp-stage mode-${mode}`;
    $("#hint").textContent = { select: "Drag to pan · scroll to zoom · click a corridor line to block it", move: "Drag a node to move it", add: "Click on the plan to place a node (auto-connects corridors to the selected node)",
      connect: "Click a node, then another, to connect / disconnect", block: "Click a corridor or node to block/unblock it — route recalculates", delete: "Click a node or connection to delete it" }[mode];
    render();
  }));

  function renderNodePanel() {
    const panel = $("#nodePanel");
    if (!canEdit) return;
    const n = nodes.find((x) => x.id === selectedNode);
    panel.classList.toggle("hidden", !n);
    if (!n) return;
    const links = edges.filter((e) => e.source === n.id || e.destination === n.id);
    panel.innerHTML = `<div class="panel-head"><i data-lucide="circle-dot"></i><h2>Node <span class="mono">${esc(n.id)}</span></h2></div>
      <div class="stack" style="gap:10px">
        <div class="field"><label>Label</label><input class="input" id="nLabel" maxlength="60" value="${esc(n.label)}" /></div>
        <div class="field"><label>Type</label><select class="input" id="nType">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${k === n.type ? "selected" : ""}>${v[1]}</option>`).join("")}</select></div>
        <label class="row"><input type="checkbox" id="nBlocked" ${n.blocked ? "checked" : ""} /> Permanently blocked (saved)</label>
        <div class="dim" style="font-size:12px">x ${n.x}, y ${n.y} · ${links.length} connection(s)</div>
        <button class="btn sm danger" id="nDelete"><i data-lucide="trash-2"></i>Delete node</button>
      </div>`;
    OA.icons();
    $("#nLabel").oninput = (e) => { n.label = e.target.value; setDirty(true); render(); };
    $("#nType").onchange = (e) => { n.type = e.target.value; setDirty(true); fillSelectors(); render(); };
    $("#nBlocked").onchange = (e) => { n.blocked = e.target.checked; setDirty(true); render(); if (route) calculate(); };
    $("#nDelete").onclick = () => { mode = "delete"; nodeClick(n.id); mode = "select"; };
  }

  $("#saveBtn").addEventListener("click", async () => {
    try {
      const out = await OA.api(`/api/floorplans/${fp.id}`, { method: "PUT", body: { nodes, edges } });
      nodes = out.floorPlan.nodes; edges = out.floorPlan.edges;
      setDirty(false); OA.toast(`Saved ${nodes.length} nodes and ${edges.length} connections.`, "ok");
    } catch (e) { OA.toast(esc(e.message), "error"); }
  });

  // ---------------------------------------------------------------- rendering
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  function render() {
    if (!fp) return;
    svg.innerHTML = "";
    const scale = Math.max(1, fp.width / 1150);
    el("image", { href: fp.blobUrl, x: 0, y: 0, width: fp.width, height: fp.height, preserveAspectRatio: "none" }, svg);
    const m = byId();
    const routeEdges = new Set(route && route.ok ? route.edges : []);
    const gE = el("g", {}, svg);
    for (const e of edges) {
      const a = m.get(e.source), b = m.get(e.destination);
      if (!a || !b) continue;
      const blocked = e.blocked || tempBlockedEdges.has(e.id);
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "transparent", "stroke-width": 22 * scale, "data-edge": e.id, style: "cursor:pointer" }, gE);
      el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: blocked ? "#ef4444" : "#475569", "stroke-width": (blocked ? 7 : 4) * scale, "stroke-dasharray": blocked ? `${12 * scale} ${8 * scale}` : "", opacity: routeEdges.has(e.id) ? 0 : 0.85, "pointer-events": "none" }, gE);
      if (blocked) {
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        el("circle", { cx: mx, cy: my, r: 13 * scale, fill: "#ef4444", "pointer-events": "none" }, gE);
        const t = el("text", { x: mx, y: my + 5 * scale, "text-anchor": "middle", "font-size": 15 * scale, "font-weight": 800, fill: "#fff", "pointer-events": "none" }, gE);
        t.textContent = "✕";
      }
    }
    if (route && route.ok) {
      const pts = route.path.map((id) => m.get(id)).filter(Boolean).map((n) => `${n.x},${n.y}`).join(" ");
      el("polyline", { points: pts, fill: "none", stroke: "#0e7490", "stroke-width": 16 * scale, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: 0.45, "pointer-events": "none" }, svg);
      const line = el("polyline", { points: pts, fill: "none", stroke: "#22d3ee", "stroke-width": 7 * scale, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": `${18 * scale} ${12 * scale}`, "pointer-events": "none" }, svg);
      line.innerHTML = `<animate attributeName="stroke-dashoffset" from="${60 * scale}" to="0" dur="1s" repeatCount="indefinite"/>`;
    }
    const gN = el("g", {}, svg);
    for (const n of nodes) {
      const [color, , glyph] = TYPES[n.type] || TYPES.room;
      const blocked = n.blocked || tempBlockedNodes.has(n.id);
      const big = ["exit", "assembly", "first_aid", "medical", "hazard", "restricted", "stairs", "entrance", "extinguisher"].includes(n.type);
      const r = (n.type === "corridor" ? 7 : big ? 15 : 11) * scale;
      const g = el("g", { "data-node": n.id, style: "cursor:pointer" }, gN);
      if (selectedNode === n.id || connectFrom === n.id) el("circle", { cx: n.x, cy: n.y, r: r + 7 * scale, fill: "none", stroke: connectFrom === n.id ? "#f5a524" : "#22d3ee", "stroke-width": 3 * scale }, g);
      if (route && route.ok && (n.id === route.path[0] || n.id === route.destination)) el("circle", { cx: n.x, cy: n.y, r: r + 10 * scale, fill: "none", stroke: n.id === route.path[0] ? "#f04444" : "#22c55e", "stroke-width": 4 * scale }, g);
      el("circle", { cx: n.x, cy: n.y, r, fill: blocked ? "#7f1d1d" : color, stroke: blocked ? "#ef4444" : "#0b1324", "stroke-width": 2.5 * scale }, g);
      if (glyph) { const t = el("text", { x: n.x, y: n.y + 5 * scale, "text-anchor": "middle", "font-size": 13 * scale, "font-weight": 800, fill: "#06121f", "pointer-events": "none" }, g); t.textContent = glyph; }
      if (blocked) { const t = el("text", { x: n.x, y: n.y + 5 * scale, "text-anchor": "middle", "font-size": 16 * scale, "font-weight": 800, fill: "#fff", "pointer-events": "none" }, g); t.textContent = "✕"; }
      if (n.label && n.type !== "corridor" && n.type !== "room") {
        const t = el("text", { x: n.x + r + 5 * scale, y: n.y + 4 * scale, "font-size": 13 * scale, "font-weight": 700, fill: "#0b1324", stroke: "#fff", "stroke-width": 3 * scale, "paint-order": "stroke", "pointer-events": "none" }, g);
        t.textContent = n.label;
      }
      const title = el("title", {}, g); title.textContent = `${n.label || n.id} (${TYPES[n.type][1]})${blocked ? " — BLOCKED" : ""}`;
    }
    applyView();
  }

  // ---------------------------------------------------------------- routing
  async function calculate() {
    const planId = $("#planSelect").value;
    const body = { start: $("#startSel").value, destination: $("#destSel").value, blockedNodes: [...tempBlockedNodes], blockedEdges: [...tempBlockedEdges] };
    try {
      // Unsaved edits are routed client-side through the same endpoint after save; warn instead of routing stale data.
      if (dirty) OA.toast("Routing uses the last saved graph — save to include your edits.", "", 3500);
      const out = planId ? await OA.api(`/api/evacuation-plans/${planId}/calculate-route`, { method: "POST", body })
        : await OA.api(`/api/floorplans/${fp.id}/route`, { method: "POST", body });
      route = out.route || out;
    } catch (e) { route = { ok: false, reason: e.message }; }
    render(); renderRoute();
  }
  function renderRoute() {
    const out = $("#routeOut");
    const blockedCount = tempBlockedEdges.size + tempBlockedNodes.size;
    $("#blockedOut").innerHTML = blockedCount ? `<div class="notice warn"><i data-lucide="ban"></i><div class="grow">${blockedCount} corridor/node(s) blocked for this incident.</div><button class="btn sm" id="clearBlocks">Clear</button></div>` : "";
    if ($("#clearBlocks")) $("#clearBlocks").onclick = () => { tempBlockedEdges.clear(); tempBlockedNodes.clear(); render(); calculate(); };
    if (!route) { out.innerHTML = '<p class="dim" style="font-size:12.5px">Choose a start and destination, then calculate. Click a corridor line on the plan to block it and watch the route recalculate.</p>'; OA.icons(); return; }
    if (!route.ok) { out.innerHTML = `<div class="notice danger"><i data-lucide="triangle-alert"></i><div><strong>No safe route.</strong><br>${esc(route.reason)}</div></div>`; OA.icons(); return; }
    out.innerHTML = `<div class="notice ok"><i data-lucide="check-circle"></i><div><strong>Route to ${esc(route.destinationLabel)}</strong><br>${route.path.length} waypoints · ~${route.cost} px path length${blockedCount ? " · avoiding blocked areas" : ""}</div></div>
      <ol class="route-steps" style="margin-top:10px">${route.steps.filter((s) => s.type !== "corridor" || /door|exit/i.test(s.label)).map((s) => `<li>${esc(s.label)}</li>`).join("")}</ol>`;
    OA.icons();
  }
  $("#routeBtn").addEventListener("click", calculate);
  $("#startSel").addEventListener("change", () => { if (route) calculate(); });
  $("#destSel").addEventListener("change", () => { if (route) calculate(); });

  function selectPlan(id) {
    const p = plans.find((x) => x.id === id);
    $("#planSelect").value = p ? p.id : "";
    $("#updatePlan").disabled = !p;
    $("#planInfo").classList.toggle("hidden", !p);
    if (!p) return;
    if (![...$("#destSel").options].some((o) => o.value === p.destinationNode)) $("#destSel").insertAdjacentHTML("afterbegin", `<option value="${esc(p.destinationNode)}">${esc(p.destinationNode)}</option>`);
    $("#startSel").value = p.startNode; $("#destSel").value = p.destinationNode;
    tempBlockedNodes = new Set(p.blockedNodes); tempBlockedEdges = new Set(p.blockedEdges);
    $("#planName").value = p.name; $("#planType").value = p.emergencyType; $("#planInstr").value = p.instructions;
    $("#planInfo").innerHTML = `<div class="panel-head"><i data-lucide="clipboard-list"></i><h2>${esc(p.name)}</h2>${p.isSample ? '<span class="pill sample">SAMPLE</span>' : ""}</div>
      <span class="pill danger">${esc(OA.catLabel(p.emergencyType))}</span>
      <div style="white-space:pre-wrap;margin-top:10px;font-size:13.5px">${esc(p.instructions || "No instructions.")}</div>`;
    OA.icons();
    calculate();
  }
  $("#planSelect").addEventListener("change", (e) => selectPlan(e.target.value));

  async function savePlan(update) {
    const body = { floorPlanId: fp.id, name: $("#planName").value, emergencyType: $("#planType").value, instructions: $("#planInstr").value,
      startNode: $("#startSel").value, destinationNode: $("#destSel").value, blockedNodes: [...tempBlockedNodes], blockedEdges: [...tempBlockedEdges] };
    try {
      const id = $("#planSelect").value;
      const out = update ? await OA.api(`/api/evacuation-plans/${id}`, { method: "PUT", body }) : await OA.api("/api/evacuation-plans", { method: "POST", body });
      if (!out.route.ok) OA.toast(`Plan saved, but no route currently exists: ${esc(out.route.reason)}`, "error", 6000);
      else OA.toast("Evacuation plan saved.", "ok");
      plans = (await OA.api(`/api/evacuation-plans?floorPlanId=${fp.id}`)).plans;
      $("#planSelect").innerHTML = '<option value="">— Ad-hoc route —</option>' + plans.map((p) => `<option value="${p.id}">${esc(p.name)}${p.isSample ? " (sample)" : ""}</option>`).join("");
      selectPlan(out.plan.id);
    } catch (e) { OA.toast(esc(e.message), "error"); }
  }
  $("#planForm").addEventListener("submit", (e) => { e.preventDefault(); savePlan(false); });
  $("#updatePlan").addEventListener("click", () => savePlan(true));
  $("#fpSelect").addEventListener("change", (e) => openFloorPlan(e.target.value));

  // ---------------------------------------------------------------- upload (PNG / JPG / PDF)
  $("#uploadBtn").addEventListener("click", () => {
    const m = OA.modal(`<div class="stack">
      <div class="row between"><h2>Upload floor plan</h2><button class="btn ghost sm" data-close>✕</button></div>
      <div class="field"><label>File (PNG, JPG or PDF · max 15 MB)</label><input class="input" type="file" id="upFile" accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf" /></div>
      <div class="field hidden" id="pdfPageWrap"><label>PDF page</label><select class="input" id="pdfPage"></select></div>
      <div class="grid cols-2" style="gap:10px"><div class="field"><label>Name</label><input class="input" id="upName" maxlength="80" value="New floor plan" /></div>
      <div class="field"><label>Floor</label><input class="input" id="upFloor" maxlength="40" value="Ground" /></div></div>
      <canvas id="upPreview" style="max-width:100%;border-radius:8px;display:none"></canvas>
      <button class="btn primary" id="upGo" disabled><i data-lucide="upload"></i>Upload</button><div id="upMsg"></div></div>`);
    m.el.querySelector("[data-close]").onclick = m.close;
    let pdfDoc = null, file = null;
    const canvas = m.el.querySelector("#upPreview");
    async function renderPdfPage(n) {
      const page = await pdfDoc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(3, 2000 / base.width) });
      canvas.width = vp.width; canvas.height = vp.height; canvas.style.display = "block";
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    }
    m.el.querySelector("#upFile").onchange = async (e) => {
      file = e.target.files[0]; pdfDoc = null;
      m.el.querySelector("#upGo").disabled = !file;
      m.el.querySelector("#pdfPageWrap").classList.add("hidden");
      if (!file) return;
      m.el.querySelector("#upName").value = file.name.replace(/\.[^.]+$/, "").slice(0, 80);
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        const pdfjs = await import("/vendor/pdfjs/pdf.min.mjs");
        pdfjs.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";
        pdfDoc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
        m.el.querySelector("#pdfPage").innerHTML = Array.from({ length: pdfDoc.numPages }, (_, i) => `<option value="${i + 1}">Page ${i + 1}</option>`).join("");
        m.el.querySelector("#pdfPageWrap").classList.remove("hidden");
        m.el.querySelector("#pdfPage").onchange = (ev) => renderPdfPage(Number(ev.target.value));
        await renderPdfPage(1);
      } else { canvas.style.display = "none"; }
    };
    m.el.querySelector("#upGo").onclick = async () => {
      const form = new FormData();
      let w, h;
      if (pdfDoc) {
        const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
        form.append("image", blob, "page.png"); form.append("original", file, file.name);
        w = canvas.width; h = canvas.height;
      } else {
        const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = URL.createObjectURL(file); });
        w = img.naturalWidth; h = img.naturalHeight;
        form.append("image", file, file.name);
      }
      form.append("name", m.el.querySelector("#upName").value); form.append("floor", m.el.querySelector("#upFloor").value);
      form.append("width", w); form.append("height", h);
      try {
        const out = await OA.api("/api/floorplans", { method: "POST", form, timeout: 60000 });
        m.close(); OA.toast("Floor plan uploaded. Add exits, corridors and an assembly point, then Save.", "ok", 6000);
        await loadFloorPlans(out.floorPlan.id);
      } catch (e) { m.el.querySelector("#upMsg").innerHTML = `<div class="notice danger">${esc(e.message)}</div>`; }
    };
  });

  // ---------------------------------------------------------------- start
  const params = new URLSearchParams(location.search);
  const wantPlan = params.get("plan");
  let target = null;
  if (wantPlan) { try { target = (await OA.api(`/api/evacuation-plans/${encodeURIComponent(wantPlan)}`)).plan; } catch { /* ignore */ } }
  await loadFloorPlans(target ? target.floorPlanId : null);
  if (target) {
    selectPlan(target.id);
    $("#planAlert").classList.remove("hidden");
    $("#planAlert").innerHTML = `<i data-lucide="siren"></i><div><strong>Follow this route now: ${esc(target.name)}</strong><br>Opened from an official alert. Avoid any red ✕ areas.</div>`;
    OA.icons();
  } else if (plans.length) {
    selectPlan(plans[0].id);
  }
  window.addEventListener("resize", () => fp && fit());
})();
