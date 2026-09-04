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

**Why not now:** this is an architecture change, not a bugfix — closer to a
multi-day rewrite of both decks than the interval/seek tweaks in
`TECHDEBT.md`. Worth doing if scrub/rewind responsiveness becomes a real
product priority; overkill if the all-intra proxy or seeked-event-driven
stepping fix is enough.

**Status:** proposed, not started. Revisit after the two `TECHDEBT.md`
rewind items are triaged.
