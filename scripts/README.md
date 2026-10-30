# Diji Scripts

This directory holds the development, build and deployment scripts for the Diji
project.

## Scripts

### `setup.sh` — first-time setup

Run this once to install the project. It checks the Node.js version, installs the
dependencies and creates the `.env` file.

```bash
chmod +x scripts/setup.sh
./scripts/setup.sh
```

### `dev.sh` — development environment

Starts every service in development mode. It checks the local LLM endpoint
(`DIJI_LLM_BASE_URL`, default `http://127.0.0.1:8000/v1`) and the LiveKit
variables. If the LLM is unreachable it **exits**; if LiveKit is missing it only
prints a notice (it is not needed in local mode).

```bash
chmod +x scripts/dev.sh
./scripts/dev.sh
```

### `build.sh` — production build

Builds every package for production, in the order Shared → Agent → MCP → UI.

```bash
chmod +x scripts/build.sh
./scripts/build.sh
```

### `deploy.sh` — deployment

Deploys the application to a production or staging environment.

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh production
./scripts/deploy.sh staging
```

## Prerequisites

- Node.js >= 20
- **A local LLM endpoint** — OpenAI-compatible, default
  `http://127.0.0.1:8000/v1`, model `agent`, API key `sk-local`. Verify with:
  ```bash
  curl -s -H "Authorization: Bearer sk-local" \
    http://127.0.0.1:8000/v1/models
  ```
- Local audio models: `./scripts/download-models.sh all`
- A LiveKit account is **not** required (optional, only for a remote transport
  layer)

## Environment variables

Set the following in the `.env` file:

```env
# LLM (the defaults already point at the local router)
DIJI_LLM_BASE_URL=http://127.0.0.1:8000/v1
DIJI_LLM_MODEL=agent
DIJI_LLM_API_KEY=sk-local

# Audio models
DIJI_MODELS_DIR=/home/<user>/.diji/models

# Optional: remote transport layer
LIVEKIT_URL=wss://your-livekit-server.livekit.cloud
LIVEKIT_API_KEY=your-api-key
LIVEKIT_API_SECRET=your-api-secret

LOG_LEVEL=info
```

## Diagnostic and verification scripts

These are the scripts referenced in
[`../CONTRIBUTING.en.md`](../CONTRIBUTING.en.md) and in the troubleshooting
sections of the docs.

| Script | Purpose |
|---|---|
| `smoke-test.js` | Full end-to-end check against a running agent. `--skip-audio` runs it without an audio device |
| `control-e2e.js` | Exercises every HTTP endpoint of the control server |
| `inject-e2e.js` | Feeds a PCM file into `/inject` as if it came from the microphone |
| `verify-stt-chain.js` | Verifies the STT pre/post-processing chain in isolation |
| `verify-llm.js` | Verifies connectivity to the local LLM endpoint |
| `download-models.sh` | Downloads VAD / Whisper / VITS model packages (idempotent) |
| `cdp-eval.js` | Runs a JavaScript expression inside the running Electron renderer over CDP |
| `cdp-screenshot.js` | Captures a screenshot of the running Electron window over CDP. Supports `--click`, `--exec`, `--width`, `--height`, `--wait` and `--list` |

```bash
node scripts/smoke-test.js --skip-audio
node scripts/control-e2e.js
node scripts/inject-e2e.js /tmp/test.pcm
node scripts/verify-stt-chain.js
node scripts/verify-llm.js
```

Both CDP scripts need Electron running with a debugging port:

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron \
    ui-app/electron/main.cjs --no-sandbox --remote-debugging-port=9333 &

CDP_PORT=9333 node scripts/cdp-eval.js "document.querySelectorAll('select').length"
CDP_PORT=9333 node scripts/cdp-screenshot.js --list
CDP_PORT=9333 node scripts/cdp-screenshot.js --click "Settings" --exec 'document.body.innerText = document.body.innerText.replace(/\/home\/[^\s/]+/g, "~")' --width 1400
```

> [!CAUTION]
> Never kill processes with `pkill -f "<pattern>"` — the pattern also matches
> your own shell and kills it. Use `pkill -x electron` or kill by PID:
> `kill "$(curl -s http://127.0.0.1:8899/health | jq -r .pid)"`.

## Related documents

- [README.en.md](../README.md) — project overview
- [CONTRIBUTING.en.md](../CONTRIBUTING.en.md) — build order, testing layers
- [docs/en/CONFIGURATION.md](../docs/en/CONFIGURATION.md) — every `DIJI_*` variable
