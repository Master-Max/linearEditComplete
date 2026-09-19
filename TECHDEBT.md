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

**Status:** open for the camera-original path, but no longer the common case -
see "Transcode footage to an intra-frame proxy on load" below, which sidesteps
this entirely for any source ffmpeg can transcode rather than fixing
`_decodeGop` itself. Still exactly as described here for the fallback path
(ffmpeg unavailable/fails), which builds the cache from the original file same
as before the proxy existed. Originally found by testing against real footage
rather than the synthetic fixtures used until then; those all had short,
evenly spaced GOPs and so never exercised this.

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

A third pass fixed two costs that were adding to the above rather than being
it, found after users reported REW/jog/FF all feeling noticeably slower once
playback moved onto this cache and its canvas rendering:
- `_bestCachedFrame`/`_earliestCachedFrame` did a linear scan over every
  cached `VideoFrame` (`for (const key of this.frames.keys())`), called on
  every REW tick (~60/sec) and every jog press. With a window of three GOPs
  retained at once, real footage with long GOPs means that scan is over
  hundreds to 1000+ entries, every tick. Replaced with a sorted
  `cachedTimestampsUs` array (kept in sync on insert/evict) and a binary
  search, mirroring `_timeIndexAtOrBefore`.
- `_prefetchAround` decoded both neighboring GOPs unconditionally. During a
  sustained REW or repeated jog in one direction, the neighbor on the far
  side of travel is pure waste competing for the same `decodeQueue` as the
  GOP actually about to be needed next. `getFrameAtOrBefore` now infers
  travel direction from the previous request and `_prefetchAround` skips the
  wrong-side neighbor while direction holds.
- Separately, in `ClassicPlayerDeck.jsx`: the REW and forward-canvas
  (PLAY/FF) render loops called `marks.setCurrentTime` — a React state
  update that re-renders the whole deck — on every single drawn frame,
  instead of at the throttled rate `<video>`'s own `timeupdate` event
  provides the rest of the time. Throttled to `CLOCK_UPDATE_INTERVAL_MS`
  (~15Hz), with a forced final update so the clock always lands exactly
  where a run stopped.

None of this touches the whole-GOP-decode-before-first-frame cost above,
which is still open.

## Transcode footage to an intra-frame proxy on load

**Where:** `src/hooks/useFFmpeg.js` (`transcodeToIntraProxy`),
`src/classic/ClassicPlayerDeck.jsx` (the cache-build effect)

The GOP-decode-latency problem above is architectural: as long as REW/jog
build their frame cache from the camera-original file, a GOP can be however
long the source's own encoder chose to make it (real footage measured up to
480 frames). Rather than redesigning `_decodeGop` to decode partial/bounded
ranges, this sidesteps the problem the way professional NLEs do: transcode to
an all-intra proxy on load and build the frame cache from that instead. Every
output frame is independently decodable, so a GOP there is exactly one frame,
regardless of the source - `getFrameAtOrBefore()`'s whole-GOP-before-first-
frame cost collapses from "however long the source's GOP is" to "one frame."

`transcodeToIntraProxy` runs `-g 1 -bf 0` (GOP-of-1, no B-frames - so no
reorder delay, so no edit-list handling needed for the proxy's own
timestamps), `-an` (nothing that reads from this proxy plays audio - REW
pauses `<video>`, jog shows one still frame, and PLAY/FF never touch this
proxy at all), and downscales to `PROXY_MAX_WIDTH` (960px) since the canvas
that displays it is a fixed 480x270 CSS box (`classic.css`) - decoding and
holding full source resolution for that would be pure waste. Runs through the
same ffmpeg.wasm Worker already used for export, so it doesn't block the main
thread. `ClassicPlayerDeck`'s cache-build effect now tries this first and
builds `VideoFrameCache` from the proxy (with a much wider
`PROXY_WINDOW_RADIUS_FRAMES` retained window than the original-file default,
since a "GOP" is one frame and the same memory budget goes much further);
`ffmpeg` unavailable or the transcode itself failing falls through to
building the cache from the original file exactly as before this existed -
the proxy is a strict enhancement, never a requirement. A
"Preparing fast scrub…" label and progress bar (driven by ffmpeg.wasm's own
`progress` event, scoped to this call via `on`/`off` rather than the shared
hook state `exportSequence` uses, so an unrelated Export click never sees a
stray progress bar) show on the player deck while it runs, followed by a
"File transcoded — Ns for M minute video" stat line once it finishes -
visibility into what that wait actually costs, since it scales with source
length/resolution and was otherwise invisible.

