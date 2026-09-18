# Tech Debt

## Trim always re-encodes, never stream-copies

**Where:** `src/hooks/useFFmpeg.js`, `exportSequence` (`-c:v libx264 -preset
ultrafast -c:a aac`)

Every trim fully re-encodes, even when an in/out point happens to land on
or near a keyframe, where `-c copy` would be 10–100x faster with no quality
loss. `ultrafast` re-encoding is already close to the fastest wasm x264 can
go, so this is closer to "leave as-is" than a bug, but it's worth naming.

**Fix:** probe for keyframe-aligned cuts and stream-copy when possible,
falling back to re-encode otherwise. Meaningfully more complex (keyframe
probing) for a payoff that depends on where the user's cut points happen to
land.

**Status:** deferred. Only worth doing if export speed on long clips
becomes a real user complaint.

## ffmpeg-core.wasm (~32MB) reloaded via blob conversion on every page load

**Where:** `src/hooks/useFFmpeg.js`, `load()` (`toBlobURL` calls)

The core JS/wasm files are self-hosted under `public/ffmpeg/` (no CDN
dependency), but `toBlobURL` does a `fetch()` + `.blob()` +
`URL.createObjectURL()` conversion every time the page loads — required
because the ffmpeg.wasm worker (itself a blob URL) can't `import()` a
plain same-origin URL from within its own scope. The underlying network
fetch should hit the browser's normal HTTP cache on repeat visits, but
that's relying on default caching behavior rather than something explicit.

**Fix:** serve `public/ffmpeg/*` with long-lived immutable `Cache-Control`
headers, or add a service worker, to make repeat-load speed guaranteed
rather than incidental. Matters most for the "everything runs locally"
goal — an explicit offline-first cache means it keeps working without a
network round-trip at all after first load.

**Status:** deferred, nice-to-have. Current behavior is probably fine in
practice but unverified across hosts/browsers.

## Player deck REW runs slower than FF despite matching nominal rate

**Where:** `src/classic/ClassicPlayerDeck.jsx`, `rewind()` (line ~83) vs
`fastForward()` (line ~75)

FF sets `v.playbackRate = 4` and lets the browser natively decode forward —
cheap, since it's just streaming faster. HTML5 video can't decode backward
at all, so REW is emulated with a `setInterval(20ms)` that steps
`v.currentTime -= 0.08`, which nominally matches FF's 4x
(`0.08s / 20ms = 4x`). But each `currentTime` assignment triggers a real
seek (decode back to the nearest keyframe, then forward to the target
frame), which is far more expensive than native forward streaming. The
loop guards with `if (v.seeking) return` to avoid piling up seek requests
faster than the browser can resolve them (see below), so any tick where
the previous seek hasn't resolved yet is silently skipped — that 0.08s of
video time is lost rather than applied. On real footage with sparse
keyframes this happens often enough that the effective rewind rate drops
well below the nominal 4x, which reads as REW being slower than FF even
though the math says they should match.

The `v.seeking` guard itself isn't the bug — it was added in `e9dfcf6` to
fix a real freeze: the old frontend's equivalent loop
(`PlayerMonitor.js` `reverse()`) had no such guard and would pile up seek
requests unconditionally. So the guard trades a freeze for a slowdown;
removing it isn't a fix.

**Fix:** drive stepping off the video's `seeked` event instead of a fixed
interval — schedule the next step only once the previous seek resolves,
and size each step by actual elapsed wall-clock time (`performance.now()`)
rather than assuming every tick represents 20ms. That makes the rate
self-correct to whatever the browser can actually deliver instead of
losing time to skipped ticks.

**Status:** fixed for the common case, this exact code path kept as the
fallback. The "WebCodecs-based scrub/rewind" entry in `ROADMAP.md` shipped
a first slice: when the source's container/codec support it,
`rewind()` now walks a decoded-frame cache (`src/lib/videoFrameCache.js`)
instead of reseeking `<video>` at all, which removes the seek cost this
entry is about entirely (not just the timing drift - the wall-clock-based
stepping fix proposed above went into that new path too, since it was
already being rewritten). This exact `setInterval`/`v.seeking` code stays
untouched as `startReseekRewind()`, used when the frame cache can't be
built (unsupported browser, non-MP4/MOV source, unsupported codec) - for
that fallback case, the problem described above still applies as written
and the proposed fix above is still unapplied to it.

