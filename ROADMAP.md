# Roadmap

## WebCodecs-based scrub/rewind (replace `<video>` seek-stepping with a frame cache)

**Where:** `src/classic/ClassicPlayerDeck.jsx` (`rewind()`/`fastForward()`),
`src/classic/ClassicRecorderDeck.jsx` + `src/hooks/useSequencePlayer.js`
(`skip()`)

Both decks currently drive REW/FF through `<video>` — FF via native
`playbackRate`, REW via repeated `currentTime` seeks on an interval (see
"Player deck REW runs slower than FF" in `TECHDEBT.md`). HTML5 video has no
real reverse-playback path: `playbackRate < 0` is spec-legal but no browser
implements it, so any `<video>`-based approach is fundamentally emulating
reverse by reseeking, and pays real seek latency (decode back to nearest
keyframe, forward to target frame) on every step. No source format choice
removes that cost, only shrinks it (see the all-intra "scrub proxy" idea in
`TECHDEBT.md`).

**Proposal:** decode with the `VideoDecoder` from the WebCodecs API
(Chrome/Edge, Safari 16.4+, recent Firefox) and render to `<canvas>` instead
of a `<video>` element. Decode each GOP forward once into a small ring
buffer of `VideoFrame`s, then:
- **Reverse scrub** becomes walking the cache backward — no seek, no decode,
  just draw. This removes the latency asymmetry entirely rather than
  mitigating it.
- **Forward playback/FF** stays just as cheap, decoding straight through
  and discarding frames once past the buffer window.
