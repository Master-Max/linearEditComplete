import assert from 'node:assert/strict'
import test from 'node:test'

import { demuxWebM, isWebM } from '../src/lib/webmDemux.js'
import { demux } from '../src/lib/videoFrameCache.js'

// Hand-built Matroska, so every structural case is pinned down exactly -
// especially the ones live recorders (GNOME's screencaster, OBS,
// MediaRecorder) produce: unknown-size Segment and Cluster elements, no
// Cues, no Duration. Frame payloads are placeholder bytes; decoding them is
// the browser's job, and what matters here is which bytes come out where.

function vint(n) {
  // Smallest EBML size encoding for n.
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = []
      let v = n
      for (let i = len - 1; i >= 0; i--) {
        out[i] = v & 0xff
        v = Math.floor(v / 256)
      }
      out[0] |= 0x80 >> (len - 1)
      return out
    }
  }
  throw new Error('too big')
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
function idBytes(id) {
  const out = []
  while (id > 0) {
    out.unshift(id & 0xff)
    id = Math.floor(id / 256)
  }
  return out
}
function el(id, children, { unknownSize = false } = {}) {
  const body = Array.isArray(children) ? children.flat(Infinity) : children
  return [...idBytes(id), ...(unknownSize ? UNKNOWN : vint(body.length)), ...body]
}
function uint(id, value, width = 1) {
  const bytes = []
  for (let i = width - 1; i >= 0; i--) bytes.push(Math.floor(value / 256 ** i) & 0xff)
  return el(id, bytes)
}
function str(id, s) {
  return el(id, [...s].map((c) => c.charCodeAt(0)))
}
function block(track, relative, flags, payload) {
  return [...vint(track), (relative >> 8) & 0xff, relative & 0xff, flags, ...payload]
}

// Track 2 is video (track 1 is audio, to check it's filtered out).
// TimestampScale 1ms. Cluster 1 at 0ms (known size), cluster 2 at 1000ms
// with unknown size, then Cues after it to terminate it.
function buildFile({ codecId = 'V_VP9', codecPrivate = null } = {}) {
  const tracks = el(0x1654ae6b, [
    el(0xae, [uint(0xd7, 1), uint(0x83, 2), str(0x86, 'A_OPUS')]),
    el(0xae, [
      uint(0xd7, 2),
      uint(0x83, 1),
      str(0x86, codecId),
      ...(codecPrivate ? [el(0x63a2, codecPrivate)] : []),
      el(0xe0, [uint(0xb0, 1280, 2), uint(0xba, 720, 2)]),
    ]),
  ])
  const cluster1 = el(0x1f43b675, [
    uint(0xe7, 0),
    el(0xa3, block(2, 0, 0x80, [0xaa, 0x01])), // key
    el(0xa3, block(1, 0, 0x80, [0xee])), // audio - ignored
    el(0xa3, block(2, 40, 0x00, [0xaa, 0x02])),
    el(0xa3, block(2, 80, 0x00, [0xaa, 0x03])),
  ])
  const cluster2 = el(
    0x1f43b675,
    [
      uint(0xe7, 1000, 2),
      // BlockGroup keyframe (no ReferenceBlock), then a delta one with a duration
      el(0xa0, [el(0xa1, block(2, 0, 0x00, [0xbb, 0x01]))]),
      el(0xa0, [el(0xa1, block(2, 40, 0x00, [0xbb, 0x02])), uint(0xfb, 1), uint(0x9b, 50)]),
    ],
    { unknownSize: true },
  )
  const cues = el(0x1c53bb6b, [el(0xbb, [uint(0xb3, 0)])])
  const segment = el(
    0x18538067,
    [el(0x1549a966, [uint(0x2ad7b1, 1_000_000, 3)]), tracks, cluster1, cluster2, cues],
    { unknownSize: true },
  )
  const header = el(0x1a45dfa3, [str(0x4282, 'webm')])
  return new Uint8Array([...header, ...segment])
}

test('recognizes WebM by its EBML magic bytes', () => {
  assert.ok(isWebM(buildFile()))
  assert.ok(!isWebM(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))) // MP4 ftyp
})

test('reads the video track through unknown-size Segment and Cluster', () => {
  const { track, decodeOrderSamples } = demuxWebM(buildFile())
  assert.equal(track.codec, 'vp09.00.10.08')
  assert.deepEqual(track.video, { width: 1280, height: 720 })
  assert.deepEqual(
    decodeOrderSamples.map((s) => [...s.data]),
    [[0xaa, 1], [0xaa, 2], [0xaa, 3], [0xbb, 1], [0xbb, 2]],
    'video frames only, in file order, across both clusters',
  )
})

test('timestamps, keyframes and durations', () => {
  const { decodeOrderSamples: s } = demuxWebM(buildFile())
  assert.deepEqual(s.map((x) => x.presentationTimeUs), [0, 40000, 80000, 1000000, 1040000])
  assert.deepEqual(s.map((x) => x.is_sync), [true, false, false, true, false])
  // Gap to the next frame; the last one uses its BlockDuration (50ms).
  assert.deepEqual(s.map((x) => x.durationUs), [40000, 40000, 920000, 40000, 50000])
})

test('H.264 and AV1 codec strings come from CodecPrivate', () => {
  const avc = demuxWebM(buildFile({ codecId: 'V_MPEG4/ISO/AVC', codecPrivate: [1, 0x64, 0x00, 0x28, 0xff] }))
  assert.equal(avc.track.codec, 'avc1.640028')
  assert.deepEqual([...avc.track.description], [1, 0x64, 0x00, 0x28, 0xff])
  // av1C: marker/version, profile 0 + level 8, tier 0 / 8-bit, ...
  const av1 = demuxWebM(buildFile({ codecId: 'V_AV1', codecPrivate: [0x81, 0x08, 0x0c, 0x00] }))
  assert.equal(av1.track.codec, 'av01.0.08M.08')
})

test('demux() routes WebM here regardless of file name', async () => {
  const { track, decodeOrderSamples } = await demux(new File([buildFile()], 'recording.mp4'))
  assert.equal(track.codec, 'vp09.00.10.08')
  assert.equal(decodeOrderSamples.length, 5)
})

test('unsupported codecs throw, so callers fall back to ffmpeg.wasm', () => {
  assert.throws(() => demuxWebM(buildFile({ codecId: 'V_THEORA' })), /unsupported WebM video codec/)
})
