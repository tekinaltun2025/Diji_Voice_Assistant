# Agent Control API

**English** · [🇹🇷 Türkçe](../API.md)

While running, the agent opens a small HTTP + SSE server on `127.0.0.1:8899`
([`agent/src/control-server.ts`](../../agent/src/control-server.ts)). The desktop
UI manages the agent **only** through these endpoints: the process that opens the
microphone, the audio devices and the engines is **one** — the agent process.

> [!IMPORTANT]
> The server is bound to the constant `CONTROL_HOST = '127.0.0.1'`; it does
> **not** listen on `0.0.0.0`
> ([`control-server.ts:30`](../../agent/src/control-server.ts)).
> It is unreachable from the outside; without a local process the port is not
> listening at all.

---

## Table of contents

- [Transport](#transport)
- [Endpoint summary](#endpoint-summary)
- [`GET /health`](#get-health)
- [`GET /state`](#get-state)
- [`GET /events` — SSE](#get-events--sse)
- [`POST /listen`](#post-listen)
- [`POST /ask`](#post-ask)
- [`POST /inject`](#post-inject)
- [`POST /tts`](#post-tts)
- [`POST /confirm`](#post-confirm)
- [`POST /bargein`](#post-bargein)
- [`GET /models`](#get-models)
- [`POST /models/select`](#post-modelsselect)
- [SSE event schemas](#sse-event-schemas)
- [Error codes](#error-codes)
- [Quick cURL recipes](#quick-curl-recipes)

---

## Transport

| Topic | Value |
|---|---|
| Host | `127.0.0.1` (constant) |
| Default port | `8899` — override with `DIJI_CONTROL_PORT` |
| Response type | `application/json; charset=utf-8` |
| CORS | `Access-Control-Allow-Origin: *` (local only) |
| Methods | `GET`, `POST`, `OPTIONS` |
| Caching | `Cache-Control: no-store` |
| Body limit | 1 MB (`readBody` truncates above it) |

Every JSON response carries at least an `ok: boolean` field. When `ok:false`
there is usually an `error: string`.

```ts
// agent/src/control-server.ts:51
const send = (res, status, body): void => { /* JSON + CORS headers */ };
```

An `OPTIONS` request returns an empty `204`; required for browser preflight.

---

## Endpoint summary

| Method | Path | Purpose | Typical status |
|---|---|---|---|
| `GET` | `/health` | Is the process alive | `200` |
| `GET` | `/state` | Full instantaneous state snapshot | `200` |
| `GET` | `/events` | Live telemetry stream (SSE) | `200` (stream) |
| `POST` | `/listen` | Turn the microphone on/off | `200` |
| `POST` | `/ask` | Start a text turn | `202` |
| `POST` | `/inject` | Feed PCM as if it came from the mic (diagnostics) | `202` |
| `POST` | `/tts` | Turn speech output on/off | `200` |
| `POST` | `/confirm` | Answer a pending MCP confirmation | `200` |
| `POST` | `/bargein` | Interrupt speech/playback | `200` |
| `GET` | `/models` | Model catalog for Settings | `200` |
| `POST` | `/models/select` | Switch model (+ persist) | `200` / `409` |

If the pipeline has not been constructed yet (`getPipeline()` → `null`), the
endpoints that need it return `503 { ok:false, error:"agent not ready" }`.

---

## `GET /health`

Liveness check for the agent process. The UI connection indicator and the wait
loop in the launcher scripts both use it.

```json
{ "ok": true, "pid": 41213, "uptime": 137 }
```

| Field | Type | Description |
|---|---|---|
| `pid` | `number` | Agent process id. Use this to terminate the process (**not** `pkill -f` — that kills your own shell). |
| `uptime` | `number` | Uptime in seconds. |

---

## `GET /state`

A single request summarising **everything** the UI needs. The UI calls it once on
startup and then keeps it fresh through SSE.

```jsonc
{
  "ok": true,
  "pid": 41213,
  "uptime": 137,
  "pipeline": {
    "running": true,
    "sessionId": "s-9f1c…",
    "state": {
      "isListening": true,
      "isSpeaking": false,
      "isProcessing": false,
      "isBargeIn": false,
      "lastTranscript": "do I have a meeting tomorrow",
      "lastResponse": "You have a meeting tomorrow at 14:00.",
      "lastTurnLatency": { "totalMs": 1840 }
    },
    "audio": {
      "running": true,
      "device": "default",
      "totalBytes": 5216000,
      "forwardedChunks": 1630,
      "skippedChunks": 0,
      "restarts": 0,
      "acRms": 0.0412,
      "silenceThreshold": 0.002
    }
  },
  "ttsEnabled": true,
  "ttsOverride": null,
  "stages": [ { "key": "stt", "label": "STT", "status": "active", "detail": "…", "metrics": {}, "updatedAt": 1761798123456 } ],
  "log": [ { "id": 812, "t": 1761798123456, "level": "info", "stage": "mic", "msg": "listening enabled" } ],
  "turnMetrics": { "sttMs": 412, "llmFirstTokenMs": 980, "llmTotalMs": 980, "ttsFirstByteMs": 180 },
  "lastTurnLatency": {
    "totalMs": 1840, "vadMs": 620, "sttMs": 412, "sttPreprocessMs": 18,
    "sttPostprocessMs": 4, "sttFixes": 1, "sttModel": "whisper-small",
    "llmMs": 980, "llmFirstTokenMs": 980, "mcpMs": 0,
    "ttsFirstChunkMs": 180, "ttsMs": 540, "playbackMs": 2900,
    "firstAudioMs": 1840, "ttsEnabled": true, "mcpToolCount": 0,
    "mcpServers": [], "sttChars": 22, "replyChars": 41,
    "llmModel": "agent", "measuredAt": 1761798123456
  },
  "conversation": [ { "id": "m-1", "role": "user", "text": "do I have a meeting tomorrow", "at": 1761798121000, "source": "voice" } ],
  "conversationLimit": 50,
  "stageOrder": ["agent", "mic", "vad", "stt", "llm", "tts", "playback", "mcp"],
  "pendingConfirmation": null,
  "mcpServers": [ { "name": "gmail", "connected": true, "toolCount": 4, "permissions": { "read": true, "write": true, "delete": false } } ]
}
```

### Field contracts

| Field | Note |
|---|---|
| `stages` | The 8 stages shown in the UI panel. `status` ∈ `idle` \| `ready` \| `active` \| `warn` \| `error`. The order is fixed by `stageOrder`. |
| `audio.acRms` | **Instantaneous** DC-removed RMS. This is the correct answer to "is my voice being captured"; `forwardedChunks` is cumulative and stays `>0` after the first turn. |
| `ttsEnabled` | The **real** runtime value (env + user choice). |
| `ttsOverride` | `null` = env applies; `true`/`false` = the user chose explicitly. |
| `lastTurnLatency.totalMs` | Turn start → **first audio**. Not the full synthesis time. |
| `lastTurnLatency` | Stage durations overlap (`vadMs` belongs to before the turn start, `playbackMs` to after the first audio); they do not sum to `totalMs`. |
| `conversation` | The **visible** conversation only. System/tool messages sent to the LLM are not here. The last `conversationLimit` (50) entries are kept. |
| `pendingConfirmation` | `null` = nothing pending. `expiresAt === null` = the question is still being spoken, the countdown has not started. **Never fabricated**: it is only populated while the agent is genuinely waiting. |
| `mcpServers` | Live status. If `connected:false` the tool list is empty. |

---

## `GET /events` — SSE

A one-way live stream from server to client. All UI liveness comes from here.

**Connection behaviour**

1. Response headers are written as `text/event-stream`.
2. The first line written is `retry: 2000` → on a drop the client reconnects after 2 s.
3. Immediately afterwards a `snapshot` event is sent, giving the client its initial state.
4. The client is added to the subscriber list; removed via `req.on('close')`.

```
retry: 2000

event: snapshot
data: {"ok":true,"pid":41213,…}

data: {"type":"stage","state":{…}}

data: {"type":"log","entry":{…}}
```

> [!NOTE]
> Only the **first** event carries an `event:` line (`snapshot`). Subsequent
> events are written as `data:` only and are discriminated by the `type` field
> inside `data`
> ([`control-server.ts:65`](../../agent/src/control-server.ts)).
> That is why the client uses `EventSource.onmessage`, not `addEventListener`.

---

## `POST /listen`

Turns microphone listening on/off. If `enabled` is **missing or anything other
than `false`**, the request is treated as "on".

```jsonc
// request
{ "enabled": true }

// response
{ "ok": true, "listening": true }
```

| Status | Body |
|---|---|
| Agent absent | `503 { ok:false, error:"agent not ready" }` |
| Open failure | `500 { ok:false, error:"<device error>" }` |

The listening state is also recorded in telemetry (the `mic` stage flips
`ready` ↔ `idle`) and is pushed onto the stream as a `stage` event.

---

## `POST /ask`

Starts a text turn — the microphone-free test path. **The response text does not
come back from this endpoint**: the request is accepted (`202`), generation
continues in the background and the result arrives as `conversation-update` +
`turn-latency` events.

```jsonc
// request
{ "text": "what's the weather like today" }

// response — immediate
{ "ok": true, "accepted": true }
```

| Status | Condition |
|---|---|
| `202` | Accepted, work in progress |
| `400 { ok:false, error:"text is empty" }` | `text` is empty |
| `503` | Agent not ready |

If an error occurs while processing, no HTTP status is returned to the client
(202 has already been sent); the error appears as a `log` event
(`level:"error"`, `stage:"llm"`).

---

## `POST /inject`

Diagnostics path: feeds the raw PCM in the body into the pipeline as if it were
the microphone stream. Sent as `Content-Type: application/octet-stream` with
**PCM16 / 16 kHz / mono** — with **no** WAV header.

```bash
# convert to 16 kHz mono PCM, then inject
ffmpeg -i test.wav -f s16le -acodec pcm_s16le -ac 1 -ar 16000 test.pcm -y
curl -X POST --data-binary @test.pcm \
     -H 'Content-Type: application/octet-stream' \
     http://127.0.0.1:8899/inject
```

```jsonc
{ "ok": true, "seconds": 3.42 }
```

**Why it is fed in real time:** the VAD measures silence duration against the
wall clock. If all the PCM were delivered at once, the segment would never close
and no turn would be detected. That is why 100 ms chunks (`3200` bytes) are
written with `setInterval`.

**Trailing synthetic silence:** with a real microphone, silent chunks keep
arriving after speech ends, which is what lets the VAD decide "speech finished".
Injection has no such tail, so **1.5 s** (15 × 100 ms) of zero PCM is appended
after the body. Without it the segment never closes.

| Status | Condition |
|---|---|
| `202` | Accepted |
| `400 { ok:false, error:"PCM too short (at least 100 ms required)" }` | Body < 3200 bytes |
| `503` | Agent not ready |

---

## `POST /tts`

Turns speech output on/off at runtime. It is tri-state:

| Body | Meaning |
|---|---|
| `{ "enabled": true }` | Force on |
| `{ "enabled": false }` | Force off |
| `{}` or `{ "enabled": null }` | Clear the override → fall back to the `DIJI_TTS_ENABLED` env value |

```jsonc
{ "ok": true, "enabled": true, "override": true }
```

The change is broadcast to every client as a `tts-toggle` SSE event, so the tray
menu and the UI update at the same time.

---

## `POST /confirm`

Answers a pending MCP confirmation. **Anything other than `confirmed === true` is
a rejection** (strict equality: the string `"true"` is not an approval).

```jsonc
// request
{ "confirmed": true }

// response
{ "ok": true, "applied": true }
```

### The race condition and its fix

[`requestVoiceConfirmation()`](../../agent/src/pipeline.ts) publishes the
confirmation record **before** TTS (`expiresAt: null`) but installs the pending
promise **after** speech finishes. Because the UI opens the dialog early, a user
pressing "Approve" immediately used to have the request silently vanish with
`applied:false`.

Fix: while the record exists, the request is retried at 100 ms intervals for up
to 5 s. If nothing is pending, it returns `applied:false` immediately.

| `applied` | Meaning |
|---|---|
| `true` | Decision delivered, work is/was in progress |
| `false` | Nothing pending (timed out, already answered, never existed) |

---

## `POST /bargein`

Interrupts an in-flight response: the LLM stream, TTS synthesis and the speaker
queue are shut down **together**. No body required.

```jsonc
{ "ok": true }
```

> [!WARNING]
> Closing all three is mandatory. If only playback is stopped, the UI sticks on
> `SPEAKING` because `isSpeaking` is derived from the `tts` **or** `playback`
> stage being active.

---

## `GET /models`

The model lists for the Settings screen. The catalog is produced **entirely from
whatever is on the machine** — there is no hardcoded "supported models" table
([`agent/src/model-catalog.ts`](../../agent/src/model-catalog.ts)).

```jsonc
{
  "ok": true,
  "stt": {
    "current": "small",
    "options": [
      { "id": "small",  "label": "Small — balanced (recommended)", "available": true, "detail": "int8 · 484 MB" },
      { "id": "medium", "label": "Medium — higher accuracy, slower", "available": false, "detail": "files missing" }
    ]
  },
  "tts": {
    "current": "vits-piper-tr_TR-fettah-medium",
    "options": [
      { "id": "vits-piper-tr_TR-fettah-medium", "label": "Piper · Turkish · fettah medium", "available": true, "detail": "model.onnx + tokens.txt" }
    ]
  },
  "llm": {
    "current": "agent",
    "options": [
      { "id": "agent", "label": "agent", "available": true, "detail": "local server" },
      { "id": "coder", "label": "coder", "available": true, "detail": "local server" }
    ]
  },
  "modelsDir": "/home/<user>/.diji/models"
}
```

### Catalog sources

| Kind | Source | Condition |
|---|---|---|
| `stt` | `~/.diji/models/sherpa-onnx-whisper-<prefix>/` | `<prefix>-encoder*.onnx`, `<prefix>-decoder*.onnx`, `<prefix>-tokens.txt` — **all three** |
| `tts` | `~/.diji/models/vits-*` | `.onnx` + `tokens.txt` |
| `llm` | `http://127.0.0.1:8000/v1/models` | 2.5 s timeout; empty list if the server is down |

The `current` field is the **real identity of the running engine**, not the
configured value. The distinction matters: if `drifting-tts` fails to start, the
engine silently falls back to `sherpa-vits` and `config.tts.provider` would be
misleading.

`modelsDir` can be changed with `DIJI_MODELS_DIR`; it is returned in the response
for diagnostics.

> [!NOTE]
> The catalog is **not** part of `/state`: the LLM list requires an HTTP request
> to the local server (~2.5 s) and `/state` is called on every UI startup. The
> catalog is therefore separate and on-demand; it is fetched only when the
> Settings panel opens.

| Status | Condition |
|---|---|
| `500 { ok:false, error }` | Catalog could not be built (disk permission, scan error) |
| `503` | Agent not ready |

---

## `POST /models/select`

Switches the model and writes the choice **persistently** to
`~/.config/diji/env`.

```jsonc
// request
{ "kind": "stt", "id": "medium" }

// response — success
{
  "ok": true,
  "current": "medium",
  "persisted": true,
  "persistHint": "Selection saved permanently (~/.config/diji/env)"
}
```

### `kind` values and switch cost

| `kind` | What happens | Duration |
|---|---|---|
| `llm` | Only the model name is put into the next request body; the engine is not restarted | Instant |
| `stt` | `STTEngine` disposed and rebuilt (`modelPriority:[id, …]`) | ~2–6 s |
| `tts` (VITS) | `TTSEngine` disposed and rebuilt | ~1–3 s |
| `tts` (`drifting-tts`) | The Python bridge restarts | ~60–70 s → `slow:true` |

### Response fields

| Field | Type | Description |
|---|---|---|
| `ok` | `boolean` | Did the switch happen |
| `current` | `string` | The **running** model id after the switch |
| `reason` | `string?` | Why, when `ok:false` |
| `slow` | `boolean?` | The switch was slow (drifting-tts) |
| `persisted` | `boolean?` | Was it written to the env file |
| `persistError` | `string?` | Why the write failed (permission, disk) |
| `persistHint` | `string?` | Ready-made note to show the user |

### Why `persisted` / `ok` are separate — a deliberate decision

Even when the persistence write fails, the model **has changed in this process**,
so the response stays `ok:true` and the failure is reported separately via
`persisted:false`. The UI builds its `· saved permanently` / `· this session
only` note from that. The alternative (overloading a single `ok` field with two
meanings) would have caused silent data loss.

### Keys written

| `kind` | Keys written |
|---|---|
| `llm` | `DIJI_LLM_MODEL` |
| `stt` | `DIJI_STT_MODEL_PREFIX`, `DIJI_STT_MODEL` |
| `tts` (directory) | `DIJI_TTS_PROVIDER=sherpa-vits`, `DIJI_TTS_VITS_MODEL` |
| `tts` (provider) | `DIJI_TTS_PROVIDER` |

Write contract: line by line (comments preserved), **all** duplicate keys
updated, atomic (`temp` + `rename`), mode `0600`, **never throws**
([`agent/src/env-prefs.ts`](../../agent/src/env-prefs.ts)).

### Re-selecting the same model

The engine is **not** restarted. Measured: an unnecessary restart meant 8 s of
dead time and the microphone being cut for nothing. In this case only the
persistence write happens and `ok:true` is returned.

### Status codes

| Code | Condition | Example |
|---|---|---|
| `200` | Switch succeeded (even if persistence failed) | `{ ok:true, current:"medium", persisted:true }` |
| `400` | Invalid `kind` / empty `id` | `{ ok:false, error:"kind must be stt\|tts\|llm" }` |
| `409` | Model cannot be selected (not on disk, not on the server, engine not ready) | `{ ok:false, current:"small", reason:"model not found on disk" }` |
| `503` | Agent not ready | `{ ok:false, error:"agent not ready" }` |

> [!IMPORTANT]
> On `409` **nothing is written to the env file**. Verified: after an invalid
> `large-v3` attempt, `grep -c large-v3 ~/.config/diji/env` → `0`.
> Persisting an invalid choice would mean the agent breaking on the next start.

---

## SSE event schemas

All events arrive as `data: <json>\n\n`. Discrimination is by the `type` field —
`snapshot` is the **exception** (it carries a separate `event:` line and has no
`type` field; it is the `StatePayload` body directly).

### `snapshot`

```jsonc
{ "ok": true, "pid": 41213, … }
```

The full [`GET /state`](#get-state) body. It arrives once when the connection is
established; partial updates stream afterwards.

### `stage`

A stage changed state.

```jsonc
{ "type": "stage", "state": { "key": "stt", "label": "STT", "status": "active", "detail": "transcribing…", "metrics": { "ms": "412" }, "updatedAt": 1761798123456 } }
```

### `log`

A line for the diagnostics panel.

```jsonc
{ "type": "log", "entry": { "id": 812, "t": 1761798123456, "level": "info", "stage": "mic", "msg": "listening enabled" } }
```

`level` ∈ `info` \| `warn` \| `error`. `stage` ∈ `agent`, `mic`, `vad`, `stt`,
`llm`, `tts`, `playback`, `mcp`.

### `turn-latency`

A turn completed (first audio emitted). The breakdown is of type
[`TurnLatency`](../../agent/src/telemetry.ts).

```jsonc
{ "type": "turn-latency", "latency": { "totalMs": 1840, "sttMs": 412, "llmMs": 980, "ttsFirstChunkMs": 180, "…": "…" } }
```

> [!NOTE]
> The `turnToken` mechanism prevents measurements from being reset by concurrent
> turns: a late-arriving event from an old turn does not overwrite the counters
> of a new one.

### `conversation-update`

The chat history changed. The **full list** is sent; the client reconciles
idempotently (it never has to reason about add vs. delete).

```jsonc
{
  "type": "conversation-update",
  "conversation": [
    { "id": "m-1", "role": "user", "text": "do I have a meeting tomorrow", "at": 1761798121000, "source": "voice" },
    { "id": "m-2", "role": "assistant", "text": "You have a meeting at 14:00 tomorrow.", "at": 1761798122000, "source": "voice", "latencyMs": 1840 }
  ]
}
```

### `confirmation`

A confirmation-required action opened or closed.

```jsonc
{ "type": "confirmation", "pending": { "server": "gmail", "tool": "gmail.send_message", "permission": "write", "reason": "sending email requires write permission", "question": "…", "requestedAt": 1761798121000, "expiresAt": 1761798141000 } }
{ "type": "confirmation", "pending": null }
```

### `tts-toggle`

The speech-output switch changed (tray or UI).

```jsonc
{ "type": "tts-toggle", "enabled": false }
```

---

## Error codes

| Code | Meaning | Typical cause |
|---|---|---|
| `200` | Success | — |
| `202` | Accepted, work in progress | `/ask`, `/inject` |
| `204` | Empty body (CORS preflight) | `OPTIONS` |
| `400` | Invalid request body | `kind`/`id`/`text` empty or invalid |
| `409` | Model could not be selected | Not on disk/server, engine not ready |
| `500` | Server error | Device could not be opened, catalog build failed |
| `503` | Agent not ready | The pipeline has not been constructed yet |

---

## Quick cURL recipes

```bash
# Alive?
curl -s http://127.0.0.1:8899/health

# Full state
curl -s http://127.0.0.1:8899/state | jq '.stages[] | {key, status, detail}'

# Live stream (first 200 lines)
curl -N http://127.0.0.1:8899/events | head -200

# Enable the microphone
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":true}' http://127.0.0.1:8899/listen

# Text turn (the reply arrives over SSE)
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"text":"hello"}' http://127.0.0.1:8899/ask

# Model list
curl -s http://127.0.0.1:8899/models | jq '.stt'

# Switch model (persistent)
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"kind":"llm","id":"coder"}' http://127.0.0.1:8899/models/select

# Invalid choice → 409, NOT written to env
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'Content-Type: application/json' \
     -d '{"kind":"stt","id":"large-v3"}' http://127.0.0.1:8899/models/select

# Disable speech output
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"enabled":false}' http://127.0.0.1:8899/tts
```

Ready-made scripts: [`scripts/smoke-test.js`](../../scripts/smoke-test.js),
[`scripts/control-e2e.js`](../../scripts/control-e2e.js),
[`scripts/inject-e2e.js`](../../scripts/inject-e2e.js),
[`scripts/verify-stt-chain.js`](../../scripts/verify-stt-chain.js).

---

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — layers, audio pipeline, turn lifecycle
- [CONFIGURATION.md](CONFIGURATION.md) — environment variables and `~/.config/diji/env`
- [MODELS.md](MODELS.md) — model files, sizes, licences
- [SECURITY.en.md](../../SECURITY.en.md) — threat model, permission gate
