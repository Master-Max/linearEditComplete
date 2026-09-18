import { createFile, DataStream, Endianness } from 'mp4box'

// WebCodecs-based reverse scrub, first slice.
//
// See "WebCodecs-based scrub/rewind" in ROADMAP.md for the full picture.
// This module covers just the demux+decode+cache piece: given a video File,
// it demuxes with mp4box.js and decodes with WebCodecs' VideoDecoder into a
// small cache of already-decoded VideoFrames around the current position, so
// a caller can walk through frames it already has instead of reseeking the
// underlying <video> element on every step (see "Player deck REW runs
// slower than FF" in TECHDEBT.md for why reseeking is the expensive part).
//
// Beyond the GOP containing the most recently requested time, this also
// keeps a small window of neighboring GOPs decoded ahead of time (see
// WINDOW_RADIUS_GOPS below) - a background decode kicked off after every
// getFrameAtOrBefore() call, not awaited by the caller - so that scrubbing
// or jogging across a GOP boundary is usually a cache hit instead of a
// fresh decode-and-wait. It's all one VideoDecoder instance, so this
// prefetch work and any "must have this frame right now" request share the
// same decode queue: a request that lands while a prefetch decode is
// in-flight waits for it, same as it always would have waited for its own
// on-demand decode - never worse than before this existed, and usually
// free because the wait already happened in the background.
//
// Scope: MP4/MOV containers with an AVC (H.264) or HEVC (H.265) video
// track - the common case for footage recorded on phones/most cameras, and
// for anything already round-tripped through this app's own ffmpeg export.
// WebM/VP9/AV1 sources, containers mp4box can't parse, or a codec string
// VideoDecoder rejects all fail init() and the caller is expected to fall
// back to the existing <video> currentTime-stepping REW.

// How many GOPs on each side of the current one to keep decoded and ready.
// 1 covers a single step across a boundary (REW/FF/jog's normal case); raise
// it if jogging or scrubbing tends to cross more than one boundary between
// requests on real footage, at the cost of more decoded frames held in
// memory at once.
const WINDOW_RADIUS_GOPS = 1

// Tolerance when matching a time back to the frame it belongs to. Times make
// a round trip through seconds and through <video>.currentTime between
// leaving this cache and coming back, so they arrive slightly off; 1ms is far
// below any real frame duration (a 240fps source is still 4.2ms) yet well
// above that drift.
const FRAME_MATCH_SLACK_US = 1000

// How long to let a single GOP decode run before giving up on it.
//
// This is a deadlock guard, not a latency budget - it should never fire on a
// decode that is merely slow. It matters because of how decode jobs are
// chained: decodeQueue is reassigned to each new job, so a job that never
// settles is one every later job waits on forever. The queue is fed by the
// background prefetch as well as by direct requests, and nobody awaits a
// prefetch, so a decode that stalls there is invisible until the next REW or
// jog hangs behind it - with no error, no rejection, and so no fallback: the
// deck just freezes with the video paused and the clock stopped. A decoder
// can stall for reasons outside this module's control (notably backpressure
// when too many decoded VideoFrames are still open - see "Frame cache decodes
// a whole GOP before showing anything" in TECHDEBT.md), so the queue has to
// be able to survive one. Rejecting turns a permanent silent freeze into a
// caught error and a fall back to <video> reseeking.
const DECODE_TIMEOUT_MS = 5000

// Rough ceiling on how much decoded video the prefetch window may hold open,
// in bytes of I420 (the cache keeps every VideoFrame in a GOP alive until the
// whole GOP is evicted). Counted in bytes rather than frames because the
// number that is safe depends entirely on resolution: 480p frames are ~615KB
// and 1080p ones ~3.1MB, so a frame count generous enough to be useful at
// 480p holds five times the memory at 1080p.
//
// This bounds the *prefetch* only - the GOP actually being asked for is
// always decoded whole, since there is no way to answer the request
// otherwise. It matters because GOP length is a property of the source, not
// something this code picks: an encoder left to choose its own keyframes can
// emit GOPs hundreds of frames long (see "Frame cache decodes a whole GOP
// before showing anything" in TECHDEBT.md), and with a radius of one the
// window is three of those at once. Beyond the memory, holding that many
// decoded frames open risks starving the decoder's own buffer pool, which on
// a hardware decoder is small and fixed - and a decoder starved that way
// stops producing output rather than failing, which is the stall
// DECODE_TIMEOUT_MS exists to break.
const PREFETCH_BYTE_BUDGET = 256 * 1024 * 1024

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

