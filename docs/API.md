# OfflineAid API contract

Base: `http://<laptop>:3000/api`. JSON in/out. Auth: `Authorization: Bearer <token>` (or the `oa_token` HttpOnly cookie).
Errors: `{ "error": "message" }` with 400/401/403/404/409/413/415/422/429/503. No stack traces or file paths are returned.
All organisation data is scoped server-side by the caller's `organisationId`; other organisations get **404**.

## Roles and permissions

| Role | Key permissions |
|---|---|
| employee | request:create, request:read_own, alert:read_own, alert:respond, map:read, ai:ask |
| officer | + request:read_org, request:update, alert:send, message:send, floorplan:read, plan:read, org:read |
| administrator | officer + floorplan:write, plan:write, ai:sources |
| citizen | request:create, request:read_own, map:read, ai:ask |
| government_operator | request:read_shared, request:update_shared, map:read, ai:ask, gov:read (only citizen requests and organisations with `share_with_government = 1`) |

## Authentication
| Method | Path | Notes |
|---|---|---|
| POST | /auth/login | `{username, pin}` → `{token, expiresAt, user}`; rate-limited 15/min/IP; PINs stored with scrypt |
| POST | /auth/logout | revokes the session |
| GET | /auth/me | current user + permissions |
| GET | /auth/demo-accounts | sample accounts (names/roles only, no PINs) |

## Organisation
| GET | /organisations/:id | own organisation only |
|---|---|---|
| GET | /organisations/:id/dashboard | stats (employees, activeSos, safe, needAssistance, plans…), employees with safety status + online presence, floor plans |
| PATCH | /organisations/:id/emergency-status | `{status: NORMAL|EMERGENCY}`; NORMAL closes alerts and resets safety status (officer/admin) |

## Emergency requests (SOS)
| Method | Path | Notes |
|---|---|---|
| POST | /requests | `{clientId, category, description, peopleAffected, latitude?, longitude?, floorId?, zoneId?}`; idempotent on `clientId` (200 + `duplicate:true` on retry) |
| GET | /requests | own (employee/citizen), organisation (officer/admin), shared (government); `?status=` |
| GET | /requests/:id | request + message thread |
| POST | /requests/:id/received | recipient dashboard receipt → `RECEIVED` |
| POST | /requests/:id/acknowledge | explicit acknowledgement → `ACKNOWLEDGED` |
| PATCH | /requests/:id/status | `{status: OPEN|IN_PROGRESS|RESOLVED}` (also acknowledges) |

Categories: `fire, medical, earthquake, flood, building_collapse, rescue, other`.

## Alerts and messages
| Method | Path | Notes |
|---|---|---|
| POST | /alerts | officer/admin only: `{clientId, title, message, category, severity, evacuationPlanId?, requestId?, recipientIds?}` → per-employee delivery rows |
| GET | /alerts | officer: org alerts with per-recipient states + counts; employee: own alerts with own state |
| POST | /alerts/:id/received | employee device receipt |
| POST | /alerts/:id/respond | `{clientId, response: SAFE|NEED_HELP|NEED_EVACUATION|UPDATE, note?}` → alert ACKNOWLEDGED + response message + safety status |
| POST | /messages | `{clientId, requestId, text}` officer instruction (to sender) or sender update (to officers) |
| GET | /messages | messages visible to the caller |
| POST | /messages/:id/received · /messages/:id/acknowledge | recipient receipts |
| GET | /messages/pending | **server outbox** for the caller: undelivered alerts/messages (each poll increments `retry_count`), and for officers unreceived requests/responses |
| POST | /messages/sync | `{items:[{kind: sos|alert_response|message, clientId, clientCreatedAt, payload}]}` → per-item `{ok, serverId, deliveryStatus, duplicate}`; used by the browser IndexedDB outbox |

WebSocket `ws://<host>/ws?token=…` (push only, REST is the source of truth): `hello`, `request.new`, `request.updated`,
`alert.new`, `alert.updated`, `message.new`, `message.updated`, `org.status`. Clients re-sync via `/messages/pending` on reconnect.

## Floor plans and evacuation plans (SafeRoute)
| Method | Path | Notes |
|---|---|---|
| POST | /floorplans | multipart: `image` (PNG/JPG, magic-byte checked; PDFs are rendered to PNG in the browser with pdf.js), optional `original` PDF, `name, floor, width, height`; 15 MB limit; server-generated filenames |
| GET | /floorplans | `?graph=1` to include nodes/edges |
| GET | /floorplans/:id | plan + graph |
| GET | /floorplans/:id/image · /original | authenticated, org-scoped file download |
| PUT | /floorplans/:id | `{nodes:[{id,x,y,type,label,blocked,floorId}], edges:[{source,destination,cost?,blocked}]}` validated |
| POST | /floorplans/:id/route | `{start, destination | nearest_exit | nearest_assembly | nearest_safe, blockedNodes?, blockedEdges?}` |
| POST | /evacuation-plans | `{floorPlanId, name, emergencyType, startNode, destinationNode, blockedNodes, blockedEdges, instructions}` → plan + computed route |
| GET | /evacuation-plans | `?floorPlanId=` |
| GET / PUT / DELETE | /evacuation-plans/:id | |
| POST | /evacuation-plans/:id/calculate-route | plan blocks + extra live `blockedNodes/blockedEdges` → route or `{ok:false, reason}` (never a fake route) |

Node types: `entrance, exit, corridor, room, stairs, assembly, extinguisher, first_aid, medical, restricted, hazard`
(`restricted` and `hazard` are impassable). Edge id = sorted `"A--B"`.

## Maps
| GET | /maps/region | region metadata, tiles URL (`/maps/region.pmtiles`, HTTP range), graph stats |
|---|---|---|
| GET | /maps/places/search | `?q=hospital&lat=&lon=&category=&limit=` (SQLite FTS5 + distance sort) |
| GET | /maps/places | `?categories=hospital,shelter,police,fire_station` |
| GET | /maps/route | `?fromLat&fromLon&toLat&toLon&mode=walk|drive&avoidFlood=1&avoidRoads=Name1|Name2` → `{ok, coords, distanceMetres, walkMinutes, steps, crossesFloodZone, computeMs}` |
| GET | /maps/hazards | simulated flood GeoJSON |

## AI (proxied to the local FastAPI service; never to a cloud API)
| Method | Path | Notes |
|---|---|---|
| GET | /ai/health | Ollama reachability, model availability, warm state, index stats, voice status |
| POST | /ai/ask | `{question}` → `{answer, grounded, citations_explicit, sources:[{n,title,zim_file,path,origin_file,origin_page,excerpt,distance}], disclaimer, model, cached, timing}` |
| POST | /ai/ask/stream | same, as NDJSON: `retrieved` → `token`* → `done` |
| GET | /ai/sources · /ai/sources/:id/status | KnowledgeSource `{id, filename, title, size, status, article_count, chunk_count, indexed_at, …}` |
| POST | /ai/sources/upload | multipart `file` (.zim), streamed; validated, SHA-256 de-duplicated (admin) |
| POST | /ai/sources/:id/reindex · DELETE /ai/sources/:id | admin |
| POST | /ai/voice/transcribe | multipart `audio` → `{text, ms, engine}` (local faster-whisper) |
| POST | /ai/voice/speak | `{text}` → `audio/wav` (local Piper) |

## System
| GET | /health | Node liveness |
|---|---|---|
| GET | /system/status | real checks: node, sqlite, fastapi, ollama, llm, embedding, knowledge, maps, network (LAN IPs + internet reachability) with states `online | offline | degraded | not_configured` |
