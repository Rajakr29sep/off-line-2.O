// Browser voice test: Edge with a fake microphone that plays data/voice/test_question.wav.
//   node tests/voice_ui.js   (uses http://localhost:3000 — microphones require a secure context such as localhost)
const { chromium } = require("playwright-core");
const path = require("path");
(async () => {
  const wav = path.resolve(__dirname, "..", "data", "voice", "test_question.wav");
  const browser = await chromium.launch({ channel: "msedge", headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  await page.goto("http://localhost:3000/login");
  await page.fill("#username", "citizen"); await page.fill("#pin", "5555");
  await Promise.all([page.waitForURL(/\/map/), page.click("#loginBtn")]);
  await page.goto("http://localhost:3000/assistant");
  await page.waitForSelector("#micBtn:not([disabled])", { timeout: 15000 });
  await page.click("#micBtn");
  await page.waitForTimeout(4000);
  await page.click("#micBtn");
  await page.waitForFunction(() => document.querySelector("#q").value.length > 5, null, { timeout: 30000 });
  const text = await page.inputValue("#q");
  const ok = /earthquake/i.test(text);
  console.log(`${ok ? "PASS" : "FAIL"}  Browser mic -> local Whisper transcript: "${text}"`);
  console.log("      ", await page.textContent("#voiceNote"));
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
