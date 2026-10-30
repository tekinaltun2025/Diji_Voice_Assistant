# Security Policy

**English** · [Türkçe](SECURITY.md)

Diji is a **voice assistant**: it opens the microphone, transcribes speech
locally, sends it to a local language model and speaks the answer. It can also
reach Gmail, Calendar, Drive, Notion, Slack and the browser through MCP tools.

This document describes what the system **actually** protects and what it does
not. The goal is to state the threat model plainly instead of making inflated
security claims.

---

## Table of contents

- [Threat model](#threat-model)
- [Secure by design](#secure-by-design)
- [Permission gate](#permission-gate)
- [Control server](#control-server)
- [Electron isolation](#electron-isolation)
- [Secret management](#secret-management)
- [Audio privacy](#audio-privacy)
- [Known limits](#known-limits)
- [Hardening checklist](#hardening-checklist)
- [Reporting a vulnerability](#reporting-a-vulnerability)

---

## Threat model

### What is protected

| Asset | Why it matters |
|---|---|
| Microphone stream | Raw audio; carries speech content and ambient information |
| Transcripts and replies | Personal/business content |
| OAuth2 tokens | Access to Gmail/Calendar/Drive/Notion/Slack accounts |
| LLM API key | Local, but still stored in a configuration file |
| MCP tool permissions | Sending email, creating events, reading files |

### Trusted by default

| Assumption | Consequence |
|---|---|
| The operating system and the user account | Any process running under the same user account can reach this data. Diji does not prevent that. |
| `127.0.0.1` | Other processes on the local machine are considered trusted. |
| The local LLM server | The server on `127.0.0.1:8000` is trusted. |
| Model files | The contents of `~/.diji/models` have not been tampered with. |

### Out of scope (Diji does not defend against these)

- A malicious process under the same user account reading memory
- Physical access (listening to the microphone directly)
- Compromise of the OS kernel or the audio subsystem
- Network-originated attacks (the control server is local; it is not exposed)
- The security of the local LLM server itself

---

## Secure by design

### 1. No cloud

Audio, transcripts and replies **never** go to a third-party service:

- STT: local `sherpa-onnx` (Whisper weights on disk)
- VAD: local `silero_vad.onnx`
- TTS: local VITS or a local Python bridge
- LLM: an OpenAI-compatible server on `127.0.0.1`

The only outbound connection is **model download**
(`github.com/k2-fsa/sherpa-onnx`), and that happens only when
`scripts/download-models.sh` is run manually.

### 2. The control server is local only

```ts
// agent/src/control-server.ts:30
export const CONTROL_HOST = '127.0.0.1';
```

It is a constant; an environment variable **cannot** open it on `0.0.0.0`. The
port can be changed (`DIJI_CONTROL_PORT`); the host cannot.

### 3. Tokens are stored encrypted

The MCP servers encrypt OAuth2 tokens with `ENCRYPTION_PASSWORD` and write them
under `TOKEN_STORAGE_PATH` (default `./tokens`); that directory is excluded by
`.gitignore`.

### 4. Delete is off by default

```ts
// shared/src/config/default.ts:118
permissionGate: { read: true, write: true, delete: false }
```

`delete` is enabled only with `DIJI_ALLOW_DELETE=true`, and even then every call
still requires voice confirmation.

### 5. Env file is 0600

`~/.config/diji/env` is written with mode `0600` and the directory is `0700`. The
write is atomic (`temp` + `rename`), so a half-written file cannot appear
([`env-prefs.ts`](agent/src/env-prefs.ts)).

---

## Permission gate

Every MCP call passes through
[`PermissionGate.evaluate()`](shared/src/permission-gate.ts). There are three
permission classes:

| Class | Behaviour |
|---|---|
| `read` | Executed immediately (search, list, read) |
| `write` | **Voice confirmation** required. Without approval the call is not made. |
| `delete` | **Blocked** by default. With `DIJI_ALLOW_DELETE=true` it runs after voice confirmation. Calendar deletion is a special case: always strict confirmation. |

### Confirmation flow

```
1. The LLM wants to call a tool
2. MCPClient.callTool() → PermissionGate.evaluate()
3. For write/delete: a randomBytes(32) token is generated, 5 min TTL
4. `pendingConfirmation` is written to telemetry → SSE `confirmation` event
5. The assistant SPEAKS the question ("Do you approve sending this email?")
6. The user answers from the UI or by voice → POST /confirm { confirmed }
7. The token is validated (single use); if expired it is rejected
8. If approved the tool runs; if rejected the LLM is told "the user declined"
```

### The race condition — fixed

The confirmation record is published **before** TTS (`expiresAt: null`) but the
pending promise used to be installed **after** speech finished. If the user saw
the dialog early and approved immediately, the request silently vanished with
`applied:false` — meaning **the user thought they had approved while nothing
happened**.

Fix: `/confirm` retries at 100 ms intervals for up to 5 s
([`control-server.ts:366`](agent/src/control-server.ts)).

### Token properties

| Property | Value |
|---|---|
| Generation | `randomBytes(32).toString('hex')` → 256 bit |
| TTL | 5 minutes (`TOKEN_TTL_MS`) |
| Usage | Single use — `confirm()` deletes it before returning |
| Comparison | Not constant-time (see [known limits](#known-limits)) |

### The limit of the permission gate — important

> [!WARNING]
> The gate protects the **LLM** from malicious actions; it does not protect the
> **user** from the LLM misunderstanding them. The LLM can misinterpret the
> user's intent and start an unnecessary `write` call. **Read** the confirmation
> dialog; do not press "Approve" reflexively.

---

## Control server

| Property | Status | Note |
|---|---|---|
| Host | `127.0.0.1`, constant | Unreachable from the network |
| Authentication | **None** | Local processes are considered trusted |
| CORS | `*` | Harmless because it is local; still, any local web page could in theory send a request |
| Body limit | 1 MB | `readBody` truncates beyond that |
| `/inject` | Audio injection | The 1 MB limit is roughly 32 s of audio |

### Why there is no authentication

The control server behaves like a **local IPC channel**. Adding authentication
would require sharing a secret on every request, and that secret would still live
in a local file — no real gain. Instead the surface was narrowed:

- The host is pinned to `127.0.0.1`
- Only the 11 required endpoints
- Access only through the Electron bridge and `scripts/*.js`

> [!CAUTION]
> Do not change the `CONTROL_HOST` constant. A control server exposed to the
> network would, with no authentication, become an interface where **anyone can
> open your microphone and run your MCP tools**.

---

## Electron isolation

```ts
// ui/electron/main.ts:165
webPreferences: {
  nodeIntegration: false,
  contextIsolation: true,
  preload: path.join(__dirname, 'preload.js'),
}
```

| Setting | Value | Effect |
|---|---|---|
| `nodeIntegration` | `false` | The renderer cannot see `require`/`process` |
| `contextIsolation` | `true` | Preload and page contexts are separated |
| `preload` | Narrow `window.diji` surface | Only 10 methods, not raw IPC |

The surface exposed to the renderer is defined in
[`ui-app/src/types/diji.d.ts`](ui-app/src/types/diji.d.ts): `getState`, `listen`,
`ask`, `setTts`, `confirm`, `bargeIn`, `getModels`, `selectModel`, `onTelemetry`,
`onConnection`. Raw `ipcRenderer` or filesystem access is **not** granted.

### Sandbox

Default: sandbox **on**. It is disabled only with `DIJI_ELECTRON_SANDBOX=0`.

> [!WARNING]
> `DIJI_ELECTRON_SANDBOX=0` should be used only when Chromium cannot start at all
> due to a local user-namespace restriction. While disabled the renderer has
> broader privileges.

---

## Secret management

### What does and does not enter the repository

`.gitignore` **excludes**:

```gitignore
*.env
!.env.example
credentials*.json
*client_secret*.json
token*.json
*.pem
*.key
oauth-tokens/
tokens/
```

A pre-publication scan was run: `sk-`, `ghp_`, `xox*`, `AIza`, `ntn_` and
private-key blocks were searched for → **zero matches in the source**. The
repository contains **no** `.env`, `.pem`, `credentials*.json` or `token*.json`
files.

### Supplying secrets via environment variables

```bash
# Correct: process environment (mind your shell history)
ENCRYPTION_PASSWORD='…' node agent/dist/index.js

# Wrong: writing plaintext into the env file (it still sits on disk even at 0600)
```

`~/.config/diji/env` is **not designed for secrets** — it holds persistent
settings such as model selection. For OAuth client secrets and
`ENCRYPTION_PASSWORD`, use a systemd `EnvironmentFile=` (0600) or a secret
manager.

### Default password warning

The default for `ENCRYPTION_PASSWORD` is `diji-default-key`. That exists purely
for development convenience.

> [!CAUTION]
> If you store real OAuth tokens you **must** change `ENCRYPTION_PASSWORD`. A
> token encrypted with the default password can be decrypted by anyone who gets
> the file.

### LLM API key

`DIJI_LLM_API_KEY` defaults to `sk-local` and the local server usually performs
no validation. If you use a real key, supply it through the process environment,
not the env file.

---

## Audio privacy

| Question | Status |
|---|---|
| Is raw audio written to disk? | **No.** Processed in memory only. |
| Is the transcript written to disk? | **No.** In memory only (`CONVERSATION_LIMIT` = 50 messages). |
| Do logs contain audio? | **No.** Only durations, levels and transcript length. |
| Is the `/inject` body retained? | **No.** Processed and discarded. |
| UI history | In the browser's `localStorage`; chat text lives there |

> [!NOTE]
> The UI keeps chat history in `localStorage`. If you work on a shared machine,
> clear that directory.

### Microphone ownership

The agent reads the microphone with `arecord` through `default` (PipeWire).
Switching to a raw hardware device (`plughw:...`) **takes exclusive ownership**
of the device and cuts the microphone for every other application. That is why
the Electron bridge pins the device explicitly to `default`:

```ts
// ui/electron/agent-bridge.ts:204
DIJI_AUDIO_INPUT_DEVICE: process.env.DIJI_AUDIO_INPUT_DEVICE || 'default',
```

---

## Known limits

This list exists for **honesty**; known weaknesses are not hidden.

| Limit | Effect | Mitigation |
|---|---|---|
| No authentication on the control server | Any process on the same machine can drive the agent | Pinned to the local host; narrow surface |
| Confirmation token is not compared in constant time | Theoretical timing attack | The token is 256-bit random with a 5 min TTL; not exploitable in practice |
| CORS `*` | A local web page can issue `fetch` | Browsers apply mixed-content restrictions to `127.0.0.1`; still not a full guarantee |
| `/inject` is open to audio injection | A local process can inject fake speech | Diagnostics endpoint; add a firewall rule if you do not need it in production |
| Env file is plaintext | Model selection and path information are readable | `0600`; do not put secrets in it |
| OAuth token encryption depends on a single passphrase | A weak passphrase means the token can be decrypted | Use a strong `ENCRYPTION_PASSWORD` |
| LLM output is not moderated | The model can produce wrong or harmful content | The `write`/`delete` permission gate; read the output |
| Audio file integrity is not verified | A tampered model could be loaded | Keep the model directory `0700`, download only from the official source |
| `ELECTRON_RUN_AS_NODE` | If defined in the shell, Electron behaves like Node | Launch with `env -u ELECTRON_RUN_AS_NODE` |

---

## Hardening checklist

Before running in production or on a multi-user machine:

- [ ] Change `ENCRYPTION_PASSWORD` from the default (not `diji-default-key`)
- [ ] Supply OAuth client secrets through the process environment, not the env file
- [ ] Verify `~/.config/diji` → `0700` and `~/.config/diji/env` → `0600`
- [ ] Make `~/.diji/models` owner-readable only (`chmod 700`)
- [ ] Leave `DIJI_ALLOW_DELETE` off (the default)
- [ ] Download model files only from `github.com/k2-fsa/sherpa-onnx`
- [ ] Accept the control server risk only if there are no untrusted users/processes on the same machine
- [ ] Clear the UI `localStorage` history on a shared machine
- [ ] Do not run the `scripts/*.js` helpers in production (`/inject`, `cdp-eval`)

Verification commands:

```bash
stat -c '%a %n' ~/.config/diji ~/.config/diji/env ~/.diji/models
ss -ltnp 2>/dev/null | grep 8899          # should be 127.0.0.1:8899, not 0.0.0.0
grep -rn 'ENCRYPTION_PASSWORD' ~/.config/diji/env 2>/dev/null  # should be empty
```

---

## Reporting a vulnerability

This project is a personal/business local assistant application and has no
security team. If you do find a vulnerability:

**Do:**

1. Open a **private** security report in the repository (GitHub → Security →
   Report a vulnerability), or
2. Contact the project owner directly.

Include: the affected version/commit, reproduction steps, expected vs. actual
behaviour, and the potential impact.

**Do not:**

- Disclose the vulnerability in a public issue.
- Include real personal data (voice recordings, tokens, email).

Response time is not guaranteed, but valid reports are handled with priority.

---

## Related documents

- [docs/en/ARCHITECTURE.md](docs/en/ARCHITECTURE.md) — architecture, permission flow
- [docs/en/API.md](docs/en/API.md) — control server endpoints
- [docs/en/CONFIGURATION.md](docs/en/CONFIGURATION.md) — variables that carry secrets
- [docs/en/MODELS.md](docs/en/MODELS.md) — third-party model licences
- [CONTRIBUTING.en.md](CONTRIBUTING.en.md) — contribution process
