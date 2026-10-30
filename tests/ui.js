// Browser UI test using the locally installed Microsoft Edge (playwright-core, no browser download).
//   node tests/ui.js [baseUrl] [screenshotDir]
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const BASE = process.argv[2] || "http://127.0.0.1:3000";
const SHOTS = process.argv[3] || path.join(__dirname, "..", "data", "test-screenshots");
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const external = new Set();
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`); };

async function session(browser, username, pin, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Record any request leaving the OfflineAid server (CDNs, tile servers, cloud APIs...).
  page.on("request", (r) => { const u = new URL(r.url()); if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return; if (u.host !== new URL(BASE).host) external.add(u.host); });
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(`${BASE}/login`);
  await page.fill("#username", username);
  await page.fill("#pin", pin);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith("/login")), page.click("#loginBtn")]);
  return { ctx, page, errors };
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    // ---------- Officer + employee (phone-sized) sessions ----------
    const off = await session(browser, "officer", "2222");
    const emp = await session(browser, "emp1", "3333", { width: 400, height: 860 });
    await off.page.goto(`${BASE}/connect`);
    await emp.page.goto(`${BASE}/connect`);
    await off.page.waitForSelector("#wsPill.online", { timeout: 8000 });
    await emp.page.waitForSelector("#wsPill.online", { timeout: 8000 });
    check("Both dashboards show live WebSocket link", true);

    // Employee sends SOS through the UI
    const t0 = Date.now();
    await emp.page.click("#sosBtn");
    await emp.page.click('[data-cat="fire"]');
    await emp.page.fill("#sosPeople", "3");
    await emp.page.fill("#sosZone", "Assembly Line A");
    await emp.page.fill("#sosDesc", "UI test: smoke near line A");
    await emp.page.click("#sosSend");
    await off.page.waitForSelector('#reqList .item:has-text("UI test: smoke near line A")', { timeout: 8000 });
    check("Officer dashboard shows employee SOS", true, `${Date.now() - t0} ms click-to-display`);
    await emp.page.waitForSelector('#myItems .item:has-text("UI test") .step.current:has-text("RECEIVED")', { timeout: 8000 });
    check("Employee sees SOS state RECEIVED", true);
    await shot(emp.page, "01-employee-sos-received");

    await off.page.click('#reqList .item:has-text("UI test: smoke near line A")');
    await off.page.waitForSelector('#reqDetail [data-act="ack"]');
    await shot(off.page, "02-officer-request-detail");
    await off.page.click('#reqDetail [data-act="ack"]');
    await emp.page.waitForSelector('#myItems .item:has-text("UI test") .step.current:has-text("ACKNOWLEDGED")', { timeout: 8000 });
    check("Employee sees SOS ACKNOWLEDGED", true);

    // Officer sends evacuation alert from template with plan
    await off.page.selectOption("#alertTemplate", "evac");
    await off.page.click('#alertForm button[type="submit"]');
    await emp.page.waitForSelector(".alert-banner", { timeout: 8000 });
    check("Employee receives official alert banner", true);
    await shot(emp.page, "03-employee-alert");
    await emp.page.click('.alert-banner [data-resp="SAFE"]');
    await off.page.waitForSelector('#responseList .item:has-text("I am safe")', { timeout: 8000 });
    check("Officer sees 'I am safe' response", true);
    await off.page.click('#responseList [data-ackresp]');
    await emp.page.waitForSelector('#myItems .item:has-text("I am safe") .step.current:has-text("ACKNOWLEDGED")', { timeout: 8000 });
    check("Employee sees response ACKNOWLEDGED", true);
    await shot(off.page, "04-officer-dashboard");

    // Employee follows the evacuation route link from the alert
    await emp.page.click('.alert-banner a:has-text("evacuation route")');
    await emp.page.waitForSelector("#routeOut .notice.ok", { timeout: 8000 });
    check("Employee opens evacuation route from alert", true, await emp.page.textContent("#routeOut strong"));
    await shot(emp.page, "05-employee-route");

    // ---------- Offline queue: employee loses the server, SOS is queued, then delivered ----------
    await emp.page.goto(`${BASE}/connect`);
    await emp.page.waitForSelector("#wsPill.online");
    await emp.ctx.setOffline(true);
    await emp.page.click("#sosBtn");
    await emp.page.click('[data-cat="medical"]');
    await emp.page.fill("#sosDesc", "UI offline test");
    await emp.page.click("#sosSend");
    await emp.page.waitForSelector('#myItems .item:has-text("UI offline test") .step.current:has-text("QUEUED")', { timeout: 8000 });
    check("Offline SOS stored locally and QUEUED", true);
    await shot(emp.page, "06-employee-queued");
    await emp.page.reload().catch(() => {});
    await emp.ctx.setOffline(false);
    await emp.page.goto(`${BASE}/connect`);
    await off.page.waitForSelector('#reqList .item:has-text("UI offline test")', { timeout: 15000 });
    check("Queued SOS survives refresh and syncs on reconnect", true);

    // ---------- SafeRoute (admin) ----------
    const adm = await session(browser, "admin", "1111");
    await adm.page.goto(`${BASE}/saferoute`);
    await adm.page.waitForSelector("#routeOut .notice.ok", { timeout: 8000 });
    const before = await adm.page.textContent("#routeOut");
    check("SafeRoute shows sample fire plan route", /Assembly Point/.test(before), before.slice(0, 80));
    await shot(adm.page, "07-saferoute");
    // Block the corridor right outside Line A (edge C2--C3) by clicking it
    const hit = await adm.page.$('[data-edge="C2--C3"]');
    await hit.click({ force: true });
    await adm.page.waitForFunction((b) => document.querySelector("#routeOut").textContent !== b, before, { timeout: 8000 });
    check("Blocking a corridor recalculates the route", /blocked/i.test(await adm.page.textContent("#blockedOut")), (await adm.page.textContent("#routeOut")).slice(0, 80));
    await shot(adm.page, "08-saferoute-blocked");

    // ---------- Citizen map ----------
    const cit = await session(browser, "citizen", "5555");
    await cit.page.goto(`${BASE}/map`);
    await cit.page.waitForSelector(".leaflet-container", { timeout: 10000 });
    await cit.page.waitForSelector(".leaflet-control-attribution:has-text(\"OpenStreetMap\")", { timeout: 10000 });
    await cit.page.click('[data-q="hospital"]');
    await cit.page.waitForSelector("#results .result");
    await cit.page.click('#results .result:has-text("Lohia")');
    await cit.page.waitForSelector('#routePanel .stat', { timeout: 10000 });
    check("Citizen hospital search + road route", true, (await cit.page.textContent("#routePanel .stat strong")).trim());
    await cit.page.waitForTimeout(1500);
    await shot(cit.page, "09-citizen-route");
    await cit.page.check("#avoidFlood");
    await cit.page.waitForSelector('#routePanel .notice.ok', { timeout: 10000 });
    check("Avoid-flood reroute in UI", true, (await cit.page.textContent("#routePanel .stat strong")).trim());
    await cit.page.waitForTimeout(800);
    await shot(cit.page, "10-citizen-avoid-flood");

    // ---------- Government ----------
    const gov = await session(browser, "gov", "6666");
    await gov.page.goto(`${BASE}/government`);
    await gov.page.waitForSelector("#feed .item", { timeout: 10000 });
    await gov.page.waitForTimeout(1500);
    check("Government feed + map load", (await gov.page.$$("#feed .item")).length > 0);
    await shot(gov.page, "11-government");

    // ---------- Assistant ----------
    await cit.page.goto(`${BASE}/assistant`);
    await cit.page.waitForSelector("#aiPill.online", { timeout: 15000 });
    await cit.page.click('[data-q="What should I do during an earthquake?"]');
    await cit.page.waitForSelector(".msg.bot .source", { timeout: 60000 });
    check("AI answer with source citations in UI", true, (await cit.page.textContent(".msg.bot .meta")).replace(/\s+/g, " ").trim());
    await shot(cit.page, "12-assistant");

    // ---------- Remaining pages render without JS errors ----------
    for (const [s, p] of [[adm, "/"], [adm, "/organisation"], [adm, "/knowledge"], [adm, "/settings"], [emp, "/saferoute"]]) {
      await s.page.goto(BASE + p);
      await s.page.waitForTimeout(1800);
      await shot(s.page, `page${p.replace(/\//g, "-") || "-overview"}-${s === emp ? "employee" : "admin"}`);
    }
    // Role restriction in UI
    await emp.page.goto(`${BASE}/government`);
    check("Employee blocked from Government page", await emp.page.isVisible("text=Not available for your role"));

    const allErrors = [off, emp, adm, cit, gov].flatMap((s) => s.errors).filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|net::ERR/.test(e));
    check("No requests to any external host (fully local assets)", external.size === 0, [...external].join(", "));
    check("No JavaScript errors in any page", allErrors.length === 0, allErrors.slice(0, 5).join(" | "));
  } catch (e) {
    console.error("UI test aborted:", e.message);
    results.push({ name: "aborted", ok: false });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} UI checks passed · screenshots in ${SHOTS}`);
  process.exit(failed ? 1 : 0);
})();
