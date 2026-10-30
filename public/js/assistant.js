/* AI Assistant: streaming grounded answers from local Llama 3.2 3B + ZIM retrieval, optional local voice. */
(async function () {
  await OA.init();
  const { $, esc } = OA;
  let busy = false, voice = { stt: false, tts: false };

  async function health() {
    try {
      const h = await OA.api("/api/ai/health", { timeout: 6000 });
      const ok = h.status === "ok";
      $("#aiPill").className = `pill ${ok ? "online" : "degraded"}`;
      $("#aiPill").innerHTML = `<span class="dot"></span>${ok ? "Local AI ready" : "Local AI degraded"}`;
      voice = h.voice || voice;
      const row = (label, state, detail) => `<div class="item row between"><div><strong>${label}</strong><div class="dim" style="font-size:12px">${esc(detail)}</div></div><span class="pill ${state}">${state.replace("_", " ")}</span></div>`;
      $("#stack").innerHTML = [
        row("Ollama runtime", h.ollama.reachable ? "online" : "offline", h.ollama.url),
        row("LLM", h.llm.available ? (h.llm.warm ? "online" : "degraded") : "offline", `${h.llm.model}${h.llm.warm ? " · loaded in memory" : ""}`),
        row("Embeddings", h.embedding.available ? "online" : "offline", h.embedding.model),
        row("Vector index", h.index.sources_ready ? "online" : "not_configured", `ChromaDB · ${h.index.chunks} chunks · ${h.index.sources_ready} pack(s)${h.index.indexing.length ? " · indexing…" : ""}`),
        row("Speech-to-text", voice.stt ? "online" : "not_configured", voice.stt ? voice.stt_engine : "Not installed — typing works"),
        row("Text-to-speech", voice.tts ? "online" : "degraded", voice.tts ? voice.tts_engine : "Using this device's local OS voice"),
      ].join("");
      $("#micBtn").disabled = !voice.stt;
      $("#voiceNote").textContent = voice.stt ? `Voice: press the mic, speak one English question, press again to stop (${voice.stt_engine}, local).` : "Voice input not installed on this laptop — type your question. See README › Voice.";
    } catch (e) {
      $("#aiPill").className = "pill offline"; $("#aiPill").innerHTML = '<span class="dot"></span>AI service offline';
      $("#stack").innerHTML = `<div class="notice danger">${esc(e.message)}</div>`;
      $("#micBtn").disabled = true;
    }
  }

  function bubble(cls, html) {
    $("#welcome")?.remove();
    const d = document.createElement("div");
    d.className = `msg ${cls}`;
    d.innerHTML = html;
    $("#chat").appendChild(d);
    $("#chat").scrollTop = $("#chat").scrollHeight;
    return d;
  }

  function renderDone(el, r, clientMs) {
    const t = r.timing || {};
    const timing = r.cached ? "" : `<span class="pill" title="Measured on this laptop">${t.first_token_ms ? `first words ${(t.first_token_ms / 1000).toFixed(1)} s · ` : ""}total ${((t.total_ms || clientMs) / 1000).toFixed(1)} s</span>`;
    const badge = r.cached ? '<span class="pill warn">CACHED ANSWER</span>' : r.grounded ? '<span class="pill online">Grounded in knowledge pack</span>' : '<span class="pill not_configured">Not found in pack</span>';
    el.innerHTML = `<div class="meta"><span class="pill info"><i data-lucide="bot"></i>${esc(r.model || "local model")}</span>${badge}${timing}</div>
      ${r.cached ? `<div class="notice warn" style="margin-bottom:8px">${esc(r.cache_note || "Cached answer")}</div>` : ""}
      <div class="answer">${esc(r.answer)}</div>
      ${r.sources && r.sources.length ? `<div class="sources"><div class="kicker">Sources (retrieved passages)</div>${r.sources.map((s) => `<div class="source">
        <strong>[${s.n}] ${esc(s.title)}</strong> <span class="dim">· ${esc(s.zim_file)}${s.origin_file ? ` · from ${esc(s.origin_file)} p.${s.origin_page}` : ""}</span>
        <div class="excerpt">“${esc(s.excerpt)}…”</div></div>`).join("")}</div>` : ""}
      ${r.grounded && !r.citations_explicit ? '<div class="dim" style="font-size:12px;margin-top:6px">The model did not cite specific passages; all retrieved passages are listed.</div>' : ""}
      <div class="disclaimer"><i data-lucide="triangle-alert"></i>${esc(r.disclaimer || "General emergency guidance only. Contact local emergency services whenever possible.")}</div>
      <div class="row" style="margin-top:8px"><button class="btn sm ghost" data-speak><i data-lucide="volume-2"></i>Speak</button></div>`;
    el.querySelector("[data-speak]").onclick = () => speak(r.answer);
    OA.icons();
    $("#chat").scrollTop = $("#chat").scrollHeight;
    if ($("#speakToggle").checked && r.answer) speak(r.answer);
  }

  async function ask(question) {
    question = question.trim();
    if (!question || busy) return;
    busy = true; $("#sendBtn").disabled = true;
    bubble("user", esc(question));
    const el = bubble("bot", '<div class="typing"><span></span><span></span><span></span> Searching the knowledge pack…</div>');
    const t0 = performance.now();
    try {
      const res = await fetch("/api/ai/ask/stream", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OA.token}` }, body: JSON.stringify({ question }) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `AI request failed (${res.status})`); }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "", text = "", done = null;
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "retrieved") el.innerHTML = `<div class="meta"><span class="pill info">Found ${ev.count} relevant passage(s) · generating with Llama 3.2 3B…</span></div><div class="answer" data-live></div>`;
          else if (ev.type === "token") { text += ev.text; const live = el.querySelector("[data-live]"); if (live) live.textContent = text; $("#chat").scrollTop = $("#chat").scrollHeight; }
          else if (ev.type === "error") throw new Error(ev.error);
          else if (ev.type === "done") done = ev;
        }
      }
      if (!done) throw new Error("The answer stream ended unexpectedly.");
      renderDone(el, done, performance.now() - t0);
    } catch (e) {
      el.innerHTML = `<div class="notice danger"><i data-lucide="circle-x"></i><div><strong>Local AI unavailable.</strong><br>${esc(e.message)}<br><span class="dim">OfflineAid never falls back to an online AI service.</span></div></div>`;
      OA.icons();
    } finally { busy = false; $("#sendBtn").disabled = false; }
  }

  // ---------- speech output: local Piper if installed, otherwise local OS voices only ----------
  let audio;
  async function speak(text) {
    const clean = text.replace(/\[\d+\]/g, "").replace(/[*•]/g, "").slice(0, 1500);
    if (window.speechSynthesis) speechSynthesis.cancel();
    if (audio) audio.pause();
    if (voice.tts) {
      try {
        const r = await fetch("/api/ai/voice/speak", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OA.token}` }, body: JSON.stringify({ text: clean }) });
        if (!r.ok) throw new Error();
        audio = new Audio(URL.createObjectURL(await r.blob()));
        return audio.play();
      } catch { /* fall through to OS voice */ }
    }
    if (!("speechSynthesis" in window)) return;
    // Only voices that run on this device (localService) — never cloud voices.
    const voices = speechSynthesis.getVoices().filter((v) => v.localService && /^en/i.test(v.lang));
    if (!voices.length) return OA.toast("No local English voice on this device.", "error");
    const u = new SpeechSynthesisUtterance(clean);
    u.voice = voices[0];
    speechSynthesis.speak(u);
  }
  if ("speechSynthesis" in window) speechSynthesis.getVoices();

  // ---------- speech input: record in browser, transcribe on the laptop (local STT) ----------
  let rec, chunks = [];
  $("#micBtn").addEventListener("click", async () => {
    if (rec && rec.state === "recording") { rec.stop(); return; }
    if (!navigator.mediaDevices || !window.isSecureContext) return OA.toast("Microphone needs https or localhost. Use the laptop browser (localhost) or type the question.", "error", 6000);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      rec = new MediaRecorder(stream); chunks = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        $("#micBtn").classList.remove("recording");
        $("#voiceNote").textContent = "Transcribing locally…";
        const form = new FormData();
        form.append("audio", new Blob(chunks, { type: rec.mimeType }), "question.webm");
        try {
          const out = await OA.api("/api/ai/voice/transcribe", { method: "POST", form, timeout: 60000 });
          $("#q").value = out.text;
          $("#voiceNote").textContent = `Transcript (${(out.ms / 1000).toFixed(1)} s, local ${out.engine}) — edit if needed, then press send.`;
          $("#q").focus();
        } catch (e) { $("#voiceNote").textContent = `Voice failed: ${e.message}. Type your question instead.`; }
      };
      rec.start();
      $("#micBtn").classList.add("recording");
      $("#voiceNote").textContent = "Listening… press the mic again to stop.";
    } catch (e) { OA.toast(`Microphone unavailable: ${esc(e.message)}`, "error"); }
  });

  $("#askForm").addEventListener("submit", (e) => { e.preventDefault(); const q = $("#q").value; $("#q").value = ""; ask(q); });
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#askForm").requestSubmit(); } });
  OA.$$("[data-q]").forEach((b) => b.addEventListener("click", () => ask(b.dataset.q)));
  health();
  setInterval(health, 20000);
})();
