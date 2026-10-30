# Diji Voice Assistant — Desktop UI

**English** · [Türkçe](README.tr.md)

The Electron + TanStack Start interface for the Diji agent. It is an
**independent sub-project**: it has its own `package.json`, its own dependencies
and its own build pipeline. It is **not** part of the root npm workspace.

There is **no code dependency** on the agent — it only talks over HTTP/SSE
(`127.0.0.1:8899`). That is why `npm install` is run separately on each side.

---

## Table of contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Folder structure](#folder-structure)
- [Talking to the agent](#talking-to-the-agent)
- [Screen sections](#screen-sections)
- [Settings — model selection](#settings--model-selection)
- [Building and packaging](#building-and-packaging)
- [Troubleshooting](#troubleshooting)

---

## Quick start

Prerequisite: the agent must be built and running (`../agent/dist/index.js`).

```bash
# 1. Dependencies
cd ui-app
npm install

# 2. Development (in the browser, hot reload)
npm run dev                     # http://localhost:3000

# 3. Development with Electron
NODE_ENV=development npm run electron:dev

# 4. Production build + Electron
npm run build                   # → dist/
npm run electron:build          # → dist/ + electron/main.cjs
```

The agent, in a separate terminal:

```bash
cd ..
npm start                       # or: node agent/dist/index.js
curl -s http://127.0.0.1:8899/health   # {"ok":true,...}
```

> [!IMPORTANT]
> If `ELECTRON_RUN_AS_NODE=1` is defined in your shell, Electron will not open a
> window and behaves like Node. Launch with:
> ```bash
> env -u ELECTRON_RUN_AS_NODE npm run electron
> ```

---

## Architecture

```
┌───────────────────────────── Electron main process (CJS) ──────────────────────────┐
│                                                                                    │
│  electron/main.cjs                                                                 │
│    • BrowserWindow (contextIsolation:true, nodeIntegration:false, preload)          │
│    • System tray, global shortcut (Alt+Space), window position                     │
│    • Spawns the agent: `node agent/dist/index.js` (10–20 s to load)                │
│    • app:// custom protocol → serves the dist/ assets                               │
│                                                                                    │
│  electron/preload.cjs  ──contextBridge──▶  window.diji (narrow surface, 11 methods) │
│  electron/agent-bridge.cjs                                                         │
│    • HTTP client  (GET/POST, 127.0.0.1:8899)                                       │
│    • SSE client   (/events → pushes events to the renderer)                        │
│    • Health probe + automatic reconnect                                            │
└────────────────────────────────────┬───────────────────────────────────────────────┘
                                     │ IPC (one direction per channel)
┌────────────────────────────────────▼───────────────────────────────────────────────┐
│  Renderer (React 19 + TanStack Router)                                             │
│    • use-agent.ts  → all agent state in a single hook                               │
│    • routes/index.tsx → Quantum Console interface                                   │
└────────────────────────────────────────────────────────────────────────────────────┘
                                     │ HTTP + SSE
                                     ▼
                           Diji agent (127.0.0.1:8899)
```

### Why the `app://` protocol

The SPA build emits `dist/client/_shell.html` and the asset paths are
**absolute** (`/assets/…`). When loaded over `file://` those paths resolve to the
filesystem root and the page opens blank. Therefore:

1. `scripts/prepare-electron.cjs` (in the root repo) copies `_shell.html` to
   `index.html` and rewrites `/assets/` → `./assets/`.
2. Electron registers the `app://jarvis/` custom protocol and serves the `dist/`
   directory.

### Why `isSpeaking` is derived

```ts
// src/hooks/use-agent.ts
const isSpeaking = ttsStageActive || playbackStageActive;
```

If it were collapsed into a single boolean flag, the UI would stick on
`SPEAKING` after a barge-in. Barge-in closes `llm` + `tts` + `playback` together;
watching two stages tolerates that race.

---

## Folder structure

```
ui-app/
├── electron/
│   ├── main.cjs              # Main process: window, tray, shortcut, protocol, agent spawn
│   ├── preload.cjs           # contextBridge → window.diji
│   └── agent-bridge.cjs      # HTTP + SSE client, health probe
├── src/
│   ├── routes/
│   │   ├── __root.tsx        # Shell
│   │   └── index.tsx         # Main screen (Quantum Console)
│   ├── hooks/
│   │   └── use-agent.ts      # Single source of truth: all agent state
│   ├── types/
│   │   └── diji.d.ts         # window.diji contract (mirror of the agent API)
│   └── styles.css            # Design system
├── dist/                     # Build output (gitignored)
├── vite.config.ts
├── tsconfig.json
└── package.json
```

---

## Talking to the agent

All communication goes through `window.diji`. Raw `ipcRenderer` or `fetch` is
**not used** — the security surface is kept narrow.

```ts
interface DijiAPI {
  getState(): Promise<StatePayload>;
  isAvailable(): boolean;
  listen(enabled: boolean): Promise<ListenResult>;
  ask(text: string): Promise<AskResult>;            // 202, the reply arrives over SSE
  setTts(enabled: boolean): Promise<TtsResult>;
  confirm(confirmed: boolean): Promise<ConfirmResult>;
  bargeIn(): Promise<BargeInResult>;
  getModels(): Promise<ModelCatalog>;
  selectModel(kind: ModelKind, id: string): Promise<ModelSelectResult>;
  windowControls: WindowControls;                   // minimise / maximise / close
  onTelemetry(cb: (event: TelemetryEvent) => void): () => void;
  onConnection(cb: (status: ConnectionStatus) => void): () => void;
  readonly isElectron: true;
  readonly version: string;
}
```

`windowControls` is the only member that does **not** mirror an agent endpoint —
it drives the Electron window itself:

```ts
interface WindowControls {
  minimize(): Promise<WindowActionResult>;
  toggleMaximize(): Promise<WindowActionResult>;    // resolves with the NEW state
  close(): Promise<WindowActionResult>;
  isMaximized(): Promise<boolean>;
  onMaximizedChange(cb: (maximized: boolean) => void): () => void;
}
```

`toggleMaximize()` waits for the `maximize`/`unmaximize` **event** before
resolving, because GTK applies the change asynchronously — reading
`isMaximized()` straight after `win.maximize()` returns the *old* value and
makes the header icon flash the wrong glyph. There is a 300 ms safety timeout.

This interface is a **one-to-one mirror** of the agent API. When a new endpoint
is added, [`src/types/diji.d.ts`](src/types/diji.d.ts) is updated first, then
`electron/agent-bridge.cjs` and `electron/preload.cjs`. For the agent contracts
see [`../docs/API.md`](../docs/API.md).

### SSE events

Discrimination is by the `type` field inside `data` — only the first event
(`snapshot`) carries a separate `event:` line:

| `type` | Meaning |
|---|---|
| *(absent — `snapshot`)* | Full state body |
| `stage` | A stage changed state |
| `log` | Diagnostics line |
| `turn-latency` | A turn completed, latency breakdown |
| `conversation-update` | Chat history (full list) |
| `confirmation` | A confirmation-required action opened/closed |
| `tts-toggle` | The speech-output switch changed (including from the tray) |

---

## Screen sections

| Section | Contents |
|---|---|
| **Left sidebar** | Navigation: Chat, History, Settings. History and Settings are mutually exclusive. |
| **Control buttons** | Microphone on/off, TTS on/off, Barge-in (interrupt) |
| **Stage** | Audio visualisation + stage indicator |
| **Chat** | Conversation history, text input |
| **Telemetry** | 8 stages (AGENT, MICROPHONE, VAD, STT, LLM, TTS, PLAYBACK, MCP), live log |
| **Confirmation dialog** | Visual confirmation synchronised with the voice prompt for MCP `write`/`delete` |

---

## Settings — model selection

Three dropdowns: **SPEECH RECOGNITION (STT)**, **LANGUAGE MODEL (LLM)**,
**SPEECH OUTPUT (TTS)**. The lists are produced entirely from **whatever is on
the machine**; there is no hardcoded "supported models" table.

| Kind | Source | Switch cost |
|---|---|---|
| STT | `~/.diji/models/sherpa-onnx-whisper-*` | ~2–6 s (engine restarts) |
| TTS | `~/.diji/models/vits-*` | ~1–3 s (drifting: ~60–70 s) |
| LLM | The local server's `/v1/models` response | Instant |

The selection is **persistent**: it is written to `~/.config/diji/env` and
remains valid after the agent restarts. The notification says so explicitly:

```
Changed: Small — balanced · saved permanently
```

If persistence fails (permission error, etc.) the notification says
`· this session only` and appends the reason. An **invalid** selection (`409`) is
**not** written to the file.

Details: [`../docs/MODELS.md`](../docs/MODELS.md),
[`../docs/API.md`](../docs/API.md#post-modelsselect).

---

## Building and packaging

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server (browser) |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Preview the built output |
| `npm run lint` | ESLint |
| `npm run format` | Prettier |

Packaging is driven from `scripts/` in the root repo:

```bash
# 1. Build the agent
cd .. && npx tsc -b && cd ui-app

# 2. Build the UI
npm run build

# 3. _shell.html → index.html + asset path rewrite
node ../scripts/prepare-electron.cjs

# 4. Run Electron
env -u ELECTRON_RUN_AS_NODE npx electron .
```

> [!NOTE]
> `dist/` and `release/` are **gitignored**. The packaged Electron output
> (~865 MB) never enters the repository.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| White/blank window | Asset paths were not resolved | Run `node ../scripts/prepare-electron.cjs`; check that `dist/index.html` exists |
| The window never opens | `ELECTRON_RUN_AS_NODE=1` in the environment | `env -u ELECTRON_RUN_AS_NODE npx electron .` |
| Sandbox error / renderer crashes | User-namespace restriction | `DIJI_ELECTRON_SANDBOX=0`. Do **not** add `--disable-gpu` — it kills the renderer with `exitCode 133` |
| "Not connected" although the agent is up | The agent started late | The bridge probes for 30 s; check `/tmp/diji-agent.log` |
| The UI sticks on `SPEAKING` | Barge-in stopped playback only | `POST /bargein` must close all three (agent side) |
| The Settings list is empty | The agent could not read the catalog | `curl -s 127.0.0.1:8899/models \| jq` |
| The model selection disappeared | Env could not be written | Check `persistError` in the notification; `stat -c '%a' ~/.config/diji/env` → `600` |

Agent-side issues: [`../docs/MODELS.md`](../docs/MODELS.md),
[`../docs/CONFIGURATION.md`](../docs/CONFIGURATION.md),
[`../SECURITY.md`](../SECURITY.md).

---

## Licence

[MIT](../LICENSE) — © 2026 Tekin Altun
