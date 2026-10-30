/* Settings: account info, LAN URLs, local offline-queue inspection. */
(async function () {
  const u = await OA.init();
  const { $, esc } = OA;
  $("#acct").innerHTML = [["Name", u.name], ["Username", u.username], ["Role", OA.roleLabel(u.role)], ["Organisation", u.organisationName || "—"],
    ["Facility", u.facilityName || "—"], ["Permissions", u.permissions.join(", ")]].map(([k, v]) => `<tr><td class="dim">${k}</td><td>${esc(v)}</td></tr>`).join("");
  OA.on("system.status", (s) => {
    $("#lanUrls").innerHTML = s.lan.length ? s.lan.map((ip) => `<div class="item mono" style="font-size:15px">http://${esc(ip)}:${s.port}</div>`).join("")
      : '<div class="notice warn">No LAN interface found. Turn on Wi-Fi or a mobile hotspot.</div>';
  });
  async function renderQueue() {
    const items = await OA.outbox.all();
    $("#queue").innerHTML = items.length ? items.slice(0, 20).map((i) => `<div class="item"><div class="item-head"><strong>${esc(i.kind)}</strong><span class="pill ${i.state}">${esc(i.state)}</span><span class="grow"></span><span class="dim" style="font-size:12px">${OA.time(i.createdAt)}</span></div>
      <div class="item-meta">retries ${i.retryCount}${i.serverId ? " · server id " + esc(i.serverId) : ""}${i.error ? " · " + esc(i.error) : ""}</div></div>`).join("")
      : '<div class="empty">Nothing stored on this device.</div>';
  }
  OA.on("outbox.changed", renderQueue);
  $("#flushBtn").onclick = async () => { await OA.outbox.flush(); renderQueue(); };
  renderQueue();
})();
