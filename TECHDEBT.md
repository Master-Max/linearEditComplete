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

**Status:** deferred. Not urgent — the recorder/timeline deck's REW is a
discrete `skip(-3)` and unaffected; this is scoped to the player/source
deck's continuous JKL-style scrub.
