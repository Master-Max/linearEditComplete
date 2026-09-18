import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { demux, VideoFrameCache } from '../src/lib/videoFrameCache.js'

// The demux half of VideoFrameCache is pure JS (mp4box + arithmetic), so it
// runs under plain Node - only the decode half needs WebCodecs. That's
// convenient, because the demux half is where the bug was.
//
// Every expected value below is ffprobe's, not this code's. See
// `test/fixtures/README.md` for the commands that produce them.
const FIXTURE = fileURLToPath(new URL('./fixtures/bbb-640x360-h264-bframes.mp4', import.meta.url))

async function demuxFixture() {
  const bytes = await readFile(FIXTURE)
  return demux(new File([bytes], 'bbb-640x360-h264-bframes.mp4', { type: 'video/mp4' }))
}

test('picks the video track out of a file that also has audio', async () => {
  const { track } = await demuxFixture()
  assert.match(track.codec, /^avc1\./)
  assert.equal(track.video.width, 640)
  assert.equal(track.video.height, 360)
  assert.ok(track.description, 'avcC description is needed to configure the decoder')
})

test('demuxes every sample, in decode order', async () => {
  const { decodeOrderSamples } = await demuxFixture()
  assert.equal(decodeOrderSamples.length, 120)
  for (let i = 1; i < decodeOrderSamples.length; i++) {
    assert.ok(
      decodeOrderSamples[i - 1].dts <= decodeOrderSamples[i].dts,
      `sample ${i} is out of decode order`,
    )
  }
})

// The regression this fixture exists for. The clip's edit list has
// media_time 1024 at a 12288 timescale - 0.0833s, two frames at 24fps -
// because B-frame reordering means the first displayed picture isn't at cts 0.
// Reading cts raw put every frame in the cache two frames later than the same
// picture on the <video> element, which REW reports as the clock and marks are
// taken from. VP9 fixtures can't catch this: no B-frames means media_time 0.
test('applies the edit list, so presentation times match the <video> timeline', async () => {
  const { decodeOrderSamples } = await demuxFixture()
  const seconds = (s) => s.presentationTimeUs / 1e6

  assert.equal(seconds(decodeOrderSamples[0]), 0, 'first displayed frame must land at 0, not at the reorder delay')

  const keyframeTimes = decodeOrderSamples.filter((s) => s.is_sync).map((s) => +seconds(s).toFixed(6))
  assert.deepEqual(keyframeTimes, [0, 1.666667, 3.333333])

  const lastTime = Math.max(...decodeOrderSamples.map(seconds))
  assert.ok(Math.abs(lastTime - 4.958333) < 1e-5, `last frame at ${lastTime}, expected 4.958333`)
})

test('preserves B-frame reordering rather than sorting it away', async () => {
  const { decodeOrderSamples } = await demuxFixture()
  const first10 = decodeOrderSamples.slice(0, 10).map((s) => +(s.presentationTimeUs / 1e6).toFixed(6))
  // Presentation order deliberately disagrees with decode order here.
  assert.deepEqual(first10, [0, 0.125, 0.041667, 0.083333, 0.291667, 0.208333, 0.166667, 0.25, 0.458333, 0.375])

  const reordered = decodeOrderSamples.filter(
    (s, i, all) => i > 0 && s.presentationTimeUs < all[i - 1].presentationTimeUs,
  )
  assert.ok(reordered.length > 0, 'fixture is supposed to exercise reordering')
})

// GOP slicing walks decode-order indices from one keyframe to the next, which
// is only sound if each GOP's presentation times stay within their own range.
// An open GOP would break that; this asserts the fixture is closed and that
// the ranges line up end to end with no overlap.
test('GOPs are closed, contiguous, and non-overlapping in presentation time', async () => {
  const { decodeOrderSamples } = await demuxFixture()
  const starts = decodeOrderSamples.flatMap((s, i) => (s.is_sync ? [i] : []))
  const bounds = [...starts, decodeOrderSamples.length]

  let previousMax = -Infinity
  for (let g = 0; g < starts.length; g++) {
    const gop = decodeOrderSamples.slice(bounds[g], bounds[g + 1])
    assert.equal(gop.length, 40, `GOP ${g} should be 40 frames`)
    const times = gop.map((s) => s.presentationTimeUs)
    assert.equal(Math.min(...times), gop[0].presentationTimeUs, `GOP ${g} is open - a frame precedes its keyframe`)
    assert.ok(Math.min(...times) > previousMax, `GOP ${g} overlaps the previous one`)
    previousMax = Math.max(...times)
  }
})

// Stepping one frame. The fixture is 24fps, which is where the original
// implementation failed worst: jog nudged the clock by a hardcoded 1/30s and
// then asked for the frame at or before the result. On 24fps footage 1/30s
// lands short of the next frame (41.7ms away), so a forward jog returned the
// frame it started on and the deck did nothing at all. Going backward it
// overshot into the previous frame and happened to look right, which is why
// only one direction appeared broken.
test('steps exactly one frame forward and back, at the source frame rate', async () => {
  const { decodeOrderSamples } = await demuxFixture()
  const cache = Object.assign(Object.create(VideoFrameCache.prototype), {
    presentationTimesUs: decodeOrderSamples.map((s) => s.presentationTimeUs).sort((a, b) => a - b),
  })

  const frameDuration = 1 / 24
  let t = cache.presentationTimesUs[10] / 1e6

  for (let i = 0; i < 5; i++) {
    const next = cache.nextFrameTimeSeconds(t)
    assert.ok(
      Math.abs(next - t - frameDuration) < 1e-4,
      `forward step ${i} moved ${next - t}s, expected one frame (${frameDuration}s)`,
    )
    t = next
  }
  for (let i = 0; i < 5; i++) {
    const previous = cache.previousFrameTimeSeconds(t)
    assert.ok(
      Math.abs(t - previous - frameDuration) < 1e-4,
      `backward step ${i} moved ${t - previous}s, expected one frame (${frameDuration}s)`,
    )
    t = previous
  }
})

// Times come back from <video>.currentTime and from seconds/microseconds
// round trips, so they arrive a hair off the frame they name. Stepping has to
// survive that without re-finding the frame it started on.
test('steps correctly from a time that is slightly off the frame boundary', async () => {
  const { decodeOrderSamples } = await demuxFixture()
  const cache = Object.assign(Object.create(VideoFrameCache.prototype), {
    presentationTimesUs: decodeOrderSamples.map((s) => s.presentationTimeUs).sort((a, b) => a - b),
  })

  const exact = cache.presentationTimesUs[10] / 1e6
  const expectedNext = cache.presentationTimesUs[11] / 1e6
  const expectedPrevious = cache.presentationTimesUs[9] / 1e6

  for (const drift of [0, 1e-6, -1e-6, 5e-5, -5e-5]) {
    assert.equal(cache.nextFrameTimeSeconds(exact + drift), expectedNext, `next, drift ${drift}`)
    assert.equal(cache.previousFrameTimeSeconds(exact + drift), expectedPrevious, `previous, drift ${drift}`)
  }
})

test('reports no neighbour past either end of the clip', async () => {
  const { decodeOrderSamples } = await demuxFixture()
  const cache = Object.assign(Object.create(VideoFrameCache.prototype), {
    presentationTimesUs: decodeOrderSamples.map((s) => s.presentationTimeUs).sort((a, b) => a - b),
  })
  const times = cache.presentationTimesUs
  assert.equal(cache.previousFrameTimeSeconds(times[0] / 1e6), null)
  assert.equal(cache.nextFrameTimeSeconds(times.at(-1) / 1e6), null)
})
