# OfflineAid

**Prepare. Navigate. Respond. Even Offline.**

OfflineAid is an offline-first disaster preparedness and emergency-coordination platform that runs on one laptop.
Three modes — **Organisation**, **Government** and **Citizen** — share one backend, one database, one request feed and one map component.

| Module | What it does | Runs without internet? |
|---|---|---|
| SafeRoute (Organisation) | Upload a floor plan (PNG/JPG/PDF), place exits, corridors, assembly points, hazards; A* evacuation routing that re-routes around blocked corridors; saved evacuation plans | Yes |
| Connect | Employee SOS ↔ officer dashboard, official alerts, “I am safe / need help / need evacuation”, 5 delivery states, SQLite + IndexedDB offline queues, WebSocket push | Yes — devices need the same **local Wi-Fi / hotspot** |
| AI Assistant | Llama 3.2 3B (Ollama) + nomic-embed-text + ChromaDB over a ZIM knowledge pack, grounded answers with citations | Yes |
| Offline Map (Citizen) | Local PMTiles basemap, SQLite FTS5 place search, A* routing on a real OSM road graph, avoid flood zones | Yes |
| Government | Shared incident feed + regional map, hospitals, shelters, simulated flood overlay | Yes |
| Voice | Mic → local faster-whisper transcript (editable) → RAG → Piper speech | Yes (after one-time model download) |

> General emergency guidance only. Contact local emergency services whenever possible.
> All demo organisations, accounts, incidents, flood zones and relief camps are **simulated** and labelled as such.

---

## Quick start (demo laptop, already prepared)

```bat
start.bat
```

`start.bat` checks Node, Python, directories, SQLite/FTS5, Ollama, `llama3.2:3b` and `nomic-embed-text`
(never downloads models), starts Ollama if needed, starts the AI service (FastAPI :8000) and the web server (Express :3000),
waits for both health checks and the model warm-up, then prints the **localhost** and **LAN** URLs.
Press any key in that window to stop everything gracefully. Data stays in `data\`.

Manual start (two terminals):

```bat
python_service\.venv\Scripts\python.exe -m uvicorn main:app --app-dir python_service --host 127.0.0.1 --port 8000
node server.js
```

### Demo accounts (sample data)

| Username | PIN | Role | Opens |
|---|---|---|---|
| `admin` | 1111 | Facility administrator (Sunrise Components, sample) | Organisation, SafeRoute editor, Knowledge Sources |
| `officer` | 2222 | Safety officer | Connect officer dashboard, alerts |
| `emp1` | 3333 | Employee — Arjun Mehta | Mobile SOS screen |
| `emp2` | 4444 | Employee — Kavya Rao | Mobile SOS screen |
| `citizen` | 5555 | Citizen | Offline map, AI, citizen SOS |
| `gov` | 6666 | Government operator | Government incident map |
| `other-officer` | 7777 | Officer of a *different* organisation | Used to prove organisation isolation |

Reset demo data (stop the server first): `npm run reset-demo`.

---

## One-time setup (needs internet once)

Requirements: Windows 10/11, **Node.js 22.13+** (built-in `node:sqlite`), **Python 3.11**, **Ollama**.

```bat
setup.bat                                   :: npm install + python venv + pip install
ollama pull llama3.2:3b                     :: skip if `ollama list` already shows it
ollama pull nomic-embed-text                :: embeddings
```

`OLLAMA_MODEL`, `OLLAMA_EMBEDDING_MODEL` and other settings live in `.env` (copied from `.env.example`).
OfflineAid **never** calls a cloud AI API. If Ollama or a model is missing, the AI page says so; a clearly labelled
cached answer is shown only for the four validated demo questions.

### Knowledge pack (ZIM)

The bundled pack `data/zim/offlineaid_emergency_en.zim` (~0.5 MB, 311 articles) is a real ZIM file built from the
project's NDMA / NIDM / WHO PDFs in `knowledge_base/` — one article per page, scanned pages OCR'd with Tesseract:

```bat
python_service\.venv\Scripts\python.exe scripts\build_zim_pack.py
```

On first start the AI service registers and indexes it automatically (≈2 min on CPU). Any standard Kiwix `.zim`
can be added from **Knowledge Sources** (upload → validated → de-duplicated by SHA-256 → indexed article-by-article,
never loading the whole archive into RAM). Large packs index slowly on CPU: prepare them before the demo.

### Offline map package

Default region: **Central New Delhi** (bbox `77.19,28.60,77.245,28.645`). To change it, use the same bbox in both commands:

```bat
:: 1. basemap tiles (PMTiles vector extract from the public Protomaps daily build, ~2.4 MB for this bbox)
tools\pmtiles.exe extract https://build.protomaps.com/20261029.pmtiles data\maps\region.pmtiles --bbox=77.19,28.60,77.245,28.645 --maxzoom=16
:: 2. places + routable road graph from OpenStreetMap (Overpass API)
python_service\.venv\Scripts\python.exe scripts\prepare_map.py --bbox 77.19,28.60,77.245,28.645 --name "Central New Delhi"
```

(`tools\pmtiles.exe` is go-pmtiles for Windows; pick a current build date from https://build-metadata.protomaps.dev/builds.json.)
Outputs in `data/maps/`: `region.pmtiles`, `roadgraph.json` (21,877 nodes / 24,271 edges), `pois.json` (27 hospitals,
22 clinics, 24 police, 3 fire stations, 11 pharmacies, 3 emergency assembly points), `region.json`, `osm_raw.json`.
`flood_simulated.geojson` is hand-made **simulated** demo data (2 water-logging zones, 2 relief camps).
Bus shelters/gazebos tagged `amenity=shelter` are deliberately *not* treated as disaster shelters.
Attribution: © OpenStreetMap contributors (ODbL); basemap © Protomaps.

### Voice (optional)

```bat
python_service\.venv\Scripts\python.exe scripts\prepare_voice.py   :: faster-whisper base.en (~141 MB) + Piper en_US-lessac-medium (~61 MB)
```

Without these models voice is shown as “not installed” and typing keeps working; speech output then uses the
device's *local* OS voices only (`localService` voices — never cloud voices).
Browsers only allow the microphone on `https` or `localhost`, so voice input works on the laptop browser, not on
phones opened over `http://<LAN-IP>`.