**Verified:** the demux/cache-lookup logic against synthetic and real fixture
data (`npm test`, including new tests for the binary-search/prefetch-
direction changes above). The transcode command itself was run end-to-end
through the real app's ffmpeg.wasm in a real browser against the committed
H.264 fixture (not mocked): the output demuxed with every one of 120 samples
`is_sync` (confirming GOP-of-1), correct frame count, and clean non-reordered
timestamps.

**Not verified:** actual on-screen REW/jog rendering from a proxy in a
browser. This sandbox's Chromium build has no H.264 decode support at all -
not `<video>`, not `VideoDecoder.isConfigSupported()` - so `loadVideoSource`
itself never resolves for an H.264 fixture here, independent of anything in
this change (see the VP9-only note under "Frame cache decodes a whole GOP..."
above, which hit the same wall for the original feature). Worth a manual
pass in a real H.264-capable browser before calling this done.

**Possible follow-ups, not implemented:**
- Transcoding the whole clip up front means a long source takes a while
  before REW/jog get fast - during that window they use whatever the
  fallback path gets (proxy-less cache, or `<video>` reseeking). Transcoding
  only a window around the current playhead, expanding lazily, would bound
  that wait but is meaningfully more complex.
- The proxy is held as an in-memory `Blob`. Fine at the current scale; OPFS
  (Origin Private File System) would matter if proxies for very long/large
  sources became a real memory concern.

A follow-up fixed a real asymmetry this left: REW/jog draw from the (already
downscaled-to-960px) proxy, but FF/PLAY's forward-canvas loop
(`startForwardCanvas` in `ClassicPlayerDeck.jsx`) deliberately never touches
the proxy - it draws directly from `<video>` every displayed frame (see the
comment there on why). That `drawImage` was happening at the source's full
native resolution regardless, even though the canvas is only ever shown at a
fixed 480x270 CSS box. On a high-resolution source that's real work
competing with `<video>`'s own decode for the same thread at 4x, and was
reported as FF staying "normal for a while, then jumping ahead to catch up"
after the REW fixes above had already landed. `fitCanvasToSource()` now caps
every canvas draw (FF/PLAY, REW, jog, and the pre-swap paint) to the same
960px-wide budget the proxy uses, closing the gap between REW and FF's
per-frame cost. Not independently verified against real H.264 playback for
the same sandbox-codec-support reason noted above.

## Scrub-proxy transcode is single-threaded - and the multi-threaded core needs a host GitHub Pages can't be

**Where:** `src/hooks/useFFmpeg.js` (`load`, `loadCore`, `CORE_MT_BASE`),
`vite.config.js` (`crossOriginIsolationHeaders`), `public/ffmpeg-mt/`