- Hardware-accelerated decode comes from the browser itself, so this stays
  cheaper than a hand-rolled decoder (e.g. a Rust/WASM decoder via
  `ffmpeg.wasm`'s decode path, or a `dav1d`/`openh264` binding) — those were
  considered and rejected for now since they'd reimplement what WebCodecs
  already gives natively, without the hardware acceleration.

**Scope / what changes:**
- Player deck and recorder/timeline deck both move from `<video>` to
  `<canvas>` for the display surface.
- New frame-cache/GOP-buffer layer to manage decode-ahead and eviction.
- ~~Audio sync needs its own path~~ - turned out not to, for forward
  playback specifically: see the PLAY/FF bullet below. `<video>` keeps
  playing (and producing audio) exactly as before, just hidden underneath
  the canvas, so its audio was never actually at risk of going out of sync
  with anything - this line originally assumed forward playback would have
  to leave `<video>` behind entirely the way REW does, which wasn't
  necessary once REW's own canvas-overlay trick was in hand.
- Fallback path needed for browsers without WebCodecs support — likely the
  current `<video>` seek-stepping implementation, kept as the degraded mode.

**Why not now (for the rest of the scope below):** the full version is an
architecture change, not a bugfix — closer to a multi-day rewrite of both
decks than the interval/seek tweaks in `TECHDEBT.md`. The first slice below
was worth doing on its own because it directly fixes the REW-slower-than-FF
problem without touching the recorder/timeline deck at all.

**Status:** first slice shipped, rest still proposed.

- **Shipped:** `src/lib/videoFrameCache.js` demuxes the source file with
  `mp4box.js` and decodes with `VideoDecoder` into a small per-GOP cache of
  `VideoFrame`s (binary-searches the keyframe table for the GOP containing a
  requested time, decodes+caches that whole GOP, evicts the previous one).
  `ClassicPlayerDeck.jsx`'s `rewind()` uses it to walk backward through
  already-decoded frames and draw them to a `<canvas>` overlaid on the
  `<video>` element (see `.player-frame` in `classic.css`), stepping by
  actual elapsed wall-clock time rather than a fixed tick — which also
  happens to fix the timing-drift half of "Player deck REW runs slower than
  FF" in `TECHDEBT.md`, not just the seek-cost half. `usePlayerMarks.js`'s
  markIn/markOut were changed to read the tracked `currentTime` state
  instead of `videoRef.current.currentTime` directly, since the `<video>`
  element sits paused and stale during a canvas scrub.
  Scope of this slice: MP4/MOV containers with an H.264/HEVC track only
  (mp4box.js is ISO-BMFF-only; WebM/VP9/AV1 sources aren't demuxed). Any
  init failure - unsupported browser, unsupported container, unsupported
  codec - falls back to the original `<video>` seek-stepping REW
  automatically (`startReseekRewind()` in `ClassicPlayerDeck.jsx`, unchanged
  from before this slice). FF still plays through `<video>` unchanged - only
  REW moved off it, and only on the player/source deck.
- **Shipped (on `claude/play-ff-decouple`, not yet merged):** the canvas is
  now the single display surface for every transport, via
  `startForwardCanvas()` in `ClassicPlayerDeck.jsx` for PLAY/FF -
  `<video>` keeps playing normally underneath (unchanged
  `play()`/`playbackRate` calls, still what produces audio and drives
  timing) with the canvas laid over it, so there's no video/canvas swap
  mid-transport.
  Forward playback deliberately does **not** pull from the frame cache,
  though the first cut of this did and it was a mistake worth recording:
  `<video>` has already decoded exactly the right frame, on the browser's
  hardware-timed schedule, by the time `requestVideoFrameCallback` hands
  over `metadata.mediaTime` for it. Decoding it again ourselves can at best
  tie, and the first version lost badly - it awaited
  `cache.getFrameAtOrBefore()` inside the callback and only re-registered
  the next one afterwards, so every frame presented during that await got
  no callback at all and was silently skipped. Measured against a 25fps
  source (40ms/frame) with 50ms of decode latency, that dropped 11 of 24
  frames and stretched the survivors over 51-100ms gaps - the "jittery
  playback" that got reported. It also decoded every frame twice, which is
  real CPU at 1080p. Now the callback re-registers synchronously and draws
  `<video>` itself, which measures at a flat 40.0ms cadence matching the
  source exactly, and is unaffected by decode latency because it never
  touches the decoder. The frame cache still earns its keep on REW and jog,
  where `<video>` genuinely can't help.
  JOG was also moved onto the cache
  (`ClassicPlayerDeck.jsx`'s `jog()`), showing the decoded frame instantly
  via canvas while `<video>`'s own (slower) seek catches up underneath,
  handing back to `<video>` once it does - guarded by a
  `transportGeneration` counter so a jog's async cleanup can't fire late and
  hide the canvas out from under a REW/PLAY/FF that started in the meantime.
  `VideoFrameCache` itself grew a small prefetch window
  (`WINDOW_RADIUS_GOPS` in `videoFrameCache.js`): every
  `getFrameAtOrBefore()` call now also kicks off (without waiting)
  background decoding of the neighboring GOPs on each side, sharing the
  cache's single `VideoDecoder` via a serialized job queue, so a REW/jog
  step that crosses into an already-prefetched neighbor is a cache hit
  instead of a fresh decode-and-wait. (The GOP-boundary stall originally
  noted against forward playback is moot now that forward playback doesn't
  decode at all - the prefetch window is there for REW and jog, which do.)
- **Still proposed:** the recorder/timeline deck's `skip()` REW, and
  dropping the `<video>` fallback path entirely.

## Load video from a hosted platform (Vimeo)

**Where:** `src/components/VideoUpload.jsx`, `src/lib/loadVideoSource.js`,
`src/classic/ClassicLayout.jsx`'s `handleLoadFiles`

Today every source is a local `File` (drag/drop or the file picker) that
gets read fully into memory (`loadVideoSource`) and handed around as a blob
URL + `File` object - that's what every downstream consumer (the `<video>`
elements, `useFFmpeg.js`'s `writeFile`, `VideoFrameCache`'s
`file.arrayBuffer()`) actually expects. "Load from Vimeo" means getting a
Vimeo-hosted video into that same shape; everything past that point already
works unmodified.

**The blocker:** Vimeo's video CDN sends no CORS headers, so
`fetch()`/`XMLHttpRequest` for the raw file from browser JS is blocked
regardless of authentication - confirmed by multiple unrelated projects
hitting the same wall embedding Vimeo in WebGL/Unity/Flutter. A `<video>`
tag can still *play* a cross-origin URL without CORS (no canvas/byte access
needed for that), but this app needs the bytes themselves - to trim/export
via `ffmpeg.wasm` and to demux for the WebCodecs frame cache - not just
playback. That rules out any pure-client, no-backend approach for actual
editing; only a preview-only path (see below) can stay client-only.

**Getting the bytes at all requires Vimeo's API, which requires OAuth:**
an access token with the `public`, `private`, and `video_files` scopes
returns a `download`/`file` field per video - itself an expiring (a few
hours) signed 302 redirect to the actual CDN location, not a stable URL.
Two hard scope limits come with this, not implementation details to work
around:
- It only returns files for videos the authenticated account owns or has
  library access to. There's no legitimate way to pull an arbitrary public
  `vimeo.com/12345678` URL someone pastes in - Vimeo's API doesn't expose
  download links for videos you don't have rights to, on purpose.
- Reliable non-expiring download access is a Vimeo Pro-and-up feature; free
  accounts may not have a `download` link to give at all.
Scraping the player's internal config JSON for the progressive/HLS URLs
(what unofficial "vimeo downloader" tools do) sidesteps the OAuth scope
limit, but it's unversioned, breaks whenever Vimeo changes the player
internals, and does the exact thing the scope restriction above exists to
prevent for videos you don't own - not something to build this feature on.

**Proposal, in two independent pieces:**

1. **Preview-only, no backend:** use Vimeo's public oEmbed endpoint (no
   auth) to resolve a pasted URL into a title/thumbnail/embeddable player,
   and embed the official Player iframe for playback. This never produces
   editable bytes - the iframe is a fully cross-origin, sandboxed
   `player.vimeo.com` document, so there's no route from it to a `File` or
   `ArrayBuffer` at all. Useful only as a "reference clip" panel, not as a
   timeline source. Cheap to build, but on its own doesn't satisfy "load a
   Vimeo video into the editor."
2. **Actually editable, needs a backend:** add Vimeo OAuth (authorization
   code flow) plus a small server-side proxy that (a) exchanges the auth
   code for a token - the app's client secret can never live in browser JS,
   (b) calls the Vimeo API for the authenticated user's own video to get its
   current download redirect, and (c) streams those bytes back to the
   browser through the proxy's own origin (which sets its own CORS/no-CORS-
   needed headers, sidestepping Vimeo's CDN entirely). The browser then
   treats the proxied response exactly like a dropped file: read it into a
   `File`/`ArrayBuffer` the same way `loadVideoSource` already does, and the
   rest of the app - `<video>` playback, `VideoFrameCache`, ffmpeg
   trim/export - needs no changes at all.

**Why this is a bigger decision than it looks:** this app is currently a
100% static SPA with no server component (see `DEPLOYMENT.md` - it ships to
GitHub Pages). Piece 2 requires standing up and hosting *something* with a
server (a small serverless function is the natural fit - e.g. a Cloudflare
Worker or Vercel edge function alongside the static site - not a full
backend rewrite, but a genuinely new kind of infrastructure this project
doesn't have today), plus registering a Vimeo API app and managing its
client secret. It also only ever covers the signed-in user's own Vimeo
library, never arbitrary shared links, which may or may not match what
"load a video from Vimeo" means to whoever's asking for this. And it's worth
being explicit that this changes what `VideoUpload.jsx` currently tells
users ("Files never leave your computer — all editing runs locally in the
browser.") - a Vimeo-sourced clip's bytes do cross the network (browser to
proxy to Vimeo's CDN and back) even though nothing about the app's own
processing changes.

**Status:** proposed, not started. Needs a decision on scope (own-library
videos only, which is what's actually achievable, vs. what a user might
expect from "paste a Vimeo link") and on whether adding a serverless
component is acceptable before piece 2 is worth building; piece 1 could
ship independently as a lightweight preview feature regardless.