// How far the track's media timeline is shifted to produce the presentation
// timeline, in media timescale ticks.
//
// This matters because of B-frames. A sample's `cts` counts from the start of
// the *media*, and an encoder that reorders frames has to emit the first
// displayed frame a couple of composition steps in, so raw `cts` for that
// frame is not 0 - it's the reorder delay. Every muxer that produces such a
// file (x264/ffmpeg and, downstream of them, essentially every phone and
// camera) writes an edit list saying "start the presentation at media_time",
// and that is what makes the first displayed frame land at 0 on the clock.
// `<video>` honors it. The sample table on its own does not, so without this
// every VideoFrame in the cache would carry a timestamp a couple of frames
// later than the same picture's time on the `<video>` element - which is
// exactly the clock REW reports and marks get recorded against. On Big Buck
// Bunny's 24fps H.264 that offset measures 0.0833s, a clean two frames.
//
// Two edit shapes are handled, which between them cover real files: leading
// empty edits (media_time -1, a blank delay before the media starts) and the
// first real edit's media_time (a trim). Anything more elaborate - multiple
// real edits, non-1.0 rates - is a genuine edit decision list, which this
// cache doesn't model; the first real edit still wins, matching what the rest
// of the app assumes about a source being one continuous clip.
function presentationOffsetTicks(mp4boxFile, trackId, movieTimescale, mediaTimescale) {
  const entries = mp4boxFile.getTrackById(trackId)?.edts?.elst?.entries
  if (!entries?.length) return 0
  let emptyTicks = 0
  for (const entry of entries) {
    if (entry.media_time < 0) {
      emptyTicks += (entry.segment_duration / movieTimescale) * mediaTimescale
      continue
    }
    return entry.media_time - emptyTicks
  }
  return 0
}

