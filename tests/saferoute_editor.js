// SafeRoute editor test: upload a PDF floor plan (rendered by pdf.js), add nodes, connect, save, reload, route.
//   node tests/saferoute_editor.js [baseUrl]
const { chromium } = require("playwright-core");
const path = require("path");
const BASE = process.argv[2] || "http://127.0.0.1:3000";
const results = [];
const check = (n, ok, d = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? "  — " + d : ""}`); };

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => d.accept());
  try {
    await page.goto(`${BASE}/login`);
    await page.fill("#username", "admin"); await page.fill("#pin", "1111");
    await Promise.all([page.waitForURL(/organisation/), page.click("#loginBtn")]);
    await page.goto(`${BASE}/saferoute`);
    await page.waitForSelector("#routeOut .notice");

    // Upload PDF
    await page.click("#uploadBtn");
    await page.setInputFiles("#upFile", path.join(__dirname, "..", "sample_data", "factory_floorplan.pdf"));
    await page.waitForSelector("#pdfPageWrap:not(.hidden)", { timeout: 15000 });
    check("PDF opened in browser with pdf.js (page selector shown)", true);
    await page.fill("#upName", "E2E uploaded plan");
    await page.fill("#upFloor", "Test floor");
    await page.click("#upGo");
    await page.waitForFunction(() => document.querySelector("#fpSelect").selectedOptions[0]?.textContent.includes("E2E uploaded plan"), null, { timeout: 15000 });
    check("PDF page rendered to PNG and uploaded as a new floor plan", true);

    // Build a tiny graph: room -> corridor -> exit -> assembly
    const box = await (await page.$("#stage")).boundingBox();
    const at = (fx, fy) => ({ x: box.x + box.width * fx, y: box.y + box.height * fy });
    await page.click('[data-mode="add"]');
    const place = async (type, fx, fy) => { await page.selectOption("#addType", type); const p = at(fx, fy); await page.mouse.click(p.x, p.y); };
    await place("room", 0.25, 0.35);      // selected after add
    await place("corridor", 0.45, 0.5);   // corridors auto-connect to the selected node
    await place("corridor", 0.65, 0.5);
    await place("exit", 0.8, 0.5);
    await place("assembly", 0.9, 0.8);
    const nodeIds = await page.$$eval("[data-node]", (els) => els.map((e) => e.dataset.node));
    check("Five nodes placed on the uploaded plan", nodeIds.length === 5, nodeIds.join(","));
    // Connect the remaining links with the Connect tool
    await page.click('[data-mode="connect"]');
    const clickNode = async (id) => { const el = await page.$(`[data-node="${id}"] circle:last-of-type`); await el.click({ force: true }); };
    const [room, c1, c2, exit, ap] = nodeIds;
    await clickNode(c2); await clickNode(exit);
    await clickNode(exit); await clickNode(ap);
    const edgeCount = await page.$$eval("[data-edge]", (els) => els.length);
    check("Connections drawn with Connect tool", edgeCount === 4, `${edgeCount} edges`);
    await page.click("#saveBtn");
    await page.waitForSelector(".toast.ok", { timeout: 5000 });
    check("Graph saved", true);

    // Reload and verify persistence, then route
    await page.reload();
    await page.waitForSelector("#fpSelect option", { state: "attached" });
    const fpId = await page.$eval("#fpSelect", (s) => [...s.options].find((o) => o.textContent.includes("E2E uploaded plan")).value);
    await page.selectOption("#fpSelect", fpId);
    await page.waitForFunction(() => document.querySelectorAll("[data-node]").length === 5, null, { timeout: 10000 });
    check("Nodes and edges persist after reload", (await page.$$eval("[data-edge]", (e) => e.length)) === 4);
    await page.selectOption("#startSel", room);
    await page.selectOption("#destSel", "nearest_assembly");
    await page.click("#routeBtn");
    await page.waitForSelector("#routeOut .notice.ok", { timeout: 8000 });
    check("Route calculated on uploaded plan", true, (await page.textContent("#routeOut .notice")).replace(/\s+/g, " ").trim());
    await page.screenshot({ path: path.join(__dirname, "..", "data", "test-screenshots", "13-uploaded-pdf-plan.png") });
    // Block the only corridor -> no route
    await page.click('[data-mode="block"]');
    await page.click(`[data-node="${c1}"] circle:last-of-type`, { force: true });
    await page.waitForSelector("#routeOut .notice.danger", { timeout: 8000 });
    check("Blocking the only path shows 'No safe route'", true);
    check("No JavaScript errors", errors.length === 0, errors.join(" | "));
  } catch (e) { console.error("aborted:", e.message); results.push(false); }
  await browser.close();
  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} editor checks passed`);
  process.exit(failed ? 1 : 0);
})();
