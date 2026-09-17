import { createFile, DataStream, Endianness } from 'mp4box'

// WebCodecs-based reverse scrub, first slice.
//
// See "WebCodecs-based scrub/rewind" in ROADMAP.md for the full picture.
// This module covers just the demux+decode+cache piece: given a video File,
// it demuxes with mp4box.js and decodes with WebCodecs' VideoDecoder into a
// small cache of already-decoded VideoFrames around the current GOP, so a
// caller can walk backward through frames it already has instead of
// reseeking the underlying <video> element on every step (see "Player deck
// REW runs slower than FF" in TECHDEBT.md for why reseeking is the
// expensive part).
//
// Scope: MP4/MOV containers with an AVC (H.264) or HEVC (H.265) video
// track - the common case for footage recorded on phones/most cameras, and
// for anything already round-tripped through this app's own ffmpeg export.
// WebM/VP9/AV1 sources, containers mp4box can't parse, or a codec string
// VideoDecoder rejects all fail init() and the caller is expected to fall
// back to the existing <video> currentTime-stepping REW.

export function isFrameCacheSupported() {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
}

function extractDescription(mp4boxFile, trackId) {
  const track = mp4boxFile.getTrackById(trackId)
  for (const entry of track.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC
    if (!box) continue
    const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN)
    box.write(stream)
    // Skip the box's own 8-byte size+type header - VideoDecoder wants just
    // the codec-specific config record.
    return new Uint8Array(stream.buffer, 8)
  }
  return undefined
}

function demux(file) {
  return new Promise((resolve, reject) => {
    const mp4boxFile = createFile()
    let trackInfo = null

    mp4boxFile.onError = (error) => reject(new Error(`mp4box: ${error}`))

    mp4boxFile.onReady = (info) => {
      const track = info.videoTracks[0]
      if (!track) {
        reject(new Error('no video track found'))
        return
      }
      trackInfo = track
      trackInfo.description = extractDescription(mp4boxFile, track.id)
      mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: Infinity })
      mp4boxFile.start()
    }

    mp4boxFile.onSamples = (trackId, ref, sampleList) => {
      const decodeOrderSamples = sampleList
        .map((s) => ({
          data: s.data,
          is_sync: s.is_sync,
          presentationTimeUs: Math.round((s.cts / s.timescale) * 1e6),
          durationUs: Math.round((s.duration / s.timescale) * 1e6),
          dts: s.dts,
        }))
        .sort((a, b) => a.dts - b.dts)
      mp4boxFile.stop()
      resolve({ track: trackInfo, decodeOrderSamples })
    }

    file
      .arrayBuffer()
      .then((buffer) => {
        buffer.fileStart = 0
        mp4boxFile.appendBuffer(buffer)
        mp4boxFile.flush()
      })
      .catch(reject)
  })
}

export class VideoFrameCache {
  constructor(file) {
    this.file = file
    this.decoder = null
    this.decodeOrderSamples = []
    this.keyframeIndices = []
    this.keyframeTimesUs = []
    this.currentGopStart = -1
    this.frames = new Map() // presentationTimeUs -> VideoFrame
  }

  async init() {
    const { track, decodeOrderSamples } = await demux(this.file)
    if (decodeOrderSamples.length === 0) throw new Error('no samples demuxed')

    const config = {
      codec: track.codec,
      codedWidth: track.video.width,
      codedHeight: track.video.height,
      description: track.description,
    }
    const support = await VideoDecoder.isConfigSupported(config)
    if (!support.supported) throw new Error(`unsupported codec config: ${track.codec}`)

    this.decodeOrderSamples = decodeOrderSamples
    for (let i = 0; i < decodeOrderSamples.length; i++) {
      if (decodeOrderSamples[i].is_sync) {
        this.keyframeIndices.push(i)
        this.keyframeTimesUs.push(decodeOrderSamples[i].presentationTimeUs)
      }
    }
    if (this.keyframeIndices.length === 0) throw new Error('no keyframes found')

    this.decoder = new VideoDecoder({
      output: (frame) => this.frames.set(frame.timestamp, frame),
      error: (err) => console.error('VideoFrameCache decode error', err),
    })
    this.decoder.configure(config)
  }

  // Binary search for the last keyframe at or before targetUs, returning
  // its index into decodeOrderSamples (i.e. the start of its GOP).
  _findGopStartIndex(targetUs) {
    const times = this.keyframeTimesUs
    let lo = 0
    let hi = times.length - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (times[mid] <= targetUs) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return this.keyframeIndices[ans]
  }

  _bestCachedFrame(targetUs) {
    let bestKey = -1
    for (const key of this.frames.keys()) {
      if (key <= targetUs && key > bestKey) bestKey = key
    }
    return bestKey === -1 ? null : this.frames.get(bestKey)
  }

  _earliestCachedFrame() {
    let bestKey = Infinity
    for (const key of this.frames.keys()) {
      if (key < bestKey) bestKey = key
    }
    return bestKey === Infinity ? null : this.frames.get(bestKey)
  }

  async _decodeGop(gopStartIndex) {
    if (this.currentGopStart !== gopStartIndex) {
      for (const frame of this.frames.values()) frame.close()
      this.frames.clear()
    }

    let endIndex = gopStartIndex + 1
    while (endIndex < this.decodeOrderSamples.length && !this.decodeOrderSamples[endIndex].is_sync) {
      endIndex++
    }

    for (let i = gopStartIndex; i < endIndex; i++) {
      const s = this.decodeOrderSamples[i]
      this.decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: s.presentationTimeUs,
          duration: s.durationUs,
          data: s.data,
        }),
      )
    }
    await this.decoder.flush()
    this.currentGopStart = gopStartIndex
  }

  // Returns the decoded VideoFrame at or immediately before targetTimeSeconds,
  // decoding the containing GOP first if it isn't already cached. Callers
  // must NOT call frame.close() on the result - the cache owns it and closes
  // it once it falls out of the decoded window.
  async getFrameAtOrBefore(targetTimeSeconds) {
    const targetUs = Math.max(0, Math.round(targetTimeSeconds * 1e6))
    // Which GOP targetUs actually falls in must be checked before trusting
    // the cache: a cached frame can have a timestamp <= targetUs just
    // because it's left over from a GOP decoded earlier in the scrub (e.g.
    // scrubbing backward through GOP A, then jumping forward past GOP B
    // into GOP C - A's frames are still cached and older than the target,
    // but they're the wrong GOP's frames, not simply stale-but-close).
    const gopStartIndex = this._findGopStartIndex(targetUs)
    if (gopStartIndex !== this.currentGopStart) {
      await this._decodeGop(gopStartIndex)
    }
    return this._bestCachedFrame(targetUs) ?? this._earliestCachedFrame()
  }

  close() {
    for (const frame of this.frames.values()) frame.close()
    this.frames.clear()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
  }
}
