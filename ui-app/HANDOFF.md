# Diji — Handoff Note

Diji is a **Turkish voice-assistant interface** that runs in the browser and on
the Ubuntu desktop. This package contains the clean source code of the project
(without dependencies or build output).

> [!NOTE]
> This note carries the historical "Jarvis" naming used during the design
> migration. The shipping product name is **Diji**; the packaging artefact names
> still say Jarvis.

## What does the project do?

- **Web UI:** a single page with the "Quantum Glass" audio form that reacts to
  the microphone, the chat screen, a slide-out history drawer, and system
  indicators (CPU/RAM/VRAM/wireless — **sample data**).
- **Chat history** is kept in browser storage (`localStorage`); no account and no
  server are required.
- **There is no real AI connection in the standalone design package:** it is a
  UI/design deliverable; sending a message only stores it locally and no
  AI response is produced. The full application wires this to the agent — see
  [`README.md`](README.md).
- **The microphone** is used only to animate the audio form; audio is not
  recorded, not sent to a server, and no speech recognition runs.

## Folder structure

| Path | Contents |
| --- | --- |
| `src/routes/index.tsx` | The whole interface: widget, chat, history, indicators |
| `src/components/quantum-wave.tsx` | Canvas 2D audio form (reacts to the microphone level) |
| `src/styles.css` | The entire visual theme (Tailwind v4 + custom CSS) |
| `electron/main.cjs` | Electron main process (the `app://jarvis/` custom protocol) |
| `scripts/prepare-electron.cjs` | Prepares the SPA shell for Electron |
| `tests/quantum_wave_browser.py` | Playwright script for UI verification |
| `AGENTS.md`, `roadmap.md` | Project decisions and task history — read before changing anything |

## Setup and running

```sh
npm install          # or bun install / pnpm install
npm run dev          # dev server (default http://localhost:8080)
```

Build (Node server, SSR):

```sh
npm run build        # output: .output (nitro node-server preset)
```

Electron desktop package:

```sh
npx vite build -c vite.electron.config.ts   # SPA shell (dist/client)
node scripts/prepare-electron.cjs           # relative-path rewrite
npx electron .                              # opens the window
```

For a distributable Ubuntu package you can use `@electron/packager`
(see `electron/README.md`).

## Technical summary

- **Language/ecosystem:** TypeScript, React 19, TanStack Start v1 (SSR + Vite 8),
  Tailwind CSS v4.
- **Routing:** TanStack Router (`src/routes/`); `src/routeTree.gen.ts` is generated
  automatically — do not edit it by hand.
- **Build:** `nitro` (node-server preset) — no external server or database
  connection.
- **State:** React state + `localStorage` only; no backend, no authentication and
  no database.

## Known notes

- The `vite.config.ts` and `vite.electron.config.ts` in this package are written
  with **standard Vite plugins** instead of Lovable's custom wrapper package; the
  build has been tested.
- The values in the system indicators are samples; a browser cannot read Ubuntu
  hardware measurements. Real CPU/RAM measurement happens in a separate **Python**
  package (psutil).
- The `Alt+Space` shortcut opens/closes the history panel.
