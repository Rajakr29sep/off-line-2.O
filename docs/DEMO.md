# Five-minute demo script (with fallbacks)

**Before judges arrive (10 min):**
1. `npm run reset-demo` (removes test data), then `start.bat`. Wait for “model loaded”.
2. Laptop browser window A: sign in `officer` / 2222 → **Connect**. Window B (or phone on the same hotspot via the LAN URL): `emp1` / 3333 → **Connect**.
3. Window C: `admin` / 1111 → **SafeRoute** (sample fire plan route already drawn).
4. Ask each of the four demo questions once on **AI Assistant** (warms the model; measured: the first run after a restart is ~10–12.5 s, repeat runs 7–9.6 s).
5. Check the top bar of Overview: every system indicator is a live check.

| Time | Step | What to show | Fallback |
|---|---|---|---|
| 0:00 | Intro | “Networks fail in disasters. OfflineAid keeps essential functions local.” Overview → live system status | Screenshot `data/test-screenshots/page-overview-admin.png` |
| 0:20 | Organisation | SafeRoute: factory plan with exits (E), assembly points (A), extinguishers, hazards. Fire plan route Line A → Assembly Point B. Click the corridor right of the Line A door → red ✕, route recalculates via the West Exit. Block more → “No safe route” warning | Select the plan again from the dropdown; screenshot `08-saferoute-blocked.png` |
| 1:00 | SOS | Employee: SOS → Fire → 3 people → “Assembly Line A” → Send. Show STORED LOCALLY → RELAYED → RECEIVED; officer dashboard flashes the new request | If phone Wi-Fi fails, use window B on the laptop |
| 1:40 | Two-way | Officer: open request → Acknowledge → template “Fire — evacuate now” (route attached) → Send. Employee sees alert, taps “Show my evacuation route”, then “I am safe”. Officer acknowledges the response; employee shows ACKNOWLEDGED. Alert panel shows per-employee RELAYED/RECEIVED/ACKNOWLEDGED | `node tests/e2e.js` prints the whole cycle with timings |
| 2:30 | Offline | Disconnect Wi-Fi internet / unplug router WAN. Top bar switches to “Offline mode · no internet” (real DNS check). Optionally put the employee browser offline: SOS shows QUEUED, then delivers on reconnect | — |
| 2:45 | Citizen | `citizen` / 5555 → Offline Map → “Hospital” → Dr. Ram Manohar Lohia Hospital → 1.61 km route. Tick “Avoid flood zones” → 2.09 km route around the simulated water-logging zone | Screenshots `09-citizen-route.png`, `10-citizen-avoid-flood.png` |
| 3:30 | Government | `gov` / 6666 → map with flood overlay (SIMULATED), hospitals, shelters, incidents; the factory SOS appears in the shared feed; Dispatch / Resolve | Screenshot `11-government.png` |
| 4:00 | Llama AI | Ask “What should I do during an earthquake?” — streaming answer, citations with ZIM file + article + PDF page + excerpt, disclaimer, measured time | If Ollama fails, the same question returns a clearly labelled **CACHED ANSWER**; never a cloud model |
| 4:40 | Voice | Laptop browser (localhost): mic → speak → transcript appears (editable) → send → Piper speaks the answer | Type the question; click “Speak” |
| 5:00 | Close | Offline maps, local AI, evacuation planning, local-network coordination — all on one laptop | — |

Record a full backup video of this sequence once it runs cleanly.
