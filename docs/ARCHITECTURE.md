# Architecture

[🇹🇷 Türkçe](ARCHITECTURE.tr.md) · **English**

This document explains the internal structure, data flow and the reasoning
behind the design decisions in Diji Voice Assistant.

- [1. Overview](#1-overview)
- [2. Layers](#2-layers)
- [3. Audio pipeline](#3-audio-pipeline)
- [4. Turn lifecycle](#4-turn-lifecycle)
- [5. MCP integration](#5-mcp-integration)
- [6. Control server and telemetry](#6-control-server-and-telemetry)
- [7. UI layer](#7-ui-layer)
- [8. Model management](#8-model-management)
- [9. Design decisions](#9-design-decisions)
- [10. Known limits](#10-known-limits)

---

## 1. Overview

Diji consists of three independent process groups:

```
┌─────────────────────────────────────────────────────────────────┐
│  Electron (ui-app/)                                             │
│  ├── main.cjs          window + app:// protocol + IPC           │
│  ├── preload.cjs       narrow window.diji bridge                │
│  └── agent-bridge.cjs  HTTP/SSE client                          │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP + SSE (127.0.0.1:8899)
┌───────────────────────────▼─────────────────────────────────────┐
│  Agent (agent/)                                                 │
│  ├── pipeline.ts       turn orchestration                       │
│  ├── control-server.ts HTTP/SSE endpoints                       │
│  ├── telemetry.ts      stage measurement + event stream         │
│  └── engines           stt · tts · vad · llm · mcp              │
└───────────────────────────┬─────────────────────────────────────┘
                            │ stdio JSON-RPC (one process each)
┌───────────────────────────▼─────────────────────────────────────┐
│  6 MCP servers (mcp_servers/)                                   │
│  gmail · calendar · drive · notion · slack · chrome             │
└─────────────────────────────────────────────────────────────────┘
```

In addition, the agent talks HTTP to the **local LLM server**
(`127.0.0.1:8000/v1`) and runs the **ALSA tools** (`arecord` / `aplay`) as
subprocesses.

**The agent is the sole owner of the audio pipeline.** The UI never opens the
microphone — it only observes and commands through the control server.

---

## 2. Layers

### `shared/`

Single source of truth: configuration schema, types, logger, permission gate.

| File | Responsibility |
|---|---|
| `config/schema.ts` | Zod schema — runtime validation |
| `config/default.ts` | Builds defaults from environment variables |
| `config/loader.ts` | Deep-merges `config.json` over the defaults |
| `permission-gate.ts` | 🟢 / 🟡 / 🔴 rule engine |
| `utils/logger.ts` | Structured logging to **stderr** |
| `types/*` | Shared interfaces |

**Critical rule:** `console.log` is used nowhere except
`shared/utils/logger.ts`. In MCP servers `stdout` belongs exclusively to the
JSON-RPC protocol — a single stray `console.log` corrupts the stream.

### `agent/`

| Component | Responsibility |
|---|---|
| `pipeline.ts` | Turn orchestration, engine lifecycle, barge-in, confirmation flow |
| `control-server.ts` | HTTP + SSE endpoints (`:8899`) |
| `telemetry.ts` | Stage states, turn latency, event stream, conversation history |
| `stt.ts` | sherpa-onnx Whisper + pre/post-processing |
| `tts.ts` | Drifting TTS bridge + sherpa-onnx VITS fallback |
| `vad.ts` | sherpa-onnx Silero |
| `llm.ts` | OpenAI-compatible client, reasoning budget, streaming |
| `mcp-client.ts` | JSON-RPC 2.0 over stdio, permission gate integration |
| `model-catalog.ts` | Scans models on disk / on the server (Settings lists) |
| `env-prefs.ts` | Persists preferences to `~/.config/diji/env` |
| `env-bootstrap.ts` | Loads that env file before anything else |
| `turn-detector.ts` | Turkish end-of-turn heuristics |
| `audio-io.ts` | ALSA process management |
| `audio-preprocess.ts` | DC / high-pass / trim / AGC |
| `stt-postprocess.ts` | Hallucination removal, dictionary, spacing fixes |
| `research/` | Background worker for heavy queries |

### `mcp_servers/`

Each server is an independent package and an independent subprocess
(`dist/index.js`). The agent spawns them, collects tools via `tools/list` and
invokes them via `tools/call`.

### `ui-app/`

TanStack Start (React 19) + Electron. The renderer runs with pure web
technology and no Node capability (`contextIsolation: true`,
`nodeIntegration: false`). Access is granted only through the narrow
`window.diji` surface.

---

## 3. Audio pipeline

```
arecord (16 kHz mono PCM, ~100 ms chunks)
   │
   ▼
audio-preprocess   DC removal · high-pass (80 Hz) · silence trim · AGC
   │
   ▼
VAD (Silero)       is there speech? → if not, skip without spending CPU
   │  if speech: chunks are ACCUMULATED in speechBuffer
   ▼
silence ≥ 600 ms → the segment closes
   │
   ▼
STT (Whisper)      recognition over the WHOLE buffer (100 ms chunks are meaningless)
   │
   ▼
stt-postprocess    hallucination removal · domain dictionary · spacing repair
   │
   ▼
turn detector      has the sentence actually finished? (fillers, conjunctions, punctuation)
   │
   ▼
LLM (+ MCP tools)  local OpenAI-compatible endpoint, reasoning reserve
   │
   ▼
TTS                first PCM chunk → playback queue
   │
   ▼
aplay              speaker
```

### Why the whole buffer goes to STT

Whisper is a sequence model: it needs context. Feeding 100 ms chunks produces
garbage, so the pipeline accumulates the entire speech segment and transcribes
it once. This is also why `vadMs` and `sttMs` are measured separately — the
delay the user perceives is dominated by the silence window, not by the model.

### Sample-rate contract — consistent everywhere

| Stage | Rate | Channels | Format |
|---|---|---|---|
| `arecord` | 16 000 Hz | mono | `S16_LE` |
| preprocess → VAD → STT | 16 000 Hz | mono | `Float32` internally |
| `/inject` body | 16 000 Hz | mono | PCM16, no WAV header |
| TTS output | configurable (`48000` default) | mono | PCM16 |
| `aplay` | TTS output rate | mono | `S16_LE` |

A single differing rate anywhere breaks segmentation and transcription. This is
one of the documented invariants in
[../CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 4. Turn lifecycle

```
[user stops speaking]
        │
        ├─ VAD decides "silence ≥ 600 ms"
        │
        ▼
 flushSpeechSegment()
        │  turnToken = ++counter        ← concurrency guard
        │  telemetry.turnStart(now)
        ▼
 STT ──► postprocess ──► turn detector
        │                     │
        │                     └─ if incomplete: reopen buffer, wait
        ▼
 LLM request (model name from modelOverride, if any)
        │
        ├─ tool calls? ──► MCPClient.callTool() ──► permission gate
        │                        │
        │                        └─ write/delete → voice confirmation
        ▼
 TTS synthesis (streaming)
        │  first chunk → speaker
        ▼
 totalMs = turnStart → first audio        ← THE metric
 playbackMs = first audio → queue empty   ← happens AFTER totalMs
```

### `totalMs` definition

`totalMs` is the time from the start of the turn (the moment VAD decided the
user had finished) to the moment the **first audio** reaches the speaker — not
to the end of synthesis. That is what the user actually waits for.

The individual stage durations (`vadMs`, `sttMs`, `llmMs`, `ttsFirstChunkMs`,
`playbackMs`, …) each describe the time spent **within** that stage. They
overlap: `vadMs` belongs to the period *before* the turn start, and `playbackMs`
runs *after* the first audio. Therefore **the sum of the parts does not have to
equal `totalMs`** — and the UI does not present it as such.

### `turnToken` — why it exists

If a user interrupts and starts a new turn while the previous one is still
finishing, a late event from the old turn can arrive after the new turn has
begun. Without a token, that stale event would reset the new turn's counters and
produce a nonsensical latency reading. Every measurement carries the
`turnToken` it belongs to; mismatched events are dropped.

### Barge-in

`POST /bargein` (and the UI button) must close **all three**:

1. the LLM stream,
2. TTS synthesis,
3. the playback queue.

Stopping only playback leaves the pipeline half-alive: the UI keeps showing
`SPEAKING` because `isSpeaking` is derived from the `tts` **or** `playback`
stage being active.

---

## 5. MCP integration

### Process model

Each server is spawned as a child process and speaks JSON-RPC 2.0 over stdio:

```
agent ──spawn──► node mcp_servers/gmail/dist/index.js
      ──stdin──► {"jsonrpc":"2.0","id":1,"method":"tools/list"}
      ◄─stdout── {"jsonrpc":"2.0","id":1,"result":{...}}
```

`stdout` is protocol-only. All diagnostics go to `stderr` and are re-emitted
through the structured logger.

### Tool naming

Tools are exposed to the LLM as `<server>.<tool>`, e.g. `gmail.send_message`.
`resolveMcpTool()` splits on the first dot to route the call back to the right
server. Tool definitions are converted from the MCP schema into the
OpenAI tool-calling schema in `getMCPToolsAsLLMTools()`.

### Permission flow

```
LLM wants to call a tool
        │
        ▼
PermissionGate.evaluate(request, permission, config)
        │
        ├─ read   → allowed immediately
        │
        ├─ write  → allowed, requiresConfirmation = true
        │             token = randomBytes(32), TTL 5 min
        │
        └─ delete → blocked unless DIJI_ALLOW_DELETE=true
                      (calendar delete always requires strict confirmation)
        │
        ▼
Publish pendingConfirmation to telemetry
        │
        ├─ SSE `confirmation` event → UI dialog opens
        └─ the assistant SPEAKS the question
        │
        ▼
User answers → POST /confirm { confirmed }
        │
        ▼
Token validated (single use, TTL checked) → tool invoked or refused
```

### The `/confirm` race — and its fix

`requestVoiceConfirmation()` publishes the confirmation record **before** TTS
starts (`expiresAt: null`) but installs the pending promise **after** synthesis
finishes. Because the UI opens its dialog early, a user who pressed “Confirm”
immediately had the request silently dropped with `applied: false` — the user
believed the action was approved while nothing happened.

The fix: `/confirm` retries for up to 5 seconds at 100 ms intervals as long as a
confirmation record still exists. If there is no pending confirmation at all it
returns `applied: false` immediately.

---

## 6. Control server and telemetry

| Property | Value |
|---|---|
| Host | `127.0.0.1` — a **hardcoded constant** |
| Port | `8899` (override with `DIJI_CONTROL_PORT`) |
| Auth | None — local IPC semantics, surface narrowed instead |
| Body limit | 1 MB |

`telemetry.ts` is an `EventEmitter` that maintains:

- **stage states** — eight fixed stages (`agent`, `mic`, `vad`, `stt`, `llm`,
  `tts`, `playback`, `mcp`) with `idle | ready | active | warn | error`;
- **log entries** — a bounded ring buffer shown in the UI panel;
- **turn latency** — the last `TurnLatency` record;
- **conversation history** — the *visible* transcript only (last 50 entries);
- **pending confirmation** — `null` unless the agent is genuinely waiting.

`control-server.ts` subscribes to `event` and forwards every event to all SSE
clients.

### Why the model catalog is a separate endpoint

`GET /models` is **not** part of `/state`. Building the catalog requires an HTTP
request to the local LLM server (~2.5 s timeout), and `/state` is called on
every UI start. Separating them keeps startup fast and the catalog fetches only
when the Settings panel opens.

---

## 7. UI layer

### Isolation

```ts
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  preload: path.join(__dirname, 'preload.cjs'),
}
```

The renderer gets a narrow `window.diji` surface — 10 methods, no raw
`ipcRenderer`, no filesystem access.

### Why the `app://` protocol

The SPA build emits `dist/client/_shell.html` with **absolute** asset paths
(`/assets/…`). Loading it over `file://` resolves those against the filesystem
root and the page renders blank. Therefore:

1. `scripts/prepare-electron.cjs` copies `_shell.html` to `index.html` and
   rewrites `/assets/` → `./assets/`.
2. Electron registers a privileged `app://` scheme and serves `dist/`.

### Why `isSpeaking` is derived

```ts
const isSpeaking = ttsStageActive || playbackStageActive;
```

Collapsing this into a single boolean flag leaves the UI stuck on `SPEAKING`
after a barge-in. Looking at both stages tolerates the race between the two
being torn down.

### Telemetry event routing

Only the **first** SSE event (`snapshot`) carries an `event:` line. Every
subsequent event is written as `data:` only and is discriminated by its `type`
field. The client therefore uses `EventSource.onmessage`, not
`addEventListener`.

---

## 8. Model management

### Catalog sources

| Kind | Source | Requirement |
|---|---|---|
| STT | `~/.diji/models/sherpa-onnx-whisper-<prefix>/` | `<prefix>-encoder*.onnx`, `<prefix>-decoder*.onnx`, `<prefix>-tokens.txt` — all three |
| TTS | `~/.diji/models/vits-*` | any `.onnx` + `tokens.txt` |
| LLM | `GET {baseUrl}/models` | 2.5 s abort |

An incomplete Whisper model still appears in the list but with
`available: false` and the reason in `detail`. This is deliberate: the user must
be able to see *why* something cannot be selected.

### Switching

| Kind | Mechanism | Cost |
|---|---|---|
| `llm` | The name travels in the next request body; no engine restart | Instant |
| `stt` | `STTEngine` disposed, recreated with `modelPriority: [id, …]` | ~2–6 s |
| `tts` | `TTSEngine` disposed, recreated | ~1–3 s (`drifting-tts`: ~60–70 s) |

Two guards are essential:

1. **No-op guard** — re-selecting the same model does not restart the engine.
   Measured: a needless restart costs 8 s of dead time plus an unnecessary
   microphone cut.
2. **`current` comes from the running engine** — `drifting-tts` may fail to start
   and the engine silently falls back to `sherpa-vits`, so `config.tts.provider`
   would be misleading.

### Persistence

Selections are written to `~/.config/diji/env` by `env-prefs.ts`:

| Kind | Keys written |
|---|---|
| `llm` | `DIJI_LLM_MODEL` |
| `stt` | `DIJI_STT_MODEL_PREFIX`, `DIJI_STT_MODEL` |
| `tts` (voice) | `DIJI_TTS_PROVIDER=sherpa-vits`, `DIJI_TTS_VITS_MODEL` |
| `tts` (backend) | `DIJI_TTS_PROVIDER` |

Write contract: line-by-line (comments preserved), **all** duplicate keys
updated, atomic (temp + `rename`), mode `0600`, and it **never throws** — it
returns `{ ok: false, error }` instead.

An invalid selection (`409`) writes nothing, otherwise the agent would break on
the next start.

---

## 9. Design decisions

| Decision | Rationale | Alternative rejected because |
|---|---|---|
| Whole-buffer STT | Whisper needs sequence context | 100 ms chunks produce garbage |
| Silence window 600 ms | Measured trade-off between responsiveness and premature cuts | Lower values cut Turkish sentences mid-word |
| `totalMs` ends at first audio | That is the perceived wait | Measuring to end of synthesis hides the real UX |
| Derived `isSpeaking` | Survives partial barge-in teardown | A single boolean sticks on `SPEAKING` |
| Env file, not `config.json` | Absolute path, read before `@diji/shared` is evaluated | `config.json` resolves against `cwd`, which varies |
| Catalog from disk | Adding a model = copying files, no code change | A hardcoded supported-model table goes stale |
| `available: false` rows | Shows *why* something is unusable | Hiding unusable models makes failures mysterious |
| No auth on the control server | Local IPC semantics; a shared secret in a local file buys nothing | — (host pinned to loopback instead) |
| Real engines only | “Silent failure” is worse than a loud error | Mocks hid device/format bugs |

---

## 10. Known limits

| Limit | Impact | Mitigation |
|---|---|---|
| `drifting-tts` does not start on every machine | Falls back to `sherpa-vits` silently | `current` reports the *running* engine |
| `totalMs` excludes playback | A long reply has a long audible tail after `totalMs` | `playbackMs` is reported separately |
| `vadMs` and `playbackMs` are not additive | Stage sums ≠ `totalMs` | The UI shows each stage on its own |
| Control server unauthenticated | Any local process can drive the agent | Bound to `127.0.0.1`; narrow surface |
| Conversation limited to 50 entries | Old turns scroll out | Bounded memory is intentional |
| Single-language STT configuration | The pipeline is tuned for Turkish | Change `DIJI_STT_LANGUAGE` and the dictionary |
| Model weights not verified | A replaced `.onnx` file loads without a checksum | Keep `~/.diji/models` at `0700` |
| `ELECTRON_RUN_AS_NODE` in the shell | Electron behaves like Node, no window | Launch with `env -u ELECTRON_RUN_AS_NODE` |

---

## Related documents

- [API.md](API.md) — endpoint contracts and SSE schemas
- [CONFIGURATION.md](CONFIGURATION.md) — every `DIJI_*` variable
- [MODELS.md](MODELS.md) — model files, sizes, licences
- [../SECURITY.md](../SECURITY.md) — threat model and permission gate
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — build, test, invariants

Turkish originals: [`ARCHITECTURE.tr.md`](ARCHITECTURE.tr.md), [`API.tr.md`](API.tr.md),
[`CONFIGURATION.tr.md`](CONFIGURATION.tr.md), [`MODELS.tr.md`](MODELS.tr.md),
[`../SECURITY.tr.md`](../SECURITY.tr.md), [`../CONTRIBUTING.tr.md`](../CONTRIBUTING.tr.md).
