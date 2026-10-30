# Diji — Electron desktop package

The Electron + TypeScript + React package of the Diji desktop UI for Ubuntu.
Chat history is kept in the application's own storage (`localStorage`); no
account is needed and no connection is made to a server. The microphone is used
only to animate the audio form.

> [!NOTE]
> This file still carries the historical "Jarvis" naming used during the design
> migration. The shipping product name is **Diji**.

## Running

```sh
tar xzf Jarvis-Electron-Ubuntu.tar.gz
cd Jarvis-linux-x64
./Jarvis
```

If you get a missing-library error:

```sh
sudo apt install libgtk-3-0 libnss3 libasound2t64 libgbm1 libxss1
```

## Building from source

In the project repository:

```sh
npm install
npx vite build -c vite.electron.config.ts   # SPA shell (for Electron)
node scripts/prepare-electron.cjs           # relative-path rewrite
npx electron .
```

Notes:

- The loaded page is served over the `app://jarvis/` custom protocol; the router
  works from the root path and `localStorage` persists.
- The microphone permission is granted locally in `electron/main.cjs`.
- AI responses and service connections are **not** wired up in this package; the
  full contract lives in [`../README.md`](../README.md) and
  [`../../docs/API.md`](../../docs/API.md).
