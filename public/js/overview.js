/* Overview: honest live system status + role-relevant module shortcuts + small Three.js visual (optional). */
(async function () {
  const user = await OA.init();
  const { $, esc } = OA;
  const r = user.role;

  const MODULES = [
    ["/saferoute", "route", "SafeRoute", "Floor plans with exits, corridors, assembly points and live evacuation routing.", ["administrator", "officer", "employee"]],
    ["/connect", "radio-tower", "Connect", "Two-way SOS and official alerts over local Wi-Fi with delivery tracking.", ["administrator", "officer", "employee", "citizen"]],
    ["/assistant", "bot", "AI Assistant", "Llama 3.2 3B answers grounded in the offline ZIM knowledge pack, with citations.", ["*"]],
    ["/map", "map", "Offline Map", "Search hospitals and shelters and route on real OpenStreetMap roads — no internet.", ["*"]],
    ["/government", "landmark", "Government", "Shared incident feed with flood overlay, hospitals and shelters.", ["government_operator"]],
    ["/organisation", "building-2", "Organisation", "Staff safety status, active SOS and emergency plans at a glance.", ["administrator", "officer"]],
  ];
  $("#modules").innerHTML = MODULES.filter((m) => m[4].includes("*") || m[4].includes(r)).map(([href, icon, title, text]) =>
    `<a class="module-card" href="${href}"><span class="ico"><i data-lucide="${icon}"></i></span><h3>${title}</h3><p>${text}</p></a>`).join("");
  const primary = { employee: ["/connect", "Open emergency screen"], officer: ["/connect", "Open officer dashboard"], administrator: ["/saferoute", "Open SafeRoute"],
    citizen: ["/map", "Find help nearby"], government_operator: ["/government", "Open incident map"] }[r];
  $("#heroActions").innerHTML = `<a class="btn primary lg" href="${primary[0]}"><i data-lucide="arrow-right"></i>${primary[1]}</a><a class="btn lg" href="/assistant"><i data-lucide="bot"></i>Ask the AI</a>`;
  OA.icons();

  const LABELS = {
    node: ["server", "Node backend"], sqlite: ["database", "SQLite"], fastapi: ["cpu", "Python FastAPI"], ollama: ["boxes", "Ollama"],
    llm: ["brain", "Llama 3.2 3B"], embedding: ["binary", "Embedding model"], knowledge: ["library", "Knowledge index"],
    maps: ["map", "Offline map package"], network: ["wifi", "Network"],
  };
  const STATE = { online: "Online", offline: "Offline", degraded: "Degraded", not_configured: "Not configured" };
  OA.on("system.status", (s) => {
    $("#statusGrid").innerHTML = Object.entries(LABELS).map(([k, [icon, label]]) => {
      const c = s.checks[k] || { state: "not_configured", detail: "" };
      return `<div class="status-card"><span class="ico"><i data-lucide="${icon}"></i></span><div class="grow"><div class="row between"><strong>${label}</strong><span class="pill ${c.state}"><span class="dot"></span>${STATE[c.state]}</span></div><small>${esc(c.detail)}</small></div></div>`;
    }).join("");
    $("#statusTime").textContent = `Checked ${OA.time(s.time)} · ${s.websocketClients} live connection(s)`;
    OA.icons();
  });
  $("#refreshStatus").onclick = async () => { try { OA.emit("system.status", await OA.api("/api/system/status")); } catch (e) { OA.toast(esc(e.message), "error"); } };

  // Purely decorative: a slowly rotating "local mesh" of nodes. Skipped when reduced motion is requested or WebGL fails.
  const canvas = $("#heroCanvas");
  if (window.THREE && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    try {
      const THREE = window.THREE;
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
      camera.position.z = 6.5;
      const group = new THREE.Group();
      scene.add(group);
      group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 2), new THREE.MeshBasicMaterial({ color: 0x22d3ee, wireframe: true, transparent: true, opacity: 0.18 })));
      const pts = [];
      for (let i = 0; i < 14; i++) {
        const v = new THREE.Vector3().randomDirection().multiplyScalar(1.7);
        pts.push(v);
        const dot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 12, 12), new THREE.MeshBasicMaterial({ color: i === 0 ? 0xf04444 : 0x9cecff }));
        dot.position.copy(v);
        group.add(dot);
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts.flatMap((p, i) => [pts[0], p]).filter((_, i) => i > 1));
      group.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.45 })));
      const resize = () => { const { width, height } = canvas.getBoundingClientRect(); renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); };
      resize();
      addEventListener("resize", resize);
      (function tick() { group.rotation.y += 0.0025; group.rotation.x = 0.35; renderer.render(scene, camera); requestAnimationFrame(tick); })();
    } catch { canvas.remove(); }
  }
  if (window.gsap && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    gsap.from(".module-card", { y: 14, opacity: 0, duration: 0.45, stagger: 0.06, ease: "power2.out" });
  }
})();
