# Models

**English** · [🇹🇷 Türkçe](MODELS.tr.md)

Every speech engine in Diji runs **locally**. Speech, transcripts and response
text are never sent to any cloud service. Model files are **not** kept in the
code repository (`.gitignore` excludes the heavy artefacts); they are downloaded
into `~/.diji/models`.

---

## Table of contents

- [Model directory](#model-directory)
- [File layout](#file-layout)
- [Quick download](#quick-download)
- [STT — Whisper](#stt--whisper)
- [VAD — Silero](#vad--silero)
- [TTS — two backends](#tts--two-backends)
- [LLM — local server](#llm--local-server)
- [Model selection and persistence](#model-selection-and-persistence)
- [Adding a model manually](#adding-a-model-manually)
- [Licences](#licences)
- [Troubleshooting](#troubleshooting)

---

## Model directory

```
~/.diji/models/
```

Overridable with `DIJI_MODELS_DIR`. All four consumers read the same variable:
[`stt.ts:113`](../agent/src/stt.ts), [`vad.ts:79`](../agent/src/vad.ts),
[`tts.ts:70`](../agent/src/tts.ts),
[`model-catalog.ts:50`](../agent/src/model-catalog.ts). Because the agent, the
VAD and the Settings panel see the **same** directory, the list matches what
actually loads.

---

## File layout

```
~/.diji/models/
├── silero_vad.onnx                          # VAD (633 KB)
├── sherpa-onnx-whisper-small/               # STT (1.3 GB — int8 + fp32 together)
│   ├── small-encoder.int8.onnx              #   108 MB
│   ├── small-decoder.int8.onnx              #   251 MB
│   ├── small-encoder.onnx                   #   391 MB
│   ├── small-decoder.onnx                   #   534 MB
│   ├── small-tokens.txt                     #   798 KB
│   └── test_wavs/                           #   samples
└── vits-piper-tr_TR-fettah-medium/          # TTS (61 MB)
    ├── tr_TR-fettah-medium.onnx             #   61 MB
    ├── tr_TR-fettah-medium.onnx.json
    ├── tokens.txt
    ├── MODEL_CARD
    └── espeak-ng-data/                      #   multilingual phonemisation
```

> [!NOTE]
> Whisper bundles ship **both** int8 **and** fp32 weights. Because Diji uses
> `computeType: 'int8'`, only the `*.int8.onnx` files are loaded; the fp32 files
> take up disk space without being used. If you are short on space you can delete
> `*-encoder.onnx` and `*-decoder.onnx` (the non-int8 ones).

---

## Quick download

```bash
./scripts/download-models.sh all         # VAD + Whisper medium + VITS
./scripts/download-models.sh stt         # Whisper only (medium if present, else downloads)
./scripts/download-models.sh stt-small   # Whisper small
./scripts/download-models.sh stt-base
./scripts/download-models.sh stt-tiny
./scripts/download-models.sh stt-large   # large-v3 (very slow on CPU)
./scripts/download-models.sh tts         # VITS only
./scripts/download-models.sh vad         # Silero only
```

The script is idempotent: if the target directory is populated it **skips** and
does not re-download
([`download-models.sh:29`](../scripts/download-models.sh)).

All files come from `github.com/k2-fsa/sherpa-onnx/releases`; no extra account or
API key is needed.

---

## STT — Whisper

sherpa-onnx Whisper packages. The best local option for Turkish.

### File condition — all three required

For a model to count as **loadable**, these three files are needed
([`model-catalog.ts:97`](../agent/src/model-catalog.ts)):

| File | Pattern |
|---|---|
| Encoder | `<prefix>-encoder*.onnx` |
| Decoder | `<prefix>-decoder*.onnx` |
| Tokenizer | `<prefix>-tokens.txt` **or** `tokens.txt` |

If one is missing, the model **appears** in the list but greyed out
(`available: false`, `detail: "files missing"`) and cannot be selected. This is
deliberate: the user should be able to see what is missing and why it does not
work.

### Directory naming

Two forms are accepted; the first found wins:

1. `sherpa-onnx-whisper-<prefix>` ← what the download script produces
2. `whisper-<prefix>`

### Size vs. accuracy trade-off

| Model | Approx. size (int8) | Turkish accuracy | CPU latency | Recommendation |
|---|---|---|---|---|
| `tiny` | ~40 MB | Lowest | Fastest | Experimentation only |
| `base` | ~75 MB | Low | Fast | Weak hardware |
| `small` | **359 MB** (108+251) | Balanced | ~0.4 s | **Default recommendation** |
| `medium` | ~770 MB | High | ~2–3× small | Accuracy first |
| `large-v3` | ~1.5 GB | Highest | Very slow | Not viable for real time |

The table values are based on file sizes **measured on this machine** and
observed latencies; they differ on other hardware. The `small` int8 file sizes
above come from the `ls` output shown earlier.

### Priority resolution

```
buildSttPriority() → [DIJI_STT_MODEL_PREFIX, ...DIJI_STT_MODEL_PRIORITY (deduplicated)]
```

The model **first found** on disk in that list is loaded. The default order is
`medium,small,base,tiny` — so medium if present, otherwise small. That is why
`download-models.sh stt` prefers medium.

> [!WARNING]
> The prefix list is never reduced to a single element. If it were, deleting the
> selected model from disk would mean the agent **would not start at all**. With
> the fallbacks kept, it silently degrades to a smaller model and keeps working.

### Turkish quality settings

| Setting | Value | Why |
|---|---|---|
| `DIJI_STT_LANGUAGE` | `tr` | Language forcing; auto-detection is unstable for Turkish |
| `trimSilence` | on | Whisper hallucinates over silent regions |
| `trimThreshold` | `0.006` | Based on the measured quiet-room floor |
| High-pass | 80 Hz | Cuts desk/keyboard rumble |
| AGC | target RMS 0.06 / max 18 dB | Rescues users far from the microphone |
| Postprocess dictionary | gmail, calendar, notion, slack, drive, chrome, email, meeting, reminder, event | Fixes mis-transcription of domain terms |

---

## VAD — Silero

| Property | Value |
|---|---|
| File | `~/.diji/models/silero_vad.onnx` |
| Size | 633 KB |
| Sampling | 16 kHz mono |
| Threshold | `DIJI_VAD_THRESHOLD` = `0.5` |
| Minimum silence | `DIJI_VAD_MIN_SILENCE` = `0.6` s |
| Minimum speech | `DIJI_VAD_MIN_SPEECH` = `0.25` s |

Without this single file the agent **will not start**: no segments can be
produced from the microphone stream. Download with
`download-models.sh vad`; the script skips if the file exists.

---

## TTS — two backends

### 1. `drifting-tts` (primary, default)

| Property | Value |
|---|---|
| Model | `Vyvo/drifting-tts-tr` |
| Parameters | 89.3 M |
| Turkish WER | 1.33 % (Freya-TR-Eval) |
| Native sampling | 24 kHz |
| How it runs | Python child process ([`scripts/drifting_tts_bridge.py`](../scripts/drifting_tts_bridge.py)), stdio JSON frames |
| Requires | Python 3 + model weights (HuggingFace) |

**Why a Python bridge:** the model is PyTorch-based and cannot be loaded directly
from Node. The agent `spawn`s a Python child process and talks to it over
bidirectional JSON lines.

> [!IMPORTANT]
> On this machine `drifting-tts` **does not start** — the Python bridge dies with
> `code=null`. The engine detects this and silently falls back to `sherpa-vits`
> ([`tts.ts:385`](../agent/src/tts.ts)). That is why the Settings panel shows
> `sherpa-vits` as the **running** engine, not `config.tts.provider`.

The switch cost is high: changing the provider restarts the Python bridge, which
takes ~60–70 s → `slow: true` in the `POST /models/select` response.

### 2. `sherpa-vits` (fallback, effectively the one running here)

| Property | Value |
|---|---|
| Model | `vits-piper-tr_TR-fettah-medium` |
| Size | 61 MB |
| Speaker | Single (Fettah, male, medium quality) |
| Phonemisation | `espeak-ng-data` (bundled) |
| Sampling | `DIJI_TTS_SAMPLE_RATE` = 48 kHz |
| Requires | `.onnx` + `tokens.txt` |

File condition: at least one `.onnx` **and** `tokens.txt` in the directory
([`model-catalog.ts:142`](../agent/src/model-catalog.ts)). If an
`espeak-ng-data` subdirectory exists the label shows `espeak-ng`, otherwise
`single speaker`.

Switch cost is ~1–3 s (engine dispose + rebuild).

### Provider selection

```bash
# Pin to sherpa-vits (recommended on this machine)
DIJI_TTS_PROVIDER=sherpa-vits
DIJI_TTS_VITS_MODEL=vits-piper-tr_TR-fettah-medium

# drifting-tts
DIJI_TTS_PROVIDER=drifting-tts
DIJI_TTS_MODEL=Vyvo/drifting-tts-tr
DIJI_TTS_PYTHON=python3
```

> [!CAUTION]
> `DIJI_TTS_MODEL` is read by **both** providers. If the drifting model id
> (`Vyvo/drifting-tts-tr`) leaks into sherpa, the engine cannot find a `vits-`
> directory and TTS dies silently. That is why sherpa has its **own**
> `DIJI_TTS_VITS_MODEL` key, and the Settings screen writes it.

### Comparison

| | `drifting-tts` | `sherpa-vits` |
|---|---|---|
| Quality | More natural (89 M, single step) | Good, "medium" VITS |
| Dependency | Python 3 + PyTorch | None (pure onnx) |
| First load | ~60–70 s | ~1–3 s |
| Switch | ~60–70 s (`slow:true`) | ~1–3 s |
| On this machine | Does not start | **Works** |

---

## LLM — local server

Diji does not ship a model **file**; it connects to an OpenAI-compatible local
server.

```bash
# Default
DIJI_LLM_BASE_URL=http://127.0.0.1:8000/v1
DIJI_LLM_MODEL=agent
DIJI_LLM_API_KEY=sk-local
```

### Health check

On startup the agent calls `GET {baseUrl}/models` (2.5 s timeout). If the server
is down the agent **still starts**; the Settings panel shows a single row with
`available:false` / `detail: "LLM server unreachable"`. This lets the user tell
"selected" apart from "selectable".

### Catalog source and id format

`llama.cpp` servers may return **full file paths** in the `/v1/models` response:

```jsonc
{ "data": [ { "id": "/home/user/models/agent.gguf", "details": { "parameter_size": "8B", "quantization_level": "Q4_K_M" } } ] }
```

In that case:

- `label` → the file name with the `.gguf` extension stripped (`agent`)
- `id` → the **full path** (this is what is sent on selection; the server matches on it)
- `detail` → `8B · Q4_K_M · text`

Sending a trimmed id (`agent`) would not match on the server — hence the full
path is preserved.

### Reasoning budget

`agent` is a hybrid reasoning model: it emits ~1,500 tokens of thinking text
before the answer and that text is deducted from the `DIJI_LLM_MAX_TOKENS`
budget.

| `DIJI_LLM_REASONING_RESERVE` | Outcome |
|---|---|
| `0` | **Empty response** for a reasoning model |
| `1024` (default) | Balanced |
| `2048` | Safe upper bound |
| `4256` | Measured: up to 91 s of thinking |

For models that do not use reasoning (e.g. `coder`), `0` may be appropriate.

---

## Model selection and persistence

The Settings screen reads the `/models` catalog and switches with
`/models/select`. The detailed contract is in
[API.md](API.md#post-modelsselect).

| Kind | Switch | Persistent key |
|---|---|---|
| `llm` | Instant | `DIJI_LLM_MODEL` |
| `stt` | ~2–6 s | `DIJI_STT_MODEL_PREFIX` + `DIJI_STT_MODEL` |
| `tts` (VITS) | ~1–3 s | `DIJI_TTS_PROVIDER=sherpa-vits` + `DIJI_TTS_VITS_MODEL` |
| `tts` (drifting) | ~60–70 s | `DIJI_TTS_PROVIDER=drifting-tts` |

The choice is written to `~/.config/diji/env` and survives agent restarts. An
**invalid** choice (`409`) is **not** written to the env file — otherwise the
agent would break on the next start.

Re-selecting the same model does not restart the engine (measured: an unnecessary
restart cost 8 s of dead time plus the microphone being cut). Only the
persistence write happens.

Live verification:

```bash
# 1. Current state
curl -s http://127.0.0.1:8899/models | jq '{stt:.stt.current, tts:.tts.current, llm:.llm.current}'

# 2. Switch
curl -s -X POST -H 'Content-Type: application/json' \
     -d '{"kind":"stt","id":"small"}' http://127.0.0.1:8899/models/select

# 3. Was it persisted?
grep -E '^DIJI_(STT|LLM|TTS)' ~/.config/diji/env

# 4. Restart and see the same values
kill "$(curl -s http://127.0.0.1:8899/health | jq -r .pid)"
node agent/dist/index.js &
sleep 5
curl -s http://127.0.0.1:8899/models | jq '{stt:.stt.current, tts:.tts.current, llm:.llm.current}'
```

---

## Adding a model manually

The catalog is built **entirely from disk**. So adding a new model does not
require waiting for the download script — copying it into the right layout is
enough.

### Whisper

```bash
# 1. Download and extract the package
curl -fL -o /tmp/whisper.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-whisper-medium.tar.bz2
tar -xf /tmp/whisper.tar.bz2 -C ~/.diji/models/

# 2. Verify the three files exist (all three required)
ls ~/.diji/models/sherpa-onnx-whisper-medium/ \
   | grep -E 'medium-(encoder|decoder).*\.onnx|tokens\.txt'

# 3. Refresh the Settings panel → the model appears in the list
```

### VITS

```bash
curl -fL -o /tmp/vits.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-tr_TR-fettah-medium.tar.bz2
tar -xf /tmp/vits.tar.bz2 -C ~/.diji/models/

# must contain .onnx + tokens.txt
ls ~/.diji/models/vits-*/
```

The directory name **must** start with `vits-`; the catalog scan keys off that
prefix.

---

## Licences

### This repository

The source code is **MIT** — see [LICENSE](../LICENSE). © 2026 Tekin Altun.

### Third-party models

Model weights are **not** included in this repository and are outside the MIT
scope. Their own licences apply:

| Component | Licence | Note |
|---|---|---|
| **OpenAI Whisper** (weights) | MIT | sherpa-onnx packages carry the Whisper weights |
| **sherpa-onnx** (runtime) | Apache-2.0 | k2-fsa |
| **Silero VAD** | MIT | Silero team |
| **Piper / VITS** (`vits-piper-tr_TR-fettah-medium`) | MIT | Piper project; voice data may be subject to its own terms |
| **espeak-ng** | GPL-3.0 | Ships inside the package as VITS phonemisation data only |
| **Vyvo / drifting-tts-tr** | See the model card | HuggingFace model; check the usage terms |
| **Electron** | MIT | Desktop shell |
| **TanStack Start / React** | MIT | UI |

> [!NOTE]
> The `espeak-ng` data is GPL-3.0 and is used **as separate process/data**; the
> Diji source code is not a derivative work. Still, if you plan commercial
> distribution, do your own legal review.

### LLM models

Licences for the models on your local server (Llama, Qwen, Mistral, Gemma …) are
entirely up to you; Diji is only an HTTP client.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Model is **greyed out** in the list (`available:false`) | File missing | Read the `detail` field; download with `download-models.sh` |
| STT list is **empty** | `~/.diji/models` missing or prefix mismatch | `ls ~/.diji/models`; the directory must be `sherpa-onnx-whisper-*` or `whisper-*` |
| Single "unreachable" row in the LLM list | Local server is down | `curl http://127.0.0.1:8000/v1/models` |
| TTS is silent although the selection succeeded | `drifting-tts` failed to start and there is no fallback | Set `DIJI_TTS_PROVIDER=sherpa-vits`, verify the VITS directory |
| "small" selected but medium loads | Prefix had no effect | Make sure the `buildSttPriority()` fix is compiled; `grep STT ~/.config/diji/env` |
| Selection is lost after restart | Env file not read or not writable | `stat -c '%a' ~/.config/diji/env` → `600`; are the `DIJI_*` values read via `process.env` in `default.ts`? |
| Model present but "failed to load" | int8 file missing, only fp32 present | `ls <dir>/*int8*`; download the full package |
| `large-v3` returns 409 | Not on disk | `download-models.sh stt-large` |

Further diagnostics: [ARCHITECTURE.md](ARCHITECTURE.md),
[CONFIGURATION.md](CONFIGURATION.md), [API.md](API.md).

---

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — the model management layer
- [API.md](API.md) — `/models` and `/models/select` contracts
- [CONFIGURATION.md](CONFIGURATION.md) — all `DIJI_*` variables
- [../SECURITY.md](../SECURITY.md) — model file integrity, network access

Turkish originals: [`MODELS.tr.md`](MODELS.tr.md), [`ARCHITECTURE.tr.md`](ARCHITECTURE.tr.md),
[`API.tr.md`](API.tr.md), [`CONFIGURATION.tr.md`](CONFIGURATION.tr.md),
[`../SECURITY.tr.md`](../SECURITY.tr.md).
