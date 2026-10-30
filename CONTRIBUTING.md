# Contributing Guide

**English** · [Türkçe](CONTRIBUTING.tr.md)

Thanks for contributing to Diji. This document describes the **real** rules of
the codebase — not an idealised style guide, but the contracts the existing code
already follows.

---

## Table of contents

- [Quick start](#quick-start)
- [Project structure](#project-structure)
- [Build — project references](#build--project-references)
- [Testing](#testing)
- [Code rules](#code-rules)
- [Invariants (do not break these)](#invariants-do-not-break-these)
- [Debugging tools](#debugging-tools)
- [Commits and PRs](#commits-and-prs)
- [Documentation](#documentation)

---

## Quick start

```bash
# 1. Requirements: Node >= 20, npm 10, arecord/aplay (alsa-utils), ffmpeg
node --version            # v20+
arecord --version
ffmpeg -version | head -1

# 2. Dependencies (postinstall builds the `shared` package)
npm install

# 3. Models (VAD + Whisper + VITS, ~1.5 GB)
./scripts/download-models.sh all

# 4. Build
npm run build

# 5. Verify the local LLM server is up
curl -s http://127.0.0.1:8000/v1/models | head -c 200

# 6. Run
npm start                 # voice mode
npm run start:text        # microphone-free
```

For the desktop UI see the `ui-app/` directory: it has its own `package.json` and
is **not** part of the root workspace.

---

## Project structure

| Directory | Responsibility | Language |
|---|---|---|
| `shared/` | Types, default configuration, permission gate, logger. **The foundation everything depends on.** | TS |
| `agent/` | Audio pipeline: microphone to speaker. Control server, telemetry, model catalog. | TS |
| `mcp_servers/` | Six MCP servers (gmail, calendar, drive, notion, slack, chrome). stdio child processes. | TS |
| `ui-app/` | TanStack Start + Electron desktop UI. Independent build. | TS/TSX |
| `scripts/` | Download, diagnostics, E2E verification scripts. | JS/Py/sh |
| `docs/` | Architecture, API, configuration, models. | MD |
| `ui/` | **Archive** — the old Next.js UI. New development happens in `ui-app/`. | TS |

### Layer dependency rule

```
shared  ←  agent  ←  (nothing)
shared  ←  mcp_servers
ui-app  →  HTTP/SSE  →  agent     (NO code dependency, contract only)
```

> [!IMPORTANT]
> `shared` **cannot** depend on any workspace. `agent` cannot depend on
> `mcp_servers` as code (it only starts it as a process). `ui-app` does **not
> import** agent code — it only uses the `window.diji` bridge.

---

## Build — project references

The root [`tsconfig.json`](tsconfig.json) uses TypeScript **project references**.
Because `composite: true` is set, order matters:

```
shared → agent / mcp_servers/*
```

### Single command

```bash
npx tsc -b                    # builds all references in order
npx tsc -b --clean            # clears build info + outputs
```

### Single package

```bash
npx tsc -b shared             # BEFORE agent
npx tsc -b agent
```

### Type checking (no output)

```bash
npx tsc --noEmit -p agent/tsconfig.json
npx tsc --noEmit -p ui-app/tsconfig.json
```

> [!WARNING]
> If `agent` builds before `shared` is built, `@diji/shared` cannot be resolved
> and you will see **hundreds** of spurious errors. `npx tsc -b` always uses the
> correct order; do not run `tsc -p` on individual packages.

### `.tsbuildinfo` warning

`*.tsbuildinfo` files are **ignored** in the repository. Stale build info can
make it look like "nothing changed" and skip incremental compilation:

```bash
npx tsc -b --clean && npx tsc -b    # when in doubt
```

---

## Testing

### Unit tests (Jest)

```bash
npm run test:agent            # agent/src/__tests__/*.test.ts
npx jest                      # root config → same project
npx jest --watch
npx jest -t 'permission'      # a single test
```

Test files live in `agent/src/__tests__/` with the `*.test.ts` pattern. The root
[`jest.config.js`](jest.config.js) wires up the workspace via its `projects`
definition; without that file Jest falls back to Babel defaults and fails on TS
syntax with `Missing semicolon`.

Current coverage:

| File | What it verifies |
|---|---|
| `audio-preprocess.test.ts` | The preprocessing chain (DC, high-pass, trim, gate, AGC) |
| `stt-postprocess.test.ts` | Hallucination filtering, dictionary, whitespace correction |
| `permission.test.ts` | Permission-gate classes, token TTL, single use |

### End to end (real agent, no mocks)

```bash
npm run build
npm start &                                     # bring the agent up
node scripts/smoke-test.js                      # full path
node scripts/smoke-test.js --skip-audio         # without an audio device
node scripts/control-e2e.js                     # all endpoints
node scripts/verify-stt-chain.js                # STT pre/post processing
node scripts/verify-llm.js                      # LLM connectivity
node scripts/inject-e2e.js test.pcm             # PCM injection
```

> [!NOTE]
> Checks that need model files live under `scripts/`, **not** in Jest. Jest
> should stay fast and self-contained; a test that loads 1.5 GB of models is not
> a unit test.

### UI verification (real Electron + CDP)

```bash
# Launch Electron with CDP
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron \
    ui-app/electron/main.cjs --remote-debugging-port=9333 &

# Query the page
CDP_PORT=9333 node scripts/cdp-eval.js "document.querySelectorAll('select').length"
```

> [!CAUTION]
> If `ELECTRON_RUN_AS_NODE=1` is defined in your shell environment, Electron will
> not open a window and behaves like Node. Launch with
> `env -u ELECTRON_RUN_AS_NODE`.

> [!CAUTION]
> Do **not** use `pkill -f "<pattern>"` to kill processes — the pattern also
> matches your own shell and kills the shell running the command. Kill by PID:
> ```bash
> kill "$(curl -s http://127.0.0.1:8899/health | jq -r .pid)"
> pkill -x electron    # -x is exact name matching, safe
> ```

---

## Code rules

### Language and comments

- Code identifiers are **English** (`getModelCatalog`, `persistModelChoice`).
- User-facing strings are **Turkish** (`"Seçim kalıcı kaydedildi"`).
- Comments are **Turkish** and explain **why**, not **what**. The existing
  codebase is heavily commented on purpose — most comments document a past bug
  ("KUSUR ONARIMI (2026-10-30): … had NEVER had any effect before").

```ts
// GOOD — explains the reason, protects a future change from the same bug
/*
 * KUSUR ONARIMI: `DIJI_STT_MODEL_PREFIX` had NEVER had any effect before.
 * `stt.ts` resolves priority as `modelPriority ?? modelPrefix` and because
 * `modelPriority` was always defined, the second branch never ran.
 */

// BAD — restates the code
// set the model prefix
```

### Logging — `console.*` is forbidden

```ts
// GOOD
import { logInfo, logWarn, logError, logDebug } from '@diji/shared';
logInfo('Ajan hazir', { port });
logError('Ajan baslatilamadi', error as Error, { entry });
```

`console.log` is acceptable only in helper scripts under `scripts/` (they emit
direct output for the user). In `agent/`, `shared/` and `mcp_servers/` it is
**forbidden**: the logger honours `LOG_LEVEL` and carries structured context.

### Error handling

- A silent `catch {}` is allowed only in **deliberate** places: `loadUserEnv()`
  (a missing file is fine), `env-prefs` (never throws), and cleanup with no
  behaviour.
- Everywhere else: catch, log, return a meaningful result.

```ts
// GOOD — the error is not swallowed, it is propagated to the caller
try {
  await p.startListening();
} catch (error) {
  const msg = (error as Error).message;
  telemetry.update('mic', 'error', msg);
  telemetry.log('error', 'mic', msg);
  send(res, 500, { ok: false, error: msg });
}
```

### Type safety

- `strict: true` — there is no `any` escape hatch.
- Prefer `unknown`, then narrow.
- External data (HTTP body, JSON file) is **always** validated:

```ts
// control-server.ts — body validation
const kind = String(body.kind ?? '').trim() as 'stt' | 'tts' | 'llm';
if (kind !== 'stt' && kind !== 'tts' && kind !== 'llm') {
  send(res, 400, { ok: false, error: 'kind must be stt|tts|llm' });
  return;
}
```

### Formatting

```bash
npx prettier --write <file>
npx eslint <file>
```

`.prettierrc` and `.eslintrc.js` live in the repository root; do not change the
defaults.

---

## Invariants (do not break these)

These are not preferences but **architectural contracts**. If you change one,
something breaks silently.

### 1. Sample rate is 16 kHz mono PCM16

STT, VAD and `/inject` all expect the same format. A single differing rate in the
pipeline breaks segmentation and transcription.

### 2. The microphone device is `default`

Switching to a raw hardware device such as `plughw:...` takes exclusive ownership
and cuts the microphone for every other application. `agent-bridge.ts` pins this
explicitly.

### 3. Barge-in closes all three

`llm` + `tts` + `playback`. If only playback is stopped, the UI sticks on
`SPEAKING` (`isSpeaking` is derived from two stages).

### 4. `current` = the running engine's identity, not the configuration value

If `drifting-tts` fails to start the engine silently falls back to `sherpa-vits`.
Reading `config` is misleading; use `TTSEngine.getModelName()`.

### 5. Persistence goes to `~/.config/diji/env`, not `config.json`

`config.json` resolves against `process.cwd()` — Electron, a terminal and systemd
all give a different `cwd`. The env file is an absolute path and is read
**before** `@diji/shared` is evaluated (`env-bootstrap.ts` must be the first
import).

### 6. An invalid selection is never written to the env file

When `/models/select` returns `409`, nothing may be written to the file.
Otherwise the agent breaks on the next start.

### 7. Re-selecting the same model does not restart the engine

Measured: an unnecessary restart cost 8 s of dead time plus the microphone being
cut for nothing. The no-op guard lives in `selectModel()`.

### 8. `totalMs` = turn start → **first audio**

Not the end of synthesis. `playbackMs` happens **after** that and is not part of
the sum. Stage durations overlap; they do not sum to `totalMs`.

### 9. Without `turnToken` the measurement is reset

With concurrent turns, a late-arriving event from an old turn overwrites the
counters of the new one.

### 10. `isSpeaking` is derived in the UI

It is true when `tts` **or** `playback` is active. Collapsing it into a single
flag causes the stuck state after barge-in.

### 11. `ELECTRON_RUN_AS_NODE` must be cleared from the environment

It is defined in the shell environment on this machine; unless launched with
`env -u`, Electron does not open a window.

---

## Debugging tools

| Tool | Purpose |
|---|---|
| `curl -s 127.0.0.1:8899/state \| jq` | Full instantaneous state |
| `curl -N 127.0.0.1:8899/events` | Live SSE stream |
| `tail -f /tmp/diji-agent.log` | Agent stdout/stderr (when Electron spawns it) |
| `node scripts/cdp-eval.js "<js>"` | Query the UI over CDP |
| `scripts/inject-e2e.js` | Feed PCM as if from the microphone (test without a mic) |
| `arecord -l` | List microphone devices |
| `LOG_LEVEL=debug npm start` | Verbose logging |

### Common mistakes

| Mistake | Consequence | Correct approach |
|---|---|---|
| `pkill -f "agent/dist/index.js"` | **Kills your own shell** | `kill` by PID |
| `tsc -p agent` (before shared is built) | Hundreds of spurious errors | `npx tsc -b` |
| Adding `console.log` | `LOG_LEVEL` is ignored | `logInfo` etc. |
| Adding a UI field without updating `diji.d.ts` | `tsc --noEmit` failure | Add the type first |
| Using mocks | The audio path needs real hardware/sampling | Real engines + injection |

---

## Commits and PRs

### Commit message

```
<scope>: <short imperative summary>

<optional body: WHY, not what changed>
```

Scope examples: `agent`, `shared`, `ui-app`, `mcp`, `docs`, `scripts`, `config`.
Examples:

```
agent: fix STT prefix priority (DIJI_STT_MODEL_PREFIX had no effect)
ui-app: add model selection to Settings
docs: document the API contracts
config: split out the TTS_VITS_MODEL key
```

### PR checklist

- [ ] `npx tsc -b` is clean
- [ ] `npm run test:agent` is green
- [ ] `node scripts/smoke-test.js --skip-audio` is green (full smoke if the touched area is audio)
- [ ] The new behaviour was verified against the real agent (not mocks)
- [ ] A new environment variable → documented in `docs/CONFIGURATION.md` and read
      via `process.env` in `default.ts`
- [ ] A new endpoint/field → `docs/API.md` + `ui-app/src/types/diji.d.ts`
- [ ] No `console.log` added
- [ ] No secrets committed (token, key, personal path)
- [ ] None of the invariants broken (the 11 items above)

### Scope

Small, focused PRs are preferred. When fixing a bug do not make **unrelated**
formatting changes — the diff becomes unreadable.

---

## Documentation

If a code change needs documentation, update it in the same PR:

| Change | Update |
|---|---|
| New/changed endpoint | [`docs/API.md`](docs/API.md) (TR: [`docs/API.tr.md`](docs/API.tr.md)) |
| New environment variable | [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) (TR: [`docs/CONFIGURATION.tr.md`](docs/CONFIGURATION.tr.md)) |
| Model/backend change | [`docs/MODELS.md`](docs/MODELS.md) (TR: [`docs/MODELS.tr.md`](docs/MODELS.tr.md)) |
| Layer/responsibility change | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (TR: [`docs/ARCHITECTURE.tr.md`](docs/ARCHITECTURE.tr.md)) |
| Security related | [`SECURITY.md`](SECURITY.md) + [`SECURITY.tr.md`](SECURITY.tr.md) |
| New command/script | [`README.md`](README.md) + [`scripts/README.md`](scripts/README.md) |

Links must be **relative** (`docs/API.md`, `../agent/src/pipeline.ts`) — never
absolute `file://` or personal paths (`/home/<user>/…`).

---

## Licence

Your contributions are accepted under the [MIT](LICENSE) licence.