---

## Local Wi-Fi setup (phones)

1. Start OfflineAid on the laptop with `start.bat`. The server binds to `0.0.0.0` (`HOST` in `.env`).
2. Connect the laptop and the phone(s) to the **same router or hotspot** (a phone hotspot works; internet is not required).
3. `start.bat` / Settings page prints the LAN URL, e.g. `http://192.168.0.115:3000`. Open it on the phone.
4. If the phone cannot connect, allow Node.js through Windows Firewall for **Private** networks
   (Windows Security → Firewall → Allow an app → Node.js) and make sure the Wi-Fi profile is set to *Private*.
5. Sign in on the phone as `emp1`, on the laptop as `officer`. Send SOS → it appears on the officer dashboard.
6. Officer sends an alert (template “Fire — evacuate now”) → phone shows the alert banner and the route link.
7. Phone taps “I am safe” → officer sees it and acknowledges → phone shows **ACKNOWLEDGED**.

The phone and the laptop have different IP addresses; everything goes through the laptop's server. If the network path
is down, the phone keeps the SOS in IndexedDB (**QUEUED**) and delivers it automatically when the path returns.
OfflineAid does not claim delivery without a network path. LoRa / Meshtastic / satellite relays are future work.

On a phone opened over `http://<LAN-IP>` the browser blocks GPS (secure-context rule) — the SOS form lets the user type a
location/zone instead.

---

## Architecture

```
Browser (EJS pages + vanilla JS, Leaflet, pdf.js, IndexedDB outbox)
   │  REST + WebSocket (/ws)                        all assets served locally from node_modules
   ▼
Express (server.js, src/)  ── node:sqlite  data/offlineaid.db  (users, sessions, requests, alerts, messages,
   │                                         floor plans, evacuation plans, places + FTS5, audit log)
   │  A* indoor routing (src/indoor.js) + A* road routing (src/maps.js) on data/maps/roadgraph.json
   ▼  HTTP proxy (127.0.0.1 only)
FastAPI (python_service/main.py) ── Ollama: llama3.2:3b (answers), nomic-embed-text (embeddings)
                                 ── ChromaDB data/chroma (cosine), ZIM ingestion (zim_ingest.py)
                                 ── optional voice: faster-whisper + Piper (voice.py)
```

RAG pipeline: question → normalise → nomic-embed-text → ChromaDB top-2 (cosine distance ≤ 0.45, else
“Not found in the loaded knowledge pack”) → prompt with numbered passages → Llama 3.2 3B (streamed) → citation
validation (only `[n]` that match supplied passages survive) → answer + sources (ZIM file, article title, origin PDF page,
excerpt) + disclaimer. **CrossEncoder reranking was removed** for the MVP (latency and dependency size).

Delivery states: `STORED_LOCALLY` (sender IndexedDB) → `QUEUED` (no server path, retried every 5 s and on reconnect)
→ `RELAYED` (persisted by the local server) → `RECEIVED` (recipient screen rendered it and posted a receipt)
→ `ACKNOWLEDGED` (recipient explicitly responded). Sync is idempotent on a client-generated `clientId`.

Full API contract: [docs/API.md](docs/API.md). Demo script with fallbacks: [docs/DEMO.md](docs/DEMO.md).
Test results and feature status: [docs/TEST_RESULTS.md](docs/TEST_RESULTS.md).

## Tests

```bat
npm run test:e2e   -- http://<LAN-IP>:3000     :: 41 API checks: Connect cycle, isolation, SafeRoute, maps
npm run test:ui    -- http://<LAN-IP>:3000     :: 19 browser checks with local Edge (playwright-core), screenshots in data\test-screenshots
node tests\saferoute_editor.js                 :: PDF upload → editor → save → reload → route
npm run test:voice                             :: fake microphone → local Whisper transcript
npm run test:ai                                :: 4 demo questions + 2 unrelated, measures latency
```

## Project structure

```
server.js                 Express bootstrap, pages, vendor assets, WebSocket
src/db.js seed.js auth.js realtime.js astar.js indoor.js maps.js
src/routes/connect.js     requests, alerts, messages, pending outbox, sync
src/routes/core.js        auth, organisations, floor plans, evacuation plans, maps, AI proxy, system status
views/pages/*.ejs         overview, login, organisation, saferoute, connect, assistant, map, government, knowledge, settings
public/js/*.js            core (API, WS, IndexedDB outbox), one script per page, oamap (shared map component)
python_service/           main.py (FastAPI RAG), zim_ingest.py, voice.py, requirements.txt
scripts/                  build_zim_pack.py, prepare_map.py, prepare_voice.py, reset-demo.js
sample_data/              factory floor plan (SVG/PNG/PDF, simulated)
data/                     runtime data: db, uploads, chroma, zim, maps, voice, ai_cache (cached demo answers)
legacy/                   previous PDF-RAG main.py (with CrossEncoder) and the original single-page UI
tests/                    e2e.js, ui.js, saferoute_editor.js, voice_ui.js, ai_bench.py
```