// Exported for `test/videoFrameCache.demux.test.mjs`, which runs this against
// a real B-frame fixture. Everything up to `VideoDecoder` is pure JS that
// works under plain Node, so the demux half is testable without a browser -
// worth keeping reachable, since it's the half that had a silent bug.
export function demux(file) {
  return new Promise((resolve, reject) => {
    const mp4boxFile = createFile()
    let trackInfo = null
    let offsetTicks = 0

    mp4boxFile.onError = (error) => reject(new Error(`mp4box: ${error}`))

    mp4boxFile.onReady = (info) => {
      const track = info.videoTracks[0]
      if (!track) {
        reject(new Error('no video track found'))
        return
      }
      trackInfo = track
      trackInfo.description = extractDescription(mp4boxFile, track.id)
      offsetTicks = presentationOffsetTicks(mp4boxFile, track.id, info.timescale, track.timescale)
      mp4boxFile.setExtractionOptions(track.id, null, { nbSamples: Infinity })
      mp4boxFile.start()
    }

    mp4boxFile.onSamples = (trackId, ref, sampleList) => {
      const decodeOrderSamples = sampleList
        .map((s) => ({
          data: s.data,
          is_sync: s.is_sync,
          presentationTimeUs: Math.round(((s.cts - offsetTicks) / s.timescale) * 1e6),
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
  constructor(file, { windowRadiusGops = WINDOW_RADIUS_GOPS } = {}) {
    this.file = file
    this.windowRadiusGops = windowRadiusGops
    this.decoder = null
    this.approximateFrameBytes = 0
    this.decodeOrderSamples = []
    this.presentationTimesUs = [] // every frame's presentation time, ascending
    this.keyframeIndices = [] // sample index of each GOP's start, ascending
    this.keyframeTimesUs = [] // parallel to keyframeIndices
    this.currentGopStart = -1 // GOP most recently actually requested
    this.lastRequestedUs = null // targetUs of the previous getFrameAtOrBefore call, for prefetch direction
    this.frames = new Map() // presentationTimeUs -> VideoFrame, across every retained GOP
    // Ascending array of frames.keys() - kept in sync on every insert/evict
    // so _bestCachedFrame/_earliestCachedFrame can binary-search instead of
    // scanning the whole cache, which REW and jog call on every tick/press
    // and which can hold 1000+ frames on real footage with long GOPs (see
    // "Frame cache decodes a whole GOP before showing anything" in
    // TECHDEBT.md).
    this.cachedTimestampsUs = []
    this.decodedGops = new Map() // gopStartIndex -> timestampsUs decoded for it (for eviction)
    this.pendingGops = new Map() // gopStartIndex -> in-flight decode Promise
    this.decodeQueue = Promise.resolve() // serializes decode+flush jobs on the single decoder
    this.activeDecodeTimestamps = null // set while a decode job is running; output() pushes here
    this.closed = false // close() ran - teardown, nobody is waiting on results
    this.fatalError = null // the decoder died on its own - callers still want to know
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

    // I420: one luma plane plus two half-resolution chroma planes.
    this.approximateFrameBytes = Math.round(track.video.width * track.video.height * 1.5)
    this.decodeOrderSamples = decodeOrderSamples
    // Every frame's presentation time, ascending. decodeOrderSamples is in
    // decode order, which with B-frames is NOT presentation order, so this
    // needs its own sorted copy - it's what lets a caller ask for the frame
    // adjacent to a given time instead of guessing at a time offset.
    this.presentationTimesUs = decodeOrderSamples.map((s) => s.presentationTimeUs).sort((a, b) => a - b)
    for (let i = 0; i < decodeOrderSamples.length; i++) {
      if (decodeOrderSamples[i].is_sync) {
        this.keyframeIndices.push(i)
        this.keyframeTimesUs.push(decodeOrderSamples[i].presentationTimeUs)
      }
    }
    if (this.keyframeIndices.length === 0) throw new Error('no keyframes found')

    this.decoder = new VideoDecoder({
      output: (frame) => {
        this.frames.set(frame.timestamp, frame)
        this._insertCachedTimestamp(frame.timestamp)
        this.activeDecodeTimestamps?.push(frame.timestamp)
      },
      // WebCodecs closes the decoder when it errors, so the cache is dead
      // from here on. Recording that is what lets _throwIfDecoderBroken
      // tell this apart from our own close() and keep reporting failures
      // to callers, who fall back to <video> reseeking rather than sitting
      // on a cache that will now silently never produce another frame.
      error: (err) => {
        this.fatalError = err instanceof Error ? err : new Error(String(err))
        console.error('VideoFrameCache decode error', err)
      },
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

  // Binary search keyframeIndices for gopStartIndex's own position in GOP
  // order (as opposed to _findGopStartIndex, which searches by time) - lets
  // _windowGopStarts walk to actual neighboring GOPs regardless of how long
  // each one runs.
  _keyframeOrdinal(gopStartIndex) {
    let lo = 0
    let hi = this.keyframeIndices.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.keyframeIndices[mid] === gopStartIndex) return mid
      if (this.keyframeIndices[mid] < gopStartIndex) lo = mid + 1
      else hi = mid - 1
    }
    return -1
  }

  _windowGopStarts(centerGopStart) {
    const ord = this._keyframeOrdinal(centerGopStart)
    const result = []
    for (let d = -this.windowRadiusGops; d <= this.windowRadiusGops; d++) {
      const idx = ord + d
      if (idx >= 0 && idx < this.keyframeIndices.length) result.push(this.keyframeIndices[idx])
    }
    return result
  }

  // Largest index in ascending `arr` whose value is <= target, or -1 if
  // target precedes every element. Shared by every "which sample covers
  // this time" lookup in this class.
  _indexAtOrBefore(arr, target) {
    let lo = 0
    let hi = arr.length - 1
    let ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (arr[mid] <= target) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return ans
  }

  // Index in ascending `arr` where `value` belongs to keep it sorted (the
  // index of the first element >= value, or arr.length if none) - used to
  // maintain cachedTimestampsUs as frames are decoded and evicted.
  _insertionIndex(arr, value) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (arr[mid] < value) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  _insertCachedTimestamp(ts) {
    this.cachedTimestampsUs.splice(this._insertionIndex(this.cachedTimestampsUs, ts), 0, ts)
  }

  _removeCachedTimestamp(ts) {
    const idx = this._insertionIndex(this.cachedTimestampsUs, ts)
    if (this.cachedTimestampsUs[idx] === ts) this.cachedTimestampsUs.splice(idx, 1)
  }

  _bestCachedFrame(targetUs) {
    const idx = this._indexAtOrBefore(this.cachedTimestampsUs, targetUs)
    return idx === -1 ? null : this.frames.get(this.cachedTimestampsUs[idx])
  }

  _earliestCachedFrame() {
    return this.cachedTimestampsUs.length ? this.frames.get(this.cachedTimestampsUs[0]) : null
  }

  // Two very different reasons the decoder can stop being usable, which
  // must NOT be treated the same way:
  //
  // - close() ran (source changed, component unmounted). Nothing is waiting
  //   on this result - whoever asked is already being no-op'd by the
  //   caller's own generation check - so bailing quietly is correct.
  // - the decoder died on its own. WebCodecs closes a decoder when it hits
  //   an error, so this looks identical from decoder.state alone, but here
  //   the caller very much does still want an answer and has a working
  //   fallback (<video> reseeking) ready for exactly this. Bailing quietly
  //   here instead strands it: getFrameAtOrBefore resolves to null forever,
  //   REW draws nothing and freezes rather than falling back.
  _throwIfDecoderBroken() {
    if (this.fatalError) throw this.fatalError
    if (this.decoder.state !== 'configured') {
      throw new Error(`VideoFrameCache decoder is '${this.decoder.state}', not usable`)
    }
  }

  async _decodeGop(gopStartIndex) {
    if (this.closed) return
    this._throwIfDecoderBroken()

    let endIndex = gopStartIndex + 1
    while (endIndex < this.decodeOrderSamples.length && !this.decodeOrderSamples[endIndex].is_sync) {
      endIndex++
    }

    // Safe because decode jobs are serialized through decodeQueue (see
    // _ensureGopDecoded) - only one job is ever actually running against the
    // decoder at a time, so the fixed output() callback set in init() can
    // attribute every frame it receives to whichever job is current.
    const timestamps = []
    this.activeDecodeTimestamps = timestamps

    for (let i = gopStartIndex; i < endIndex; i++) {
      if (this.closed) return
      this._throwIfDecoderBroken()
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
    if (this.closed) return
    this._throwIfDecoderBroken()
    await this._flushWithTimeout()
    this.activeDecodeTimestamps = null
    this.decodedGops.set(gopStartIndex, timestamps)
  }

  // decoder.flush(), but guaranteed to settle - see DECODE_TIMEOUT_MS.
  //
  // A timeout is recorded as fatal rather than left for the next call to
  // retry. A decoder that has stalled once stalls again, and retrying would
  // buy nothing while costing another DECODE_TIMEOUT_MS of frozen deck on
  // every subsequent step. Marking it fatal makes every later call throw
  // immediately, which is what gets the caller onto its <video> fallback and
  // keeps REW and jog responsive - degraded, but working.
  async _flushWithTimeout() {
    let timer
    try {
      await Promise.race([
        this.decoder.flush(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`VideoFrameCache decode timed out after ${DECODE_TIMEOUT_MS}ms`)),
            DECODE_TIMEOUT_MS,
          )
        }),
      ])
    } catch (err) {
      if (!this.closed && !this.fatalError) {
        this.fatalError = err instanceof Error ? err : new Error(String(err))
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  // Decodes a GOP if it isn't already decoded or already being decoded,
  // sharing the in-flight promise with any other caller asking for the same
  // one (a request landing mid-prefetch waits on that same prefetch rather
  // than starting a redundant second decode).
  _ensureGopDecoded(gopStartIndex) {
    if (this.decodedGops.has(gopStartIndex)) return Promise.resolve()
    const pending = this.pendingGops.get(gopStartIndex)
    if (pending) return pending

    const job = this.decodeQueue.then(() => this._decodeGop(gopStartIndex))
    // Keep the queue alive even if this job fails, so a later request for a
    // different GOP isn't stuck behind a rejected one.
    this.decodeQueue = job.catch(() => {})
    this.pendingGops.set(gopStartIndex, job)
    job.finally(() => this.pendingGops.delete(gopStartIndex))
    return job
  }

  _evictGop(gopStartIndex) {
    const timestamps = this.decodedGops.get(gopStartIndex)
    if (!timestamps) return
    for (const ts of timestamps) {
      this.frames.get(ts)?.close()
      this.frames.delete(ts)
      this._removeCachedTimestamp(ts)
    }
    this.decodedGops.delete(gopStartIndex)
  }

  _evictOutsideWindow(centerGopStart) {
    const keep = new Set(this._windowGopStarts(centerGopStart))
    for (const gopStart of Array.from(this.decodedGops.keys())) {
      if (!keep.has(gopStart)) this._evictGop(gopStart)
    }
  }

  // Kicks off decoding whichever GOPs around centerGopStart aren't already
  // decoded or in flight, without waiting for them - by the time a
  // following getFrameAtOrBefore call actually needs one of these, it's
  // hopefully already sitting in the cache instead of triggering a fresh
  // decode-and-wait. Failures here are swallowed (logged) rather than
  // thrown, since nothing is actually waiting on a prefetch to succeed.
  //
  // `direction` (-1 backward, +1 forward, 0 unknown) biases which neighbour
  // gets prefetched. Both neighbours share the same decodeQueue as whatever
  // GOP gets asked for next, so during a sustained REW or repeated jog in
  // one direction, decoding the neighbour on the *other* side is pure waste
  // competing for the same queue as the GOP that's actually about to be
  // needed - it's only useful if travel direction reverses, which is rare
  // mid-run. Unknown direction (the first call of a run) still prefetches
  // both, same as before.
  _prefetchAround(centerGopStart, direction = 0) {
    for (const gopStart of this._windowGopStarts(centerGopStart)) {
      if (gopStart === centerGopStart) continue
      if (direction > 0 && gopStart < centerGopStart) continue
      if (direction < 0 && gopStart > centerGopStart) continue
      // Checked per neighbour rather than once up front, so a source whose
      // GOPs are small enough still gets both of them prefetched while one
      // with long GOPs stops after whatever fits.
      if (this.frames.size * this.approximateFrameBytes >= PREFETCH_BYTE_BUDGET) return
      this._ensureGopDecoded(gopStart).catch((err) => {
        console.warn('VideoFrameCache: background prefetch failed', err)
      })
    }
  }

  // Index into presentationTimesUs of the last frame at or before targetUs,
  // or -1 if targetUs precedes the first frame.
  _timeIndexAtOrBefore(targetUs) {
    return this._indexAtOrBefore(this.presentationTimesUs, targetUs)
  }

  // Which frame a given time sits on, snapped to the sample table.
  //
  // A time that came from this cache has usually been round-tripped through
  // seconds and through <video>.currentTime by the time it comes back, so it
  // can land a hair either side of the frame it names. FRAME_MATCH_SLACK_US
  // absorbs that; it's an order of magnitude below the shortest plausible
  // frame duration, so it can't reach into a neighbouring frame.
  _frameIndexAt(timeSeconds) {
    return this._timeIndexAtOrBefore(Math.round(timeSeconds * 1e6) + FRAME_MATCH_SLACK_US)
  }

  // The presentation time of the frame immediately after / before the one
  // containing the given time, or null at either end of the clip.
  //
  // Stepping a frame is a question about the sample table, not about time.
  // A caller that instead nudges the clock by an assumed frame duration and
  // asks for the frame at-or-before the result gets it wrong at every frame
  // rate except exactly the one it assumed: a 1/30s nudge on 24fps footage
  // lands short of the next frame and returns the frame it started on, so a
  // forward jog does nothing at all, while on 60fps footage it clears two
  // frames at once. Reading the neighbouring timestamp out of the table is
  // right at any frame rate, variable ones included.
  nextFrameTimeSeconds(fromTimeSeconds) {
    const next = this._frameIndexAt(fromTimeSeconds) + 1
    if (next >= this.presentationTimesUs.length) return null
    return this.presentationTimesUs[next] / 1e6
  }

  previousFrameTimeSeconds(fromTimeSeconds) {
    const previous = this._frameIndexAt(fromTimeSeconds) - 1
    if (previous < 0) return null
    return this.presentationTimesUs[previous] / 1e6
  }

  // Returns the decoded VideoFrame at or immediately before targetTimeSeconds,
  // decoding the containing GOP first if it isn't already cached. Callers
  // must NOT call frame.close() on the result - the cache owns it and closes
  // it once it falls out of the decoded window.
  async getFrameAtOrBefore(targetTimeSeconds) {
    const targetUs = Math.max(0, Math.round(targetTimeSeconds * 1e6))
    // Which GOP targetUs actually falls in must be checked before trusting
    // the cache: a cached frame can have a timestamp <= targetUs just
    // because it's left over from a neighboring GOP kept around by the
    // prefetch window, not because it's actually the nearest one.
    const gopStartIndex = this._findGopStartIndex(targetUs)
    // Infer travel direction from the previous request - see the comment on
    // _prefetchAround for why this matters during a sustained REW/jog run.
    const direction = this.lastRequestedUs == null ? 0 : Math.sign(targetUs - this.lastRequestedUs)
    this.lastRequestedUs = targetUs
    this.currentGopStart = gopStartIndex

    await this._ensureGopDecoded(gopStartIndex)
    this._evictOutsideWindow(gopStartIndex)
    this._prefetchAround(gopStartIndex, direction)

    return this._bestCachedFrame(targetUs) ?? this._earliestCachedFrame()
  }

  close() {
    this.closed = true
    for (const frame of this.frames.values()) frame.close()
    this.frames.clear()
    this.cachedTimestampsUs = []
    this.decodedGops.clear()
    this.pendingGops.clear()
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
  }
}