## Frame cache decodes a whole GOP before showing anything, and sizes its window in GOPs

**Where:** `src/lib/videoFrameCache.js` (`_decodeGop`, `_evictOutsideWindow`,
`WINDOW_RADIUS_GOPS`)

`getFrameAtOrBefore()` awaits `_decodeGop()`, which submits every sample in
the containing GOP and waits for `decoder.flush()` before returning a frame.
Eviction is likewise counted in GOPs: the cache retains the current GOP plus
`WINDOW_RADIUS_GOPS` on each side. Both assume a GOP is a small, roughly
fixed unit. Real footage doesn't guarantee that.

Measured against Big Buck Bunny, transcoded to VP9 at 854x480/24fps so this
sandbox's Chromium can actually decode it (it has no H.264 decoder):

| source | GOP length | time from REW press to first frame on screen |
| --- | --- | --- |
| `-g 48` (fixed 2s keyframes) | 48 frames | **101 ms** |
| `-g 9999` (encoder picks) | 480 frames, the whole clip | **612 ms** |

That second number is the "goes black for a moment when you press REW"
behavior, and a single-GOP file is not a contrived shape — it's what you get
by letting the encoder decide. The H.264 original is milder but still uneven:
its five keyframes sit at 0s, 10.4s, 11.9s, 15.8s and 23.0s, so its first GOP
is 250 frames and its second is 35. REW does still work in every case (the
clock stalls, then descends normally — see the REW flow suite), so this is
latency, not breakage.

The eviction side is the part with teeth. Holding three neighboring GOPs of a
250-frame-GOP 1080p source means ~750 decoded `VideoFrame`s alive at once, and
a 1080p I420 frame is ~3.1MB of (mostly non-JS-heap) memory — roughly 1.5GB,
against platform limits on how many `VideoFrame`s can be open at all. The
sandbox measurement above doesn't show it because 854x480 frames are ~8x
smaller; the JS heap reads ~20MB either way precisely because the frames
aren't on it.

**Fix:** stop treating "a GOP" as the unit for either operation.
- Cap retention by decoded frame count (or bytes), not GOP count, so a long
  GOP is held partially rather than wholly.
- Return from `getFrameAtOrBefore()` as soon as the requested timestamp shows
  up in `frames` — `output()` already populates it progressively — instead of
  awaiting the full `flush()`. This doesn't help the first REW press into a
  long GOP, which genuinely has to decode from the keyframe to the target, but
  it does drop the tail-of-GOP wait on every subsequent one.
- For the first-press case the real answer is decoding a bounded range
  anchored at the keyframe and re-decoding from the keyframe when a backward
  walk runs off the front of it, which is a redesign of `_decodeGop` rather
  than a tweak.

**Status:** open, but no longer able to fail silently. Found by testing against
real footage rather than the synthetic fixtures used until now; those all had
short, evenly spaced GOPs and so never exercised this.

Two guards went in after a report of REW and jog dying outright on real
footage:
- `PREFETCH_BYTE_BUDGET` caps how much decoded video the prefetch window may
  hold open, so long GOPs stop multiplying the memory by the window size. The
  GOP actually being requested is still decoded whole — that part can't be
  avoided without the redesign above.
- `DECODE_TIMEOUT_MS` bounds a single GOP decode. This is a deadlock guard,
  not a latency budget: decode jobs chain through `decodeQueue`, so a decode
  that never settles is one every later decode waits on forever, and because
  the background prefetch enqueues jobs nobody awaits, a stall there surfaces
  only as the next REW or jog hanging with no error to catch. Holding hundreds
  of decoded frames open can starve a hardware decoder's buffer pool, and a
  decoder starved that way stops producing rather than failing — exactly that
  shape. Timing out converts it into a rejection, which falls back to
  `<video>` reseeking.

Neither guard removes the underlying cost; they stop it from presenting as a
frozen deck.
