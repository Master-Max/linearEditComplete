// Minimal WebM / Matroska demuxer for the first video track: just enough to
// hand VideoDecoder the same { track, decodeOrderSamples } shape demux() in
// videoFrameCache.js builds from MP4 with mp4box, so the scrub cache, the
// WebCodecs scrub proxy and WebCodecs export all work on WebM too.
//
// Screen recordings are the reason it exists - GNOME's screencaster, OBS
// and the browser's own MediaRecorder all write WebM (VP8/VP9, sometimes
// AV1 or H.264), and before this every one of them fell back to ffmpeg.wasm.
// Recorders that write while recording can't know sizes up front, so
// Segment and Cluster often carry the EBML "unknown size" marker, and there
// may be no Cues or Duration at all; this handles those.
//
// Out of scope (throws, and callers fall back to ffmpeg.wasm): laced
// video blocks (essentially never used for video), encrypted or
// header-stripped tracks, codecs WebCodecs can't take from Matroska here.

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  DefaultDuration: 0x23e383,
  ContentEncodings: 0x6d80,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
}

// Children of Segment. Inside an unknown-size Cluster, meeting one of these
// is what ends the cluster.
const SEGMENT_CHILDREN = new Set([
  0x114d9b74, // SeekHead
  ID.Info,
  ID.Tracks,
  ID.Cluster,
  0x1c53bb6b, // Cues
  0x1941a469, // Attachments
  0x1043a770, // Chapters
  0x1254c367, // Tags
])

const TRACK_TYPE_VIDEO = 1

export function isWebM(bytes) {
  return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}

// Element ID: a variable-length integer whose marker bit is kept.
function readId(bytes, pos) {
  const first = bytes[pos]
  let length = 1
  while (length <= 4 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 4) throw new Error(`bad element ID at byte ${pos}`)
  let value = 0
  for (let i = 0; i < length; i++) value = value * 256 + bytes[pos + i]
  return { value, length }
}

// Data size: variable-length integer with the marker bit removed. All
// value bits set means "unknown size" (returned as null).
function readSize(bytes, pos) {
  const first = bytes[pos]
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 8) throw new Error(`bad element size at byte ${pos}`)
  let value = first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i]
    if (bytes[pos + i] !== 0xff) allOnes = false
  }
  return { value: allOnes ? null : value, length }
}

function readUint(bytes, start, end) {
  let value = 0
  for (let i = start; i < end; i++) value = value * 256 + bytes[i]
  return value
}

function readString(bytes, start, end) {
  let s = ''
  for (let i = start; i < end && bytes[i] !== 0; i++) s += String.fromCharCode(bytes[i])
  return s
}

// Calls visit(id, dataStart, dataEnd) for each child element in
// [start, end). An unknown-size child runs to `end`, or - for a Cluster -
// up to the next Segment-level element, which is where a recorder that
// couldn't seek back to patch the size would have started the next one.
function forEachChild(bytes, start, end, visit) {
  let pos = start
  while (pos < end) {
    if (end - pos < 2) break
    const id = readId(bytes, pos)
    const size = readSize(bytes, pos + id.length)
    const dataStart = pos + id.length + size.length
    let dataEnd
    if (size.value === null) {
      dataEnd = id.value === ID.Cluster ? findClusterEnd(bytes, dataStart, end) : end
    } else {
      dataEnd = Math.min(end, dataStart + size.value)
    }
    visit(id.value, dataStart, dataEnd)
    pos = dataEnd
  }
}

function findClusterEnd(bytes, start, end) {
  let pos = start
  while (pos < end) {
    const id = readId(bytes, pos)
    if (SEGMENT_CHILDREN.has(id.value)) return pos
    const size = readSize(bytes, pos + id.length)
    if (size.value === null) return end // nested unknown size - give up bounding it
    pos += id.length + size.length + size.value
  }
  return end
}

function hex2(n) {
  return n.toString(16).padStart(2, '0')
}

