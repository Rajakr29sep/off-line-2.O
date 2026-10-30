# Test results — 30 Oct 2026, demo laptop

Hardware: Intel Core Ultra 5 225H, 15 GB RAM, **no discrete GPU (Ollama runs 100 % on CPU)**, Windows 11.
Software: Node v24.21.0, Python 3.11.9, Ollama with `llama3.2:3b` + `nomic-embed-text:latest` (already installed; nothing re-downloaded).

## Automated suites (run against the LAN IP `http://192.168.0.115:3000`, not only localhost)

| Suite | Result |
|---|---|
| `tests/e2e.js` — API: auth, WebSocket, SOS → RECEIVED → ACKNOWLEDGED, de-duplicated retries, server outbox, alerts with per-recipient states, “I am safe”, org isolation, government scope, SafeRoute, maps | **41 / 41 pass** (SOS reaches officer socket in 4–8 ms) |
| `tests/ui.js` — Edge browser, officer + phone-sized employee sessions, citizen, government, admin, AI | **19 / 19 pass** (incl. *no request to any external host* and *no JS errors*) |
| `tests/saferoute_editor.js` — PDF upload rendered with pdf.js → add 5 nodes → connect → save → reload → route → block → “no route” | **9 / 9 pass** |
| `tests/voice_ui.js` — fake microphone in Edge → MediaRecorder → local faster-whisper | **pass** (transcript in 0.6 s) |
| Voice round-trip (Piper → Whisper) | exact transcript “What should I do during an earthquake?” |
| Node restart persistence | requests, alerts, messages, floor plans, plans all present after restart |
| Security spot checks | HTML disguised as PNG → 415 · random bytes as .zim → 422 · duplicate ZIM → 409 · `../` filenames reduced to basename · URL traversal → 404 · invalid category → 400 · 16 logins/min → 429 · unauthenticated API/WS → 401 / close 4401 |
| `start.bat` | all checks OK, both services started, health + model warm-up detected, LAN URL printed, graceful shutdown stopped both services |

## AI — four demo questions (measured, streaming endpoint, top-2 passages, ≤130 output tokens)

| Question | Grounded | Sources | Run 1 (just after restart): first words / total | Run 2: first words / total |
|---|---|---|---|---|
| Earthquake | yes | Earthquake Preparedness p.5 / p.3 | 3.1 s / **12.5 s** | 0.4 s / 9.6 s |
| Building fire | yes | NDMA Do's & Don'ts p.7 | 4.1 s / 9.8 s | 0.9 s / 7.9 s |
| Flood precautions | yes | NDMA Do's & Don'ts p.5, Flood Preparedness p.4 | 3.7 s / 9.8 s | 0.8 s / 7.2 s |
| First aid | yes | WHO Prehospital Pocket Reference p.7 | 3.7 s / **10.2 s** | 0.9 s / 9.5 s |
| “Who won the 2018 FIFA World Cup?” | “Not found in the loaded knowledge pack.” | none | 0.3 s | 0.7 s |
| “How do I bake a chocolate cake?” | “Not found in the loaded knowledge pack.” | none | 0.3 s | 0.7 s |

**The < 10 s target is met only on repeat runs.** Right after a restart, earthquake (12.5 s) and first aid (10.2 s)
exceeded it, and in the browser UI test the earthquake answer took 12.1–12.8 s total (first words 0.3–0.5 s).
Before tuning, answers took 20–28 s (4 passages, 320 tokens, noisy chunks). Tuning applied: cleaned chunk text (removed
HTML `<title>` and “Source:” boilerplate), top-2 passages × 550 chars, ≤130 output tokens, streaming, prompt-cache warm-up.
Validated answers are cached in `data/ai_cache/demo_answers.json` and shown **only** when the live model is unavailable,
labelled “CACHED ANSWER”. The model was not changed.

Answer-quality notes: the WHO first-aid source is clinical (tourniquet, BVM ventilation) — grounded but not lay-person
friendly; the OCR'd NDMA fire page is noisy, so one fire answer included an unrelated “crackers” bullet in an earlier run.

## Feature status

**Complete and tested**
- SafeRoute: PNG/JPG/PDF upload, zoom/pan/fit/reset, floor selection, add/move/delete/connect/block nodes and edges, node types, save/reload, A* routing incl. nearest exit/assembly, live blocking with re-route and explicit “no route” warning, evacuation plans (fire, earthquake, medical samples) with instructions, route link from alerts.
- Connect: PIN/token auth, roles, org isolation, SOS with category/people/description/floor/zone/GPS-or-manual location, officer dashboard, acknowledge/status/instructions, official alerts (officer/admin only, signed with name + role), employee responses, 5 delivery states, SQLite persistence + server outbox with retry counts, IndexedDB queue surviving refresh, idempotent sync, WebSocket push with polling fallback.
- AI: Ollama health + model checks at startup, ZIM upload/validation/metadata/progress/dedup/removal/re-index, incremental article-aware chunking, ChromaDB with source metadata, grounded answers with validated citations (ZIM file, article, origin PDF page, excerpt), weak-retrieval “not found”, disclaimer on every answer, no cloud fallback.
- Maps: local PMTiles basemap, FTS5 search (hospital, shelter, police, fire, pharmacy), A* on real OSM roads (walk/drive), avoid simulated flood zones, GPS-or-manual start, OSM attribution.
- Government: shared feed (citizen + opted-in organisations only), incident markers, hospitals, shelters, police/fire, flood overlay toggle, dispatch/resolve.
- Voice: local faster-whisper STT (editable transcript), Piper TTS, typed input always available.
- System status page with real checks; `start.bat`, `setup.bat`, `npm run reset-demo`.

**Partial / needs manual verification**
- **Phone over real Wi-Fi was not tested with a second physical device** — LAN behaviour was tested by addressing the laptop's LAN IP from the laptop itself. Windows Firewall may need a Private-network rule for Node.js.
- **Full internet-disconnected run not performed by me** (I did not cut the laptop's connection). Evidence instead: the browser suite recorded zero requests to any host other than the OfflineAid server, and Ollama/ChromaDB/maps run locally. Please do the README offline checklist once.
- AI latency target: see above (met on repeat runs, not on every first run).
- GPS and microphone are blocked by browsers on `http://<LAN-IP>` (secure-context rule) — phones use manual location; voice works on the laptop (localhost).
- Shelters: only 3 real OSM emergency assembly points exist in the region; relief camps are simulated.
- Multi-floor buildings: one plan per floor; stairs nodes do not link floors.
- Earthquake/medical sample plans are saved and routable; only the fire workflow was rehearsed end-to-end.

**Not implemented (future)**
- LoRa / Meshtastic / satellite relay; HTTPS on the LAN; push notifications when the browser is closed; admin UI for creating users/organisations (accounts are seeded); Hindi or other languages; automatic multi-floor routing.
