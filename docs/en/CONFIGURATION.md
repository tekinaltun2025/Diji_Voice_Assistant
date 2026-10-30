# Configuration

**English** · [🇹🇷 Türkçe](../CONFIGURATION.md)

Diji starts without any configuration file at all: every default is defined in
[`shared/src/config/default.ts`](../../shared/src/config/default.ts). There are
three ways to change a setting and the **priority order** is well defined.

---

## Table of contents

- [Priority order](#priority-order)
- [`~/.config/diji/env` — the persistent settings file](#configdijienv--the-persistent-settings-file)
- [Why not `config.json`?](#why-not-configjson)
- [Keys written by the Settings screen](#keys-written-by-the-settings-screen)
- [Variable reference](#variable-reference)
- [Sample files](#sample-files)
- [Verification](#verification)

---

## Priority order

Resolution order for a value (the top wins):

```
1. Process environment   (export in a terminal, systemd unit, Electron spawn env)
2. ~/.config/diji/env    (persistent user setting — applied ONLY if absent from the environment)
3. The built-in default in `default.ts`
```

`loadUserEnv()` enforces this rule explicitly:

```ts
// agent/src/env-bootstrap.ts:38
if (process.env[match[1]] === undefined) {
  process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
}
```

> [!IMPORTANT]
> This is deliberate so the user can do a one-off override such as
> `DIJI_LLM_MODEL=agent node agent/dist/index.js`. The persistent file does
> **not** override a per-session setting.

---

## `~/.config/diji/env` — the persistent settings file

Format: `KEY=value` lines. It is not a shell script — no `export` is written and
no variable expansion happens.

```bash
# Diji persistent settings (managed from the Settings screen)
DIJI_STT_MODEL_PREFIX=small
DIJI_STT_MODEL=whisper-small
DIJI_LLM_MODEL=agent
DIJI_TTS_PROVIDER=sherpa-vits
DIJI_TTS_VITS_MODEL=vits-piper-tr_TR-fettah-medium
```

### Parsing rules

| Rule | Behaviour |
|---|---|
| Line starting with `#` | Comment — ignored |
| Empty line | Ignored |
| `KEY=value` | Match pattern: `^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$` |
| Quotes in the value | Single/double quotes are stripped (`"small"` → `small`) |
| Whitespace in the value | Only **leading/trailing** whitespace is trimmed; inner whitespace is preserved |
| Variable expansion | **None** — `$HOME` stays literal text |
| Missing file | Silently ignored (not an error) |
| Malformed file | Unparsable lines are skipped; the agent keeps starting |

### Early loading — a critical detail

`~/.config/diji/env` must be read **before every other import**. The reason:
the `@diji/shared` package builds the `DEFAULT_AGENT_CONFIG` object **at module
load time**, reading `process.env` while doing so. If it were called inside
`main()`, the values would already be frozen.

The fix is that [`agent/src/env-bootstrap.ts`](../../agent/src/env-bootstrap.ts)
is the **first import** in `agent/src/index.ts`; the `loadUserEnv()` call in the
module body runs during that import.

So when you add a new `DIJI_*` variable, read it from `process.env` inside
`default.ts` — otherwise the value from the env file is not used.

### Write guarantees

The Settings screen writes to this file through
[`agent/src/env-prefs.ts`](../../agent/src/env-prefs.ts):

| Guarantee | Implementation |
|---|---|
| Comments preserved | `^\s*#` lines are left untouched |
| Duplicate keys | **All** matching lines are updated (not just the first) |
| Missing keys | Appended at the end |
| Atomicity | Written to a `temp` file and swapped in with `rename` |
| Mode | `0600` (owner read/write only) |
| Directory | `~/.config/diji` → `0700`, created if needed |
| Errors | **Never throws** — returns `{ ok:false, error }` |
| Value escaping | Values containing whitespace/`#`/quotes/`$`/`\` are double-quoted |

```ts
// agent/src/env-prefs.ts
function formatValue(value: string): string {
  const clean = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  if (clean === '') return '';
  return /[\s#"'`$\\]/.test(clean) ? `"${clean.replace(/"/g, '\\"')}"` : clean;
}
```

---

## Why not `config.json`?

[`ConfigLoader`](../../shared/src/config/loader.ts) also supports a
`config.json`, but it is **not used** in production:

| Problem | Explanation |
|---|---|
| Relative path | `config.json` resolves against `process.cwd()`. When the agent is started from a terminal, from Electron or from systemd, `cwd` differs → the file is sometimes found, sometimes not. |
| Silent loss | If the file is not found there is no error; defaults are used and the user cannot tell why their setting had no effect. |
| Deep merge | `deepMerge` supports partial settings objects, but there is no write path; the file must be edited by hand. |
| UI access | The Electron process does not know the user's `cwd`; the write location would be ambiguous. |

`~/.config/diji/env` is an absolute path, independent of `cwd`, and is already
read at the earliest possible stage. That is why persistence is written there.

---

## Keys written by the Settings screen

A `POST /models/select` call writes different keys depending on the kind
([`pipeline.ts:1829`](../../agent/src/pipeline.ts)):

| `kind` | Keys written | Why |
|---|---|---|
| `llm` | `DIJI_LLM_MODEL` | A single field is enough |
| `stt` | `DIJI_STT_MODEL_PREFIX`, `DIJI_STT_MODEL` | The prefix drives the priority list; `DIJI_STT_MODEL` is for diagnostics/logs |
| `tts` (VITS directory) | `DIJI_TTS_PROVIDER=sherpa-vits`, `DIJI_TTS_VITS_MODEL` | The provider is pinned so the drifting model id cannot leak |
| `tts` (provider choice) | `DIJI_TTS_PROVIDER` | `drifting-tts` or `sherpa-vits` |

### Why `DIJI_STT_MODEL_PREFIX` is prepended

[`stt.ts`](../../agent/src/stt.ts) resolves priority in this order:

```
options.modelPriority ?? config.modelPriority ?? config.modelPrefix
```

Because `modelPriority` is **always defined** in `default.ts`, the `modelPrefix`
branch never ran — meaning the persistent choice was silently ignored.
Fix: `buildSttPriority()` takes the prefix and puts it at the **front** of the
list, keeping the remaining fallbacks.

```ts
// shared/src/config/default.ts:145
function buildSttPriority(): string[] {
  const configured = (process.env.DIJI_STT_MODEL_PRIORITY || 'medium,small,base,tiny')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const forced = (process.env.DIJI_STT_MODEL_PREFIX || '').trim();
  if (!forced) return configured;
  return [forced, ...configured.filter((item) => item !== forced)];
}
```

It was not reduced to a single prefix: if that model were deleted from disk, the
agent would not start at all. With the fallbacks kept, it silently degrades to an
older model.

---

## Variable reference

### Run mode and process

| Variable | Default | Description |
|---|---|---|
| `DIJI_MODE` | `microphone` | `microphone` \| `text` \| `both`. Text mode runs without a microphone. |
| `DIJI_CONTROL_PORT` | `8899` | Control server port (the host is fixed at `127.0.0.1`). |
| `DIJI_MODELS_DIR` | `~/.diji/models` | Root directory of the model files. STT/VAD/TTS/catalog all read from here. |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug`. Propagated to child processes. |
| `DIJI_ROOT` | — | The first hint the Electron bridge uses to locate the project root. |
| `DIJI_NODE_BIN` | from `PATH` | Node interpreter used when spawning the agent. |

### Audio devices

| Variable | Default | Description |
|---|---|---|
| `DIJI_AUDIO_INPUT_DEVICE` | `default` | `arecord` device (`default`, `plughw:1,0`, `hw:…`). **If set explicitly, auto-detection is skipped.** |
| `DIJI_AUDIO_OUTPUT_DEVICE` | `default` | `aplay` device. |
| `DIJI_AUDIO_SILENCE_THRESHOLD` | `0.002` | Microphone "quiet room" threshold (RMS). The panel's `idle`/`active` distinction relies on it. |
| `DIJI_ARECORD_BIN` | `arecord` | Path to the capture binary (for tests/alternative tools). |
| `DIJI_APLAY_BIN` | `aplay` | Path to the playback binary. |

> [!NOTE]
> Choosing the wrong device is the **most common** cause of "STT is broken"
> reports. Measured (2026-10-27): the problem was not in the recognition chain
> but in microphone device selection. Verify with `arecord -l`.

### STT (Whisper)

| Variable | Default | Description |
|---|---|---|
| `DIJI_STT_MODEL` | `whisper-small` | Informational/log identity. The real selection is `PRIORITY` + `PREFIX`. |
| `DIJI_STT_MODEL_PREFIX` | — | Prepends the given prefix to the priority list (persistent choice). |
| `DIJI_STT_MODEL_PRIORITY` | `medium,small,base,tiny` | Comma-separated fallback list. The first one **present** on disk is loaded. |
| `DIJI_STT_LANGUAGE` | `tr` | Recognition language. |
| `DIJI_STT_THREADS` | `2` | Number of CPU threads. |
| `DIJI_STT_PREPROCESS` | `true` | `false` → preprocessing turns off entirely. |
| `DIJI_STT_HIGHPASS_HZ` | `80` | High-pass filter cutoff frequency. |
| `DIJI_STT_TRIM_THRESHOLD` | `0.006` | Silence-trim threshold (prevents Whisper hallucination). |
| `DIJI_STT_TARGET_RMS` | `0.06` | AGC target level. |
| `DIJI_STT_MAX_GAIN_DB` | `18` | AGC maximum gain. |
| `DIJI_STT_NOISE_GATE_RMS` | `0.0025` | Noise-gate threshold. |
| `DIJI_STT_POSTPROCESS` | `true` | `false` → dictionary/whitespace correction turns off. |
| `DIJI_STT_FUZZY_DISTANCE` | `1` | Fuzzy term-matching distance. |

Preprocessing chain: DC removal → high-pass → trim → noise gate → AGC.
Postprocessing: hallucination filtering → dictionary (Gmail, calendar, Notion …)
→ whitespace correction. The durations are measured separately
(`sttPreprocessMs`, `sttPostprocessMs`) so the cost of the chain is visible.

### VAD

| Variable | Default | Description |
|---|---|---|
| `DIJI_VAD_THRESHOLD` | `0.5` | Silero speech-probability threshold. |
| `DIJI_VAD_MIN_SILENCE` | `0.6` | Minimum silence before speech is considered finished (s). |
| `DIJI_VAD_MIN_SPEECH` | `0.25` | Minimum speech duration (s). |

The sample rate is fixed at `16000` — STT/VAD/inject all use the same rate.

### TTS

| Variable | Default | Description |
|---|---|---|
| `DIJI_TTS_ENABLED` | `1` | `0`/`false`/`off`/`no` → speech output disabled from the start. |
| `DIJI_TTS_PROVIDER` | `drifting-tts` | `drifting-tts` \| `sherpa-vits`. |
| `DIJI_TTS_VITS_MODEL` | — | **sherpa-vits only** directory name. The Settings screen writes this. |
| `DIJI_TTS_MODEL` | depends on provider | drifting: `Vyvo/drifting-tts-tr`. Legacy/generic key — read as a fallback by sherpa. |
| `DIJI_TTS_VOICE` | `studio` / `fettah` | Voice identity (provider-dependent). |
| `DIJI_TTS_SPEED` | `1.0` | Speech rate. |
| `DIJI_TTS_SAMPLE_RATE` | `48000` | Output sample rate. |
| `DIJI_TTS_PYTHON` | `python3` | Python interpreter for the drifting-tts bridge. |
| `DIJI_TTS_BRIDGE` | `scripts/drifting_tts_bridge.py` | Path to the bridge script. |

> [!WARNING]
> Because `DIJI_TTS_MODEL` was read by both providers, the drifting model id
> (`Vyvo/drifting-tts-tr`) could leak into sherpa. That is why the separate
> `DIJI_TTS_VITS_MODEL` key was added; the Settings screen uses it.

### LLM

| Variable | Default | Description |
|---|---|---|
| `DIJI_LLM_BASE_URL` | `http://127.0.0.1:8000/v1` | OpenAI-compatible local server. |
| `DIJI_LLM_MODEL` | `agent` | Model id. |
| `DIJI_LLM_API_KEY` | `sk-local` | The local server usually does not validate; this is a placeholder. |
| `DIJI_LLM_TEMPERATURE` | `0.7` | — |
| `DIJI_LLM_MAX_TOKENS` | `1024` | Response budget. |
| `DIJI_LLM_TIMEOUT_MS` | `120000` | Request timeout. |
| `DIJI_LLM_REASONING_RESERVE` | `1024` | Token allowance reserved for reasoning models. |

**Reasoning budget measurement:** `agent` is a hybrid reasoning model; it emits
~1,500 tokens of thinking text before the answer and that text is deducted from
the `max_tokens` budget. Without the reserve the answer comes back **empty**. If
the reserve is too large the model thinks for longer (measured: a 4256 token
budget → 91 s). A 1024 reserve with a 2048 absolute ceiling is a balanced
setting. For models that do not use reasoning, set `0`.

### MCP

| Variable | Default | Description |
|---|---|---|
| `DIJI_MCP_ENABLED` | `true` | `false` → the MCP client is never constructed. |
| `DIJI_ALLOW_DELETE` | `false` | `true` → delete permission enabled (voice confirmation is still required). |
| `TOKEN_STORAGE_PATH` | `./tokens` | OAuth2 token directory. Propagated to child processes. |
| `ENCRYPTION_PASSWORD` | `diji-default-key` | Token encryption passphrase. **Always change this in production.** |

### MCP OAuth2 (per server)

| Server | Variables |
|---|---|
| Gmail | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` |
| Calendar | `CALENDAR_CLIENT_ID`, `CALENDAR_CLIENT_SECRET`, `CALENDAR_REDIRECT_URI` |
| Drive | `DRIVE_CLIENT_ID`, `DRIVE_CLIENT_SECRET`, `DRIVE_REDIRECT_URI` |
| Notion | `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI` |
| Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_REDIRECT_URI` |

The redirect URI default is `http://localhost:3000/auth/<server>/callback`.
The Chrome server does not use OAuth (it drives a local browser).

### Research module

| Variable | Default | Description |
|---|---|---|
| `DIJI_RESEARCH_TEMPERATURE` | `0.7` | — |
| `DIJI_RESEARCH_MAX_TOKENS` | `4096` | Research response budget (higher than chat). |
| `DIJI_RESEARCH_TIMEOUT_MS` | `300000` | 5 minutes. |
| `DIJI_RESEARCH_MAX_STEPS` | `10` | Maximum number of tool iterations. |

### LiveKit (unused)

| Variable | Description |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Present in the schema; the current pipeline does not use LiveKit. May be left empty. |

### Electron

| Variable | Default | Description |
|---|---|---|
| `DIJI_ELECTRON_SANDBOX` | `1` | `0` → sandbox disabled (**not recommended**). |

> [!CAUTION]
> If `ELECTRON_RUN_AS_NODE=1` is defined in your shell, Electron will not open a
> window and behaves like Node. Use `env -u ELECTRON_RUN_AS_NODE` when launching.

---

## Sample files

### `~/.config/diji/env` — balanced setup

```bash
# Diji persistent settings
DIJI_MODE=microphone
DIJI_LOCALE=tr

# Speech recognition — small is balanced, medium is more accurate but slower
DIJI_STT_MODEL_PREFIX=small
DIJI_STT_MODEL=whisper-small
DIJI_STT_LANGUAGE=tr

# Language model
DIJI_LLM_BASE_URL=http://127.0.0.1:8000/v1
DIJI_LLM_MODEL=agent
DIJI_LLM_REASONING_RESERVE=1024

# Speech output — sherpa-vits is reliable on this machine
DIJI_TTS_ENABLED=1
DIJI_TTS_PROVIDER=sherpa-vits
DIJI_TTS_VITS_MODEL=vits-piper-tr_TR-fettah-medium
```

### `~/.config/diji/env` — microphone-free development

```bash
DIJI_MODE=text
DIJI_TTS_ENABLED=0
LOG_LEVEL=debug
DIJI_MCP_ENABLED=false
```

### `.env.example` (repository root)

The version-controlled sample lives at [`../../.env.example`](../../.env.example).
**Never** commit real values; `.gitignore` excludes the `*.env` pattern (except
`!.env.example`).

---

## Verification

```bash
# 1. See that the defaults resolve
node -e "console.log(JSON.stringify(require('./agent/dist/index.js'),null,2))" 2>/dev/null || true

# 2. Read which model the agent actually started with
curl -s http://127.0.0.1:8899/models | jq '{stt:.stt.current, tts:.tts.current, llm:.llm.current}'

# 3. Prove the env file is read: change a value, restart the agent, read again
grep '^DIJI_LLM_MODEL' ~/.config/diji/env

# 4. File permissions (should be 0600)
stat -c '%a %n' ~/.config/diji/env ~/.config/diji

# 5. Confirm the process environment does NOT override the env file
DIJI_LLM_MODEL=coder node agent/dist/index.js   # coder wins (priority 1)
```

Live verification steps for model selection are in
[API.md](API.md#post-modelsselect) and [MODELS.md](MODELS.md).

---

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — layers, audio pipeline, turn lifecycle
- [API.md](API.md) — endpoint contracts, `/models/select` details
- [MODELS.md](MODELS.md) — model files, sizes, download
- [SECURITY.en.md](../../SECURITY.en.md) — secret management, permission gate