// Matroska CodecID (+ CodecPrivate) -> WebCodecs codec string and
// decoder description.
function codecFor(codecId, codecPrivate) {
  switch (codecId) {
    case 'V_VP8':
      return { codec: 'vp8' }
    case 'V_VP9':
      // Profile 0, level 1.0, 8-bit: decoders take the stream's real
      // parameters from the bitstream itself; this only has to be a valid
      // VP9 string.
      return { codec: 'vp09.00.10.08' }
    case 'V_AV1': {
      // CodecPrivate is the av1C record, which is also the description.
      if (!codecPrivate || codecPrivate.length < 4) throw new Error('AV1 track without av1C')
      const profile = codecPrivate[1] >> 5
      const level = codecPrivate[1] & 0x1f
      const tier = codecPrivate[2] >> 7 ? 'H' : 'M'
      const highBitDepth = (codecPrivate[2] >> 6) & 1
      const twelveBit = (codecPrivate[2] >> 5) & 1
      const bitDepth = highBitDepth ? (twelveBit ? 12 : 10) : 8
      return {
        codec: `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(bitDepth).padStart(2, '0')}`,
        description: codecPrivate,
      }
    }
    case 'V_MPEG4/ISO/AVC':
      // CodecPrivate is the avcC record: profile, compatibility, level in
      // bytes 1-3, same as MP4.
      if (!codecPrivate || codecPrivate.length < 4) throw new Error('H.264 track without avcC')
      return {
        codec: `avc1.${hex2(codecPrivate[1])}${hex2(codecPrivate[2])}${hex2(codecPrivate[3])}`,
        description: codecPrivate,
      }
    default:
      throw new Error(`unsupported WebM video codec ${codecId}`)
  }
}

function parseTracks(bytes, start, end) {
  let found = null
  forEachChild(bytes, start, end, (id, s, e) => {
    if (id !== ID.TrackEntry || found) return
    const entry = { number: null, type: null, codecId: null, codecPrivate: null, width: 0, height: 0, defaultDurationNs: null, encoded: false }
    forEachChild(bytes, s, e, (cid, cs, ce) => {
      if (cid === ID.TrackNumber) entry.number = readUint(bytes, cs, ce)
      else if (cid === ID.TrackType) entry.type = readUint(bytes, cs, ce)
      else if (cid === ID.CodecID) entry.codecId = readString(bytes, cs, ce)
      else if (cid === ID.CodecPrivate) entry.codecPrivate = bytes.subarray(cs, ce)
      else if (cid === ID.DefaultDuration) entry.defaultDurationNs = readUint(bytes, cs, ce)
      else if (cid === ID.ContentEncodings) entry.encoded = true
      else if (cid === ID.Video) {
        forEachChild(bytes, cs, ce, (vid, vs, ve) => {
          if (vid === ID.PixelWidth) entry.width = readUint(bytes, vs, ve)
          else if (vid === ID.PixelHeight) entry.height = readUint(bytes, vs, ve)
        })
      }
    })
    if (entry.type === TRACK_TYPE_VIDEO) found = entry
  })
  return found
}

// Block / SimpleBlock payload: track number (vint), int16 timestamp
// relative to the cluster, flags, then the frame.
function parseBlock(bytes, start, end) {
  const track = readSize(bytes, start)
  const pos = start + track.length
  const relative = ((bytes[pos] << 8) | bytes[pos + 1]) << 16 >> 16 // signed int16
  const flags = bytes[pos + 2]
  return { track: track.value, relative, flags, dataStart: pos + 3, dataEnd: end }
}