Real-world measurement from a user's own footage: 443s to transcode a 594s
(9.9 minute) source - about 1.34x realtime, which is a reasonable number for
a single-threaded WASM x264 pipeline (full decode + downscale + all-intra
re-encode) but still means REW/jog fall all the way back to `<video>`
reseeking for several minutes on a source that length, since the frame cache
only gets built once the transcode fully resolves (see "Transcode footage to
an intra-frame proxy on load" above).

ffmpeg.wasm ships a multi-threaded core (`@ffmpeg/core-mt`, same version as
the single-threaded `@ffmpeg/core` already vendored) that can meaningfully
cut that - but it needs `SharedArrayBuffer`, which only exists when the page
is cross-origin isolated: `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: credentialless`/`require-corp` response
headers. **GitHub Pages, this app's current deploy target
(`.github/workflows/deploy.yml`), serves static files with fixed headers -
there's no way to set custom response headers there.** Getting COOP/COEP on
GitHub Pages at all means retrofitting it client-side via a service worker
(the `coi-serviceworker` pattern), which is real, somewhat fragile
infrastructure (typically needs a forced reload on first visit, adds a
service-worker lifecycle to reason about) just to work around a hosting
limitation.

**The app-side work is done and shipped, gated so it's a strict enhancement:**
`useFFmpeg.js`'s `load()` checks `window.crossOriginIsolated` and tries the
multi-threaded core (`public/ffmpeg-mt/`, added via the `@ffmpeg/core-mt`
devDependency) first when it's true, falling back to the single-threaded
core (`public/ffmpeg/`) on any failure or when it's false - which is every
GitHub Pages page load today, so behavior there is unchanged from before
this existed. `vite.config.js` sets the COOP/COEP headers on Vite's own
`server`/`preview` (local `npm run dev`/`npm run preview` only - this has no
effect on the static files GitHub Pages actually serves) so the
multi-threaded path can be exercised and verified locally.

**Verified locally:** with the dev-server headers active,
`window.crossOriginIsolated` and `SharedArrayBuffer` both reported true, the
multi-threaded core loaded (including the pthread-worker wiring - `workerURL`
in `FFMessageLoadConfig`, `mainScriptUrlOrBlob` propagation into spawned
worker threads - confirmed by reading `@ffmpeg/ffmpeg`'s own worker.js
rather than assumed), and `transcodeToIntraProxy` completed successfully.
With the headers removed, `crossOriginIsolated` correctly reported false and
the same transcode completed via the single-threaded fallback - confirming
today's GitHub Pages behavior is unchanged.

**Status:** in progress - Vercel connected. `vercel.json` sets the same
`credentialless` COOP/COEP headers as the local dev server (see above for why
`credentialless` over `require-corp`), which is the piece GitHub Pages
couldn't do and the actual point of this move.

That surfaced a second, unrelated bug on first deploy: `vite.config.js` had
`base: '/linearEditComplete/'` hardcoded for GitHub Pages' project-site path
(`username.github.io/linearEditComplete/`) - every built `<script>`/`<link>`
tag carried that prefix, which 404s at Vercel's domain root and renders a
blank page (no visible error - React just never mounts). Fixed by branching
on `process.env.VERCEL`, which Vercel sets automatically in its build
environment: GitHub Pages' own build (no `VERCEL` env var) is unaffected,
confirmed by diffing `dist/index.html`'s asset URLs before/after with and
without `VERCEL=1` set locally, and by serving a `VERCEL=1` build from a
plain static server at its root and confirming the app actually renders
(both `/` and `/classic`) rather than trusting the build output alone.

Still open: GitHub Pages itself hasn't been decommissioned or replaced in
`.github/workflows/deploy.yml` - both hosts are live right now, GitHub Pages
still single-threaded (as designed - no COOP/COEP there), Vercel newly
multi-threaded. Whether GitHub Pages stays as a fallback, gets replaced
outright, or any custom domain moves over is a decision for whoever's
driving the migration, not made here.

## Scrub-proxy transcode has no size guard or cancellation

**Where:** `src/classic/ClassicPlayerDeck.jsx`
(`PROXY_MAX_SOURCE_DURATION_SECONDS`, `PROXY_MAX_SOURCE_BYTES`,
`sourceTooBigToTranscode`), `src/hooks/useFFmpeg.js` (`transcodeToIntraProxy`)

Reported directly: on Android Chrome, uploading a long/high-resolution video
on the Vercel deployment froze the page. The scrub-proxy transcode starts
unconditionally the moment any source loads - full decode, downscale, and
all-intra re-encode, entirely uninvited - with nothing sized against the
source first. A real-world 9.9-minute source measured 443s single-threaded
on capable hardware (see the entry above); a long or high-resolution source
on a weaker mobile CPU is proportionally worse, and apparently bad enough to
read as a freeze rather than just a long wait.

**Fix applied:** `ClassicPlayerDeck.jsx` now skips attempting the transcode
- falling straight through to the existing graceful-degradation path (cache
from the original file, or `<video>` reseeking, exactly as when ffmpeg is
unavailable) - when the source's duration exceeds
`PROXY_MAX_SOURCE_DURATION_SECONDS` (180s) or its file size exceeds
`PROXY_MAX_SOURCE_BYTES` (250MB). Either threshold alone is enough to skip,
since a short but very high-bitrate/resolution clip can cost as much to
decode as a long, modest one. A "Fast scrub skipped for this large a video"
message shows so degraded REW/jog doesn't read as a bug. Verified locally:
faking a source's reported duration past the cap skips the transcode
entirely (no "Preparing fast scrub…", no ffmpeg work started) and shows the
skip message; a normal short source is unaffected.

**Not fixed, and harder than it looks:** there's still no way to cancel an
*already-started* transcode - e.g. a source just under the cap that still
takes a while, where the user picks a different video or ejects mid-
transcode. `ffmpeg.exec`/`writeFile`/`readFile` all accept an `AbortSignal`,
but it only rejects the JS-side promise; it does not stop the underlying
WASM work actually running in the worker, which keeps consuming CPU/memory
regardless. The only real way to reclaim that is `ffmpeg.terminate()`,
which kills the whole worker - and `useFFmpeg.js` shares one `FFmpeg`
instance between this transcode and `exportSequence`, so terminating it
from `ClassicPlayerDeck` while an unrelated export happened to be running
would break that export too. Doing this properly needs either separate
FFmpeg instances per use (more memory, another ~30MB core load) or some
form of coordination between the two - deliberately not attempted here
given the size guard above already prevents the reported failure.

**Status:** the reported crash should be fixed; real-world confirmation
(does a large mobile video now degrade gracefully instead of freezing)
is still needed. The thresholds are round-number heuristics, not measured
against real mobile hardware - may need tuning once there's field data.
