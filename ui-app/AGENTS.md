<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- The voice assistant UI is kept as a single-page widget; the request was for
  screen design only, so no real AI response is simulated.
- Conversation history lives in the device's browser storage; it needs no
  account and no server setup.
- System metrics are shown beside the audio form inside the widget as **sample
  data**; a browser cannot read Ubuntu hardware measurements directly, so they
  are not presented as real values.
- The Python desktop deliverable is a separate source package; it is independent
  of the web preview and reads actual CPU/RAM measurements while leaving
  unsupported metrics blank.
- `QuantumWave` renders the liquid audio form with Canvas 2D; microphone analysis
  stays entirely in the browser and releases the tracks and the `AudioContext` on
  stop or unmount, with no speech recognition and no audio uploads.
- The Electron desktop deliverable is produced with
  `vite.electron.config.ts` (`base: './'`, `spa.enabled`) +
  `scripts/prepare-electron.cjs` + `electron/main.cjs`; the output is loaded over
  the `app://jarvis/` custom protocol because on the `file://` path the router
  cannot find the `/` route. `electron-release` output is not written into the
  repository (10 MB file limit) and packaging is done with `--out=/tmp`.
- The real agent bridge (`electron/agent-bridge.cjs` + `electron/preload.cjs`)
  exposes only the narrow `window.diji` surface; see
  [`README.md`](README.md) and [`../docs/API.md`](../docs/API.md).
