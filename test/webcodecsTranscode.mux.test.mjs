import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { demux } from '../src/lib/videoFrameCache.js'
import { createMp4Muxer } from '../src/lib/webcodecsTranscode.js'

// The WebCodecs scrub proxy is written by mp4-muxer and read back by
// VideoFrameCache's mp4box-based demux. Encoding needs a browser, but the
// handoff doesn't: remux the fixture's real H.264 samples the way the
// proxy encoder's output gets muxed (every frame a keyframe, no B-frames,
// presentation-ordered timestamps) and check the demuxer sees exactly that.
const FIXTURE = fileURLToPath(new URL('./fixtures/bbb-640x360-h264-bframes.mp4', import.meta.url))
const FRAME_US = 1e6 / 24

async function remuxAsIntra() {
  const bytes = await readFile(FIXTURE)
  const { track, decodeOrderSamples } = await demux(new File([bytes], 'bbb.mp4', { type: 'video/mp4' }))
  const { muxer, target } = createMp4Muxer('avc', track.video.width, track.video.height)
  const meta = {
    decoderConfig: {
      codec: track.codec,
      codedWidth: track.video.width,
      codedHeight: track.video.height,
      description: track.description,
    },
  }
  decodeOrderSamples.forEach((s, i) => {
    muxer.addVideoChunkRaw(new Uint8Array(s.data), 'key', Math.round(i * FRAME_US), Math.round(FRAME_US), i === 0 ? meta : undefined)
  })
  muxer.finalize()
  const out = await demux(new File([target.buffer], 'proxy.mp4', { type: 'video/mp4' }))
  return { source: { track, samples: decodeOrderSamples }, out }
}

test('demux reads back every muxed frame, all as keyframes', async () => {
  const { source, out } = await remuxAsIntra()
  assert.equal(out.decodeOrderSamples.length, source.samples.length)
  assert.ok(out.decodeOrderSamples.every((s) => s.is_sync))
})

test('timestamps survive the round trip, starting at 0', async () => {
  const { out } = await remuxAsIntra()
  out.decodeOrderSamples.forEach((s, i) => {
    assert.ok(
      Math.abs(s.presentationTimeUs - i * FRAME_US) <= 1000,
      `frame ${i} at ${s.presentationTimeUs}us, expected ~${Math.round(i * FRAME_US)}us`,
    )
  })
})

test('keeps the codec and decoder description VideoDecoder needs', async () => {
  const { source, out } = await remuxAsIntra()
  assert.equal(out.track.codec, source.track.codec)
  assert.equal(out.track.video.width, 640)
  assert.equal(out.track.video.height, 360)
  assert.deepEqual([...out.track.description], [...source.track.description])
})
