# Test fixtures

## `bbb-640x360-h264-bframes.mp4`

A 5-second clip of **Big Buck Bunny**, © 2008 Blender Foundation
(<https://www.bigbuckbunny.org>), used under the
[Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/)
license. Re-encoded for this repository; the original is unmodified upstream.

### Why this clip and not a generated one

Fixtures generated in-repo with `ffmpeg.wasm` are VP9, because that's what the
wasm build can encode. VP9 has no B-frames, so its samples need no composition
reordering, so its edit list carries `media_time 0` — and a source with
`media_time 0` cannot catch the class of bug this fixture exists for. See
"Honor the MP4 edit list when timestamping cached frames" in the history and
the `presentationOffsetTicks()` comment in `src/lib/videoFrameCache.js`.

Real camera and editor output looks like this clip, not like those fixtures.

### What it deliberately contains

| property | value | why it's here |
| --- | --- | --- |
| codec | H.264 High, 640x360, 24fps | the format `VideoFrameCache` actually targets |
| duration | 5.0s, 120 frames | small enough to commit (144KB) |
| `has_b_frames` | 2 | forces composition reordering |
| edit list `media_time` | 1024 @ 12288 timescale = 0.0833s | **the regression guard** — two frames at 24fps |
| samples with `pts != dts` | 96 of 120 | decode order genuinely differs from presentation order |
| keyframes | 3, at 0s / 1.667s / 3.333s | exercises GOP lookup, slicing and boundaries |
| GOP length | 40 frames, closed | lets the tests assert non-overlapping GOP ranges |
| audio | one AAC track | so `info.videoTracks[0]` has to actually select |

Exercised by `test/videoFrameCache.demux.test.mjs` (`npm test`). Those tests
run under plain Node — the demux half of `VideoFrameCache` is pure JS, only
the decode half needs WebCodecs.

### Regenerating it

Requires a native `ffmpeg` with `libx264` (not `ffmpeg.wasm`). Source file is
`big-buck-bunny-480p-30sec.mp4` from the `video-media-samples` npm package.

```sh
ffmpeg -ss 4 -t 5 -i big-buck-bunny-480p-30sec.mp4 \
  -vf scale=640:360 -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p \
  -x264-params "bframes=3:b-adapt=2:keyint=40:min-keyint=40:scenecut=40" \
  -c:a aac -b:a 32k -ac 1 -ar 22050 -movflags +faststart \
  bbb-640x360-h264-bframes.mp4
```

If you regenerate it, re-derive the expected values in the test from `ffprobe`
rather than from this code — the point is to check `VideoFrameCache` against an
independent reading of the file:

```sh
# per-packet presentation/decode times and keyframe flags
ffprobe -v error -select_streams v:0 \
  -show_entries packet=pts_time,dts_time,flags -of csv=p=0 \
  bbb-640x360-h264-bframes.mp4
```
