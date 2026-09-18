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

## Tests

```sh
npm test
```

Runs under plain Node with no browser, via `node --test`. Coverage is
currently the demux half of `src/lib/videoFrameCache.js` — which is pure JS,
unlike the decode half that needs WebCodecs — checked against a committed
Big Buck Bunny clip whose properties are read from `ffprobe` rather than from
this code. See [`test/fixtures/README.md`](./test/fixtures/README.md) for what
that clip deliberately contains and why a generated fixture can't replace it.

## Attribution

This is a from-scratch rewrite of my earlier
[linearEditFrontend](https://github.com/Master-Max/linearEditFrontend) /
[linearEditBackend](https://github.com/Master-Max/linearEditBackend)
project, which paired a React/Redux frontend with a Rails API that shelled
out to `youtube-dl` and `ffmpeg` server-side to assemble clips. This
version keeps the original's dual-monitor editing concept (and revives it
directly in the Classic layout) but moves all processing client-side with
ffmpeg.wasm, so it needs no server at all.

The test fixture in `test/fixtures/` is a clip of **Big Buck Bunny**,
© 2008 Blender Foundation ([bigbuckbunny.org](https://www.bigbuckbunny.org)),
used under the [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)
license and re-encoded for this repository.
