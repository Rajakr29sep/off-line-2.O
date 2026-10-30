<p align="center">
  <img src="https://capsule-render.vercel.app/api?type=waving&color=0:0f172a,50:164e63,100:0891b2&height=220&section=header&text=OfflineAid&fontSize=65&fontColor=ffffff&fontAlignY=40&desc=Prepare.%20Navigate.%20Respond.%20Even%20Offline.&descAlignY=62&descSize=18&animation=fadeIn" width="100%" alt="OfflineAid banner"/>
</p>

**An offline-first disaster preparedness and emergency-coordination
platform.**

[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.11-3776AB?logo=python&logoColor=white)](https://python.org/)
[![Ollama](https://img.shields.io/badge/Local_AI-Ollama-111827)](https://ollama.com/)
[![Llama](https://img.shields.io/badge/LLM-Llama_3.2_3B-0467DF)](https://ollama.com/library/llama3.2)
[![Offline](https://img.shields.io/badge/Mode-Offline--First-06B6D4)](#offline-by-design)

**One platform. Three modes. Essential emergency tools that keep working
when the internet does not.**
:::

------------------------------------------------------------------------

## ✨ What is OfflineAid?

OfflineAid combines **organisation evacuation planning**, **two-way
emergency communication**, **local AI assistance**, and **offline
navigation** in one platform. It runs on a laptop and can be accessed by
nearby devices over a local Wi-Fi network.

  -----------------------------------------------------------------------
  Mode                    Designed for            Main capabilities
  ----------------------- ----------------------- -----------------------
  🏢 **Organisation**     Factories, offices,     Floor-plan editor,
                          campuses, hospitals     evacuation routes,
                                                  employee SOS, officer
                                                  alerts

  🏛️ **Government**       Disaster-management     Shared incident feed,
                          teams                   regional map,
                                                  hospitals, shelters,
                                                  flood overlay

  📍 **Citizen**          People affected by      Offline map, local
                          emergencies             place search, emergency
                                                  routes, AI assistant,
                                                  SOS
  -----------------------------------------------------------------------

## 🚨 Core modules

### 🧭 SafeRoute --- Organisation evacuation

Upload a PNG, JPG, or PDF floor plan. Place exits, corridors, assembly
points, and hazards. Build an indoor graph and calculate evacuation
routes. Block a corridor and recalculate the route.

### 📡 OfflineAid Connect --- Two-way SOS

Employee SOS ↔ officer dashboard, official alerts, and employee
responses: **I am safe**, **I need help**, or **I need evacuation**.
Includes five delivery states, persistent queues, and WebSocket updates.

**Network boundary:** devices need a shared local Wi-Fi/hotspot path. If
no communication path exists, messages remain queued; OfflineAid never
claims remote delivery without a path.

### 🧠 Local AI Assistant

Llama 3.2 3B through Ollama, `nomic-embed-text`, ChromaDB, and a ZIM
emergency knowledge pack. Answers are grounded in retrieved passages and
display citations.

### 🗺️ Offline Map

Local PMTiles basemap, SQLite FTS5 place search, and A\* routing over a
regional OpenStreetMap road graph. Includes configured emergency POIs
and an avoid-road option.

### 🏛️ Government View

Shared incident feed on the regional map, with hospitals, shelters, and
a simulated flood GeoJSON overlay.

### 🎙️ Voice (optional)

Microphone → local faster-whisper transcript (editable) → RAG → Piper
speech. Typed input remains available.

> ⚠️ **Safety:** General emergency guidance only. Contact local
> emergency services whenever possible. Demo organisations, accounts,
> incidents, flood zones, and relief camps are simulated and labelled as
> such.

------------------------------------------------------------------------

## ⚡ Quick start

### Prepared demo laptop

``` bat
start.bat
```

The launcher checks Node.js, Python, SQLite/FTS5, Ollama, `llama3.2:3b`,
and `nomic-embed-text`. It starts the FastAPI AI service and Express web
server, waits for health checks, and prints local and LAN URLs.

### One-time setup

Requirements: Windows 10/11, Node.js **22.13+**, Python **3.11**, and
[Ollama](https://ollama.com/).

``` bat
setup.bat
ollama pull llama3.2:3b
ollama pull nomic-embed-text
```

Copy `.env.example` to `.env` and review local configuration.

**OfflineAid does not call a cloud AI API.** If Ollama or a model is
unavailable, the AI page reports that condition. A cached answer is
shown only for the four validated demo questions and is labelled as
cached.

### Manual start

Terminal 1 --- AI service:

``` bat
python_service\.venv\Scripts\python.exe -m uvicorn main:app --app-dir python_service --host 127.0.0.1 --port 8000
```

Terminal 2 --- web app:

``` bat
node server.js
```

Open `http://localhost:3000`.

------------------------------------------------------------------------

## 🔐 Demo accounts

Sample credentials for the local demo database:

  ---------------------------------------------------------------------------------
  Username                            PIN Role             Opens
  ----------------- --------------------- ---------------- ------------------------
  `admin`                          `1111` Facility         Organisation, SafeRoute
                                          administrator    editor, Knowledge
                                                           Sources

  `officer`                        `2222` Safety officer   Connect dashboard,
                                                           alerts

  `emp1`                           `3333` Employee ---     Mobile SOS screen
                                          Arjun Mehta      

  `emp2`                           `4444` Employee ---     Mobile SOS screen
                                          Kavya Rao        

  `citizen`                        `5555` Citizen          Offline map, AI, citizen
                                                           SOS

  `gov`                            `6666` Government       Government incident map
                                          operator         

  `other-officer`                  `7777` Officer of       Organisation-isolation
                                          another          demonstration
                                          organisation     
  ---------------------------------------------------------------------------------

Reset demo data (stop the server first):

``` bash
npm run reset-demo
```

------------------------------------------------------------------------

## 📡 Connect a phone over local Wi-Fi

1.  Start OfflineAid on the laptop using `start.bat`.
2.  Connect the laptop and phone to the **same router or hotspot**.
    Internet access is not required.
3.  Open the LAN URL printed by the launcher on the phone,
    e.g. `http://192.168.0.115:3000`.
4.  If the phone cannot connect, allow Node.js through Windows Firewall
    on **Private** networks.
5.  Sign in on the phone as `emp1` and on the laptop as `officer`.
6.  Send SOS and confirm it appears on the officer dashboard.
7.  Send an officer alert. On the phone, choose **I am safe**. Confirm
    the acknowledgement appears.

### Message delivery states

``` text
STORED_LOCALLY → QUEUED → RELAYED → RECEIVED → ACKNOWLEDGED
```

-   **STORED_LOCALLY:** persisted on sender's device.
-   **QUEUED:** waiting for a network path.
-   **RELAYED:** accepted and persisted by the local server.
-   **RECEIVED:** rendered on recipient's screen and receipt recorded.
-   **ACKNOWLEDGED:** recipient explicitly responded.

If the network path is down, the phone keeps the SOS in IndexedDB and
retries when connectivity returns. The phone and laptop have different
IP addresses; both communicate through the laptop's server.

> Browser limitations: GPS may be unavailable on a phone opened over
> plain `http://<LAN-IP>` because browsers require a secure context. The
> SOS form supports manually entering a location or facility zone.
> Microphone access is also restricted to secure contexts such as HTTPS
> or localhost.

------------------------------------------------------------------------

## 🧠 Offline AI knowledge pack

Prepared demo pack:

`data/zim/offlineaid_emergency_en.zim`

It contains approximately 311 articles built from the project's NDMA,
NIDM, and WHO PDF sources.

Build the pack:

``` bat
python_service\.venv\Scripts\python.exe scripts\build_zim_pack.py
```

On first start, the AI service registers and indexes the pack.
Additional standard Kiwix `.zim` files can be uploaded from **Knowledge
Sources**. Ingestion validates the file, de-duplicates by SHA-256, and
indexes article-by-article rather than loading the entire archive into
memory.

### RAG flow

``` text
Question
   ↓
Query normalisation
   ↓
nomic-embed-text
   ↓
ChromaDB vector retrieval
   ↓
Relevant passages + metadata
   ↓
Llama 3.2 3B via Ollama
   ↓
Citation validation
   ↓
Grounded answer + source articles + disclaimer
```

Retrieval uses the top two passages and a configured cosine-distance
threshold. Citation markers are validated against supplied passages.
CrossEncoder reranking is intentionally omitted from the MVP to reduce
latency and dependencies.

If relevant material is not found in the loaded pack, the assistant says
so instead of inventing a source.

------------------------------------------------------------------------

## 🗺️ Offline map package

Default demo region: **Central New Delhi**.

Bounding box:

``` text
77.19, 28.60, 77.245, 28.645
```

Prepare the regional basemap and OSM data:

``` bat
tools\pmtiles.exe extract https://build.protomaps.com/<build-date>.pmtiles data\maps\region.pmtiles --bbox=77.19,28.60,77.245,28.645 --maxzoom=16

python_service\.venv\Scripts\python.exe scripts\prepare_map.py --bbox 77.19,28.60,77.245,28.645 --name "Central New Delhi"
```

The prepared map directory contains `region.pmtiles`, `roadgraph.json`,
`pois.json`, `region.json`, `osm_raw.json`, and
`flood_simulated.geojson`. The flood/relief-camp layer is simulated demo
data.

**Attribution:** © OpenStreetMap contributors (ODbL); basemap ©
Protomaps.

Do not bulk-download tiles from the public standard OpenStreetMap tile
server. Use properly sourced regional data and respect provider terms.

------------------------------------------------------------------------

## 🎙️ Optional voice setup

``` bat
python_service\.venv\Scripts\python.exe scripts\prepare_voice.py
```

This prepares the local faster-whisper English model and Piper English
voice. If voice models are not installed, the interface reports that
voice is unavailable and typed questions continue to work.

------------------------------------------------------------------------

## 🏗️ Architecture

``` mermaid
flowchart TB
    U["Employee / Officer / Citizen / Government"]
    UI["EJS pages + Vanilla JS + Leaflet"]
    OUT["IndexedDB offline outbox"]
    API["Express REST API + WebSocket"]
    DB[("SQLite: users, requests, alerts, messages, plans, POIs")]
    ROUTE["A* indoor + outdoor routing"]
    AI["FastAPI RAG service"]
    EMB["nomic-embed-text"]
    VDB[("ChromaDB")]
    LLM["Ollama · Llama 3.2 3B"]
    ZIM["Local ZIM knowledge pack"]

    U --> UI
    UI <--> OUT
    UI <-->|"REST + WebSocket"| API
    API <--> DB
    API --> ROUTE
    API -->|"Local proxy"| AI
    ZIM --> VDB
    AI --> EMB
    EMB --> VDB
    VDB --> AI
    AI --> LLM
    LLM --> AI
    AI --> API
```

### Technology stack

  Layer                   Technology
  ----------------------- ------------------------------
  Web application         EJS, vanilla JavaScript, CSS
  Server                  Node.js, Express, WebSocket
  Main database           SQLite (`node:sqlite`)
  Offline browser queue   IndexedDB
  Routing                 A\* in Node.js
  AI service              Python, FastAPI
  Local LLM               Llama 3.2 3B through Ollama
  Embeddings              nomic-embed-text
  Vector store            ChromaDB
  Knowledge format        ZIM
  Map display             Leaflet, PMTiles
  Place search            SQLite FTS5
  Optional voice          faster-whisper, Piper

Full API contract: [`docs/API.md`](docs/API.md)\
Demo walkthrough and fallbacks: [`docs/DEMO.md`](docs/DEMO.md)\
Test results and feature status:
[`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md)

------------------------------------------------------------------------

## 🧪 Tests

``` bat
npm run test:e2e -- http://<LAN-IP>:3000
npm run test:ui -- http://<LAN-IP>:3000
node tests\saferoute_editor.js
npm run test:voice
npm run test:ai
```

The repository includes checks for the Connect cycle, organisation
isolation, SafeRoute, maps, browser workflows, voice, and AI benchmark
questions. See [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md) for
recorded results.

------------------------------------------------------------------------

## 📁 Project structure

``` text
offlineaid/
├── server.js
├── src/
│   ├── db.js
│   ├── seed.js
│   ├── auth.js
│   ├── realtime.js
│   ├── astar.js
│   ├── indoor.js
│   ├── maps.js
│   └── routes/
│       ├── connect.js
│       └── core.js
├── views/pages/
├── public/js/
├── python_service/
│   ├── main.py
│   ├── zim_ingest.py
│   ├── voice.py
│   └── requirements.txt
├── scripts/
├── sample_data/
├── data/                 # Local runtime data; generally not committed
├── docs/
├── tests/
├── legacy/
├── setup.bat
└── start.bat
```

------------------------------------------------------------------------

## 🛡️ Offline by design --- with honest boundaries

Maps, knowledge, model inference, and local application data stay on the
demo machine. Nearby devices can exchange messages through the same
local router or hotspot without internet.

That does **not** mean a phone can contact a remote authority when every
communication path is unavailable. If there is no Wi-Fi, cellular,
radio, satellite, or physical relay, messages remain queued until a path
becomes available.

LoRa / Meshtastic relays, satellite gateways, wider map coverage, CAD
import, advanced evacuation simulation, and additional Indian languages
are future extensions---not claims of the current MVP.

------------------------------------------------------------------------

## 🚀 Hackathon demo flow

1.  **Prepare:** Open a saved factory floor plan and show exits and the
    evacuation route.
2.  **Report:** Send a fire SOS from the employee phone.
3.  **Coordinate:** Officer sends an evacuation alert; employee
    acknowledges.
4.  **Disconnect:** Turn off internet and show the local application
    remains functional.
5.  **Navigate:** Search for a hospital and calculate a route on the
    offline map.
6.  **Monitor:** Switch to Government Mode and show the flood overlay
    and shared requests.
7.  **Ask:** Query Llama 3.2 3B and inspect source citations.
8.  **Speak:** Demonstrate the optional local voice workflow.

**Rehearse the complete flow and record a backup video before the
event.**

------------------------------------------------------------------------

::: {align="center"}
### Prepare. Navigate. Respond. Even Offline.

**OfflineAid --- essential emergency tools, available locally when
connectivity cannot be relied on.**

`<sub>`{=html}Demo data is simulated. Map and knowledge coverage depends
on the locally installed packages.`</sub>`{=html}
:::
