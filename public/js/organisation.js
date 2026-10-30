/* Organisation dashboard (persistent data from SQLite). */
(async function () {
  const user = await OA.init({ roles: ["officer", "administrator"] });
  const { $, esc } = OA;
  let previewLoaded = false;

  async function load() {
    try {
      const [d, p] = await Promise.all([OA.api(`/api/organisations/${user.organisationId}/dashboard`), OA.api("/api/evacuation-plans")]);
      const o = d.organisation;
      $("#orgName").textContent = o.name;
      $("#facility").textContent = o.facility_name || "";
      $("#orgType").textContent = `Organisation · ${o.type}`;
      $("#orgSample").classList.toggle("hidden", !o.is_sample);
      $("#emStatus").className = `pill ${o.emergency_status === "EMERGENCY" ? "EMERGENCY live" : "NORMAL"}`;
      $("#emStatus").innerHTML = `<span class="dot"></span>${o.emergency_status === "EMERGENCY" ? "Emergency active" : "Normal operations"}`;
      $("#sEmp").textContent = d.stats.employees;
      $("#sSos").textContent = d.stats.activeSos;
      $("#sSafe").textContent = d.stats.safe;
      $("#sNeed").textContent = d.stats.needAssistance;
      $("#fpList").innerHTML = d.floorPlans.map((f) => `<div class="item row between"><span><strong>${esc(f.name)}</strong> <span class="dim">· ${esc(f.floor)}</span></span><span class="dim" style="font-size:12px">updated ${OA.ago(f.updated_at)}</span></div>`).join("") || '<div class="empty">No floor plans yet — upload one in SafeRoute.</div>';
      if (d.floorPlans[0] && !previewLoaded) {
        previewLoaded = true;
        const r = await fetch(`/api/floorplans/${d.floorPlans[0].id}/image`, { headers: { Authorization: `Bearer ${OA.token}` } });
        $("#fpPreview").src = URL.createObjectURL(await r.blob());
      }
      $("#plans").innerHTML = p.plans.map((x) => `<a class="item row between" href="/saferoute?plan=${encodeURIComponent(x.id)}" style="color:inherit"><span><strong>${esc(x.name)}</strong><div class="dim" style="font-size:12px">${x.route.length ? x.route.length + " waypoints" : "no route"}</div></span><span class="pill danger">${esc(OA.catLabel(x.emergencyType))}</span></a>`).join("") || '<div class="empty">No plans.</div>';
      $("#emps").innerHTML = d.employees.map((e) => `<div class="item row between"><div><strong>${esc(e.name)}</strong>${e.is_sample ? ' <span class="pill sample">sample</span>' : ""}<div class="dim" style="font-size:12px">${esc(e.job_title || "")}</div></div>
        <div class="row"><span class="pill ${e.online ? "online" : "not_configured"}"><span class="dot"></span>${e.online ? "online" : "offline"}</span><span class="pill ${e.safety_status}">${e.safety_status.replace("_", " ")}</span></div></div>`).join("");
      OA.icons();
    } catch (e) { OA.toast(esc(e.message), "error"); }
  }
  ["request.new", "request.updated", "alert.updated", "message.new", "org.status", "ws.open"].forEach((t) => OA.on(t, () => setTimeout(load, 200)));
  load();
})();
