# Linear Edit

Trim and stitch video clips entirely on your own device. Upload local
video files, mark in/out points, build a timeline, preview the assembled
sequence, and export a final MP4 — all processed in-browser via
[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm). No backend, no
uploads: your files never leave your computer.

Two layouts are available from the toggle in the header:

- **Modern** — a clean Tailwind UI: upload, source monitor, timeline,
  sequence preview, export.
- **Classic** — a tape-deck-style dual-monitor console (PLAYER /
  RECORDER) in the spirit of the original app's UI.

## Getting started

```sh
npm install
npm run dev
```

## How it works

- Source files are read locally via the browser's File API and never
  uploaded anywhere.
- The timeline preview swaps a single `<video>` element's source between
  clips as playback crosses each clip's out-point, so the assembled
  sequence can be previewed instantly without waiting on an export.
- Export writes each clip into ffmpeg.wasm's in-memory virtual
  filesystem, trims and concatenates them there, and hands back a
  downloadable blob — nothing is persisted to disk until you click
  Download.

See [`TECHDEBT.md`](./TECHDEBT.md) for known tech debt and
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for hosting notes.

## Attribution

This is a from-scratch rewrite of my earlier
[linearEditFrontend](https://github.com/Master-Max/linearEditFrontend) /
[linearEditBackend](https://github.com/Master-Max/linearEditBackend)
project, which paired a React/Redux frontend with a Rails API that shelled
out to `youtube-dl` and `ffmpeg` server-side to assemble clips. This
version keeps the original's dual-monitor editing concept (and revives it
directly in the Classic layout) but moves all processing client-side with
ffmpeg.wasm, so it needs no server at all.
