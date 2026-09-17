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
- Audio sync needs its own path — canvas only carries video, so audio
  playback (currently implicit via the `<video>` element) would need a
  separate `<audio>`/Web Audio element kept in sync with the frame cache.
  Scrub/rewind already plays silently today (frame-stepping via
  `currentTime` with `playbackRate` effectively 0 doesn't emit audio), so
  this only needs solving for normal forward playback, not rewind itself.
- Fallback path needed for browsers without WebCodecs support — likely the
  current `<video>` seek-stepping implementation, kept as the degraded mode.

**Why not now (for the rest of the scope below):** the full version is an
architecture change, not a bugfix — closer to a multi-day rewrite of both
decks than the interval/seek tweaks in `TECHDEBT.md`. The first slice below
was worth doing on its own because it directly fixes the REW-slower-than-FF
problem without touching the recorder/timeline deck or forward
playback/audio at all.

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
- **Still proposed:** everything else in "Scope / what changes" above - the
  recorder/timeline deck's `skip()` REW, forward playback moving off
  `<video>` (which is what would need the audio-sync work), and dropping the
  `<video>` fallback path entirely.
