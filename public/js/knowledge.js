/* Knowledge Sources: list / upload / re-index / remove ZIM packs. */
(async function () {
  await OA.init({ roles: ["administrator", "officer", "government_operator"] });
  const { $, esc } = OA;
  const canManage = OA.can("ai:sources");
  if (!canManage) $("#uploadPanel").classList.add("hidden");
  const size = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.round(b / 1024) + " KB");

  async function load() {
    try {
      const d = await OA.api("/api/ai/sources");
      $("#totalChunks").textContent = `${d.total_chunks} chunks in ChromaDB`;
      $("#srcRows").innerHTML = d.sources.map((s) => {
        const pct = s.articles_total ? Math.round((100 * s.articles_processed) / s.articles_total) : 0;
        const st = { ready: "online", indexing: "degraded", queued: "degraded", error: "offline" }[s.status] || "";
        return `<tr><td><strong>${esc(s.title || s.filename)}</strong><div class="mono dim">${esc(s.filename)}</div>${s.error ? `<div class="notice danger" style="margin-top:4px">${esc(s.error)}</div>` : ""}</td>
          <td>${size(s.size)}</td><td><span class="pill ${st}">${esc(s.status)}${s.status === "indexing" ? " " + pct + "%" : ""}</span></td>
          <td>${s.article_count}</td><td>${s.chunk_count}</td><td class="dim">${s.indexed_at ? new Date(s.indexed_at).toLocaleString() : "—"}</td>
          <td>${canManage ? `<button class="btn sm ghost" data-re="${s.id}" title="Re-index"><i data-lucide="refresh-cw"></i></button><button class="btn sm ghost" data-rm="${s.id}" title="Remove"><i data-lucide="trash-2"></i></button>` : ""}</td></tr>`;
      }).join("") || '<tr><td colspan="7"><div class="empty">No knowledge packs. Upload a .zim file.</div></td></tr>';
      OA.$$("[data-re]").forEach((b) => { b.onclick = async () => { try { await OA.api(`/api/ai/sources/${b.dataset.re}/reindex`, { method: "POST" }); load(); } catch (e) { OA.toast(esc(e.message), "error"); } }; });
      OA.$$("[data-rm]").forEach((b) => { b.onclick = async () => { if (!confirm("Remove this pack and its vectors?")) return; try { await OA.api(`/api/ai/sources/${b.dataset.rm}`, { method: "DELETE" }); load(); } catch (e) { OA.toast(esc(e.message), "error"); } }; });
      OA.icons();
      if (d.sources.some((s) => ["queued", "indexing"].includes(s.status))) setTimeout(load, 2000);
    } catch (e) { $("#srcRows").innerHTML = `<tr><td colspan="7"><div class="notice danger">${esc(e.message)}</div></td></tr>`; }
  }

  $("#zimForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = $("#zimFile").files[0];
    if (!f) return;
    const form = new FormData();
    form.append("file", f, f.name);
    $("#zimBtn").disabled = true;
    $("#zimMsg").innerHTML = '<div class="notice info">Uploading and validating…</div>';
    try {
      await OA.api("/api/ai/sources/upload", { method: "POST", form, timeout: 30 * 60000 });
      $("#zimMsg").innerHTML = '<div class="notice ok">Accepted — indexing started.</div>';
      load();
    } catch (ex) { $("#zimMsg").innerHTML = `<div class="notice danger">${esc(ex.message)}</div>`; }
    finally { $("#zimBtn").disabled = false; }
  });
  load();
})();
