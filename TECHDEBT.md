# Tech Debt

## Redundant source writes for reused sources (export pipeline)

**Where:** `src/hooks/useFFmpeg.js`, `exportSequence`

Each timeline clip writes its source file into ffmpeg.wasm's virtual FS
keyed by clip *index* (`in${i}.ext`), not by source. If the same source
video is cut into multiple timeline clips (e.g. three highlights pulled
from one long recording — a common editing pattern), `fetchFile()` re-reads
the entire file into a fresh `ArrayBuffer` and `ffmpeg.writeFile()` copies
it into the wasm virtual FS once per clip, not once per source. For a large
source file this is redundant I/O, memory churn, and wasted export time,
scaling with how many times that source gets reused.

**Fix:** write each unique `sourceId` into the virtual FS once, reference
that filename from every trim command that needs it, and only delete it
after the last clip referencing it has been trimmed.

**Status:** not fixed. No behavior change required, real savings whenever a
source is reused — low-risk, worth doing.

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