export function demuxWebM(bytes) {
  if (!isWebM(bytes)) throw new Error('not a WebM/Matroska file')

  let segment = null
  forEachChild(bytes, 0, bytes.length, (id, s, e) => {
    if (id === ID.Segment && !segment) segment = { start: s, end: e }
  })
  if (!segment) throw new Error('no Segment element')

  let timestampScaleNs = 1_000_000
  let track = null
  const blocks = [] // { timeUs, key, data, durationNs }

  forEachChild(bytes, segment.start, segment.end, (id, s, e) => {
    if (id === ID.Info) {
      forEachChild(bytes, s, e, (cid, cs, ce) => {
        if (cid === ID.TimestampScale) timestampScaleNs = readUint(bytes, cs, ce)
      })
    } else if (id === ID.Tracks && !track) {
      track = parseTracks(bytes, s, e)
    } else if (id === ID.Cluster) {
      if (!track) return // Tracks always precede Clusters in practice
      let clusterTime = 0
      forEachChild(bytes, s, e, (cid, cs, ce) => {
        if (cid === ID.Timestamp) {
          clusterTime = readUint(bytes, cs, ce)
        } else if (cid === ID.SimpleBlock) {
          const b = parseBlock(bytes, cs, ce)
          if (b.track !== track.number) return
          if (b.flags & 0x06) throw new Error('laced video blocks are not supported')
          blocks.push({ ticks: clusterTime + b.relative, key: !!(b.flags & 0x80), data: bytes.subarray(b.dataStart, b.dataEnd), durationTicks: null })
        } else if (cid === ID.BlockGroup) {
          let block = null
          let hasReference = false
          let durationTicks = null
          forEachChild(bytes, cs, ce, (gid, gs, ge) => {
            if (gid === ID.Block) block = parseBlock(bytes, gs, ge)
            else if (gid === ID.ReferenceBlock) hasReference = true
            else if (gid === ID.BlockDuration) durationTicks = readUint(bytes, gs, ge)
          })
          if (!block || block.track !== track.number) return
          if (block.flags & 0x06) throw new Error('laced video blocks are not supported')
          // In a BlockGroup, "no ReferenceBlock" is what marks a keyframe.
          blocks.push({ ticks: clusterTime + block.relative, key: !hasReference, data: bytes.subarray(block.dataStart, block.dataEnd), durationTicks })
        }
      })
    }
  })

  if (!track) throw new Error('no video track found')
  if (track.encoded) throw new Error('encrypted or compressed WebM tracks are not supported')
  if (blocks.length === 0) throw new Error('no video frames found')
  const { codec, description } = codecFor(track.codecId, track.codecPrivate)

  const ticksToUs = (ticks) => Math.round((ticks * timestampScaleNs) / 1000)
  // Block timestamps are presentation times, in file (= decode) order.
  // Durations: gap to the next frame in presentation order; the last frame
  // uses its BlockDuration, the track's DefaultDuration, or the average.
  const byTime = blocks.map((b, i) => i).sort((a, b) => blocks[a].ticks - blocks[b].ticks)
  const durationsUs = Array.from({ length: blocks.length })
  for (let k = 0; k < byTime.length - 1; k++) {
    durationsUs[byTime[k]] = Math.max(1, ticksToUs(blocks[byTime[k + 1]].ticks) - ticksToUs(blocks[byTime[k]].ticks))
  }
  const last = byTime[byTime.length - 1]
  const lastBlock = blocks[last]
  const span = ticksToUs(lastBlock.ticks) - ticksToUs(blocks[byTime[0]].ticks)
  durationsUs[last] =
    lastBlock.durationTicks != null
      ? ticksToUs(lastBlock.durationTicks)
      : track.defaultDurationNs
        ? Math.round(track.defaultDurationNs / 1000)
        : Math.max(1, Math.round(span / Math.max(1, blocks.length - 1)))

  const decodeOrderSamples = blocks.map((b, i) => ({
    data: b.data,
    is_sync: b.key,
    presentationTimeUs: ticksToUs(b.ticks),
    durationUs: durationsUs[i],
    dts: i,
  }))

  return {
    track: { codec, description, video: { width: track.width, height: track.height } },
    decodeOrderSamples,
  }
}
