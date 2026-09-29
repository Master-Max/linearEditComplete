import { ArrayBufferTarget, Muxer } from 'mp4-muxer'
import { demux } from './videoFrameCache.js'
import { clipLength } from './clip.js'

// Video transcoding on the browser's own media stack via WebCodecs - the
// GPU's hardware decoder and encoder where the platform has them, native
// software codecs otherwise. Either way it's far faster than ffmpeg.wasm,
// which is plain WebAssembly on (usually) a single CPU core and can't
// touch the GPU at all. Frames are resized/letterboxed on a 2D canvas,
// which Chrome also runs on the GPU.
//
// Everything here is best-effort: callers (useFFmpeg) fall back to the
// ffmpeg.wasm path when this throws, for any reason - no WebCodecs, a
// source mp4box can't demux (WebM, AVI, ...), a codec the browser can't
// decode, or no encoder for the output codec.
//
// Only video goes through here. Audio stays on ffmpeg.wasm: it's cheap to
// encode on a CPU, the audio pipeline (mixing, silence for silent sources)
// already lives there, and WebCodecs' AudioEncoder can't be relied on for
// AAC - many browsers only offer Opus, which lots of players reject in MP4.

export function isWebCodecsTranscodeSupported() {
  return (
    typeof VideoDecoder !== 'undefined' &&
    typeof VideoEncoder !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  )
}

function even(n) {
  return Math.max(2, Math.round(n / 2) * 2)
}

// H.264 levels: [codec-string level byte, max frame size in 16x16
// macroblocks, max macroblocks per second]. Encoders reject (or silently
// misbehave on) a level too small for the frame size and rate asked of them.
const AVC_LEVELS = [
  [0x1f, 3600, 108000], // 3.1 - 720p30
  [0x20, 5120, 216000], // 3.2 - 720p60
  [0x28, 8192, 245760], // 4.0 - 1080p30
  [0x2a, 8704, 522240], // 4.2 - 1080p60
  [0x32, 22080, 589824], // 5.0
  [0x33, 36864, 983040], // 5.1 - 4K30
  [0x34, 36864, 2073600], // 5.2 - 4K60
  [0x3c, 139264, 4177920], // 6.0
]

function avcCodecStrings(width, height, fps) {
  const frameMbs = Math.ceil(width / 16) * Math.ceil(height / 16)
  const level =
    AVC_LEVELS.find(([, maxFs, maxMbps]) => frameMbs <= maxFs && frameMbs * fps <= maxMbps) ??
    AVC_LEVELS[AVC_LEVELS.length - 1]
  const levelHex = level[0].toString(16).padStart(2, '0')
  // High, then Main, then Constrained Baseline - best compression the
  // encoder offers.
  return ['6400', '4d00', '42e0'].map((profile) => `avc1.${profile}${levelHex}`)
}

// Codec families an encode can ask for, in the caller's order of preference.
// 'avc' is H.264 (what export needs, for playback everywhere); 'vp9' is fine
// for anything only this app reads back, like the scrub proxy.
function codecCandidates(family, width, height, fps) {
  if (family === 'avc') return avcCodecStrings(width, height, fps).map((codec) => ({ codec, muxCodec: 'avc' }))
  if (family === 'vp9') return [{ codec: 'vp09.00.40.08', muxCodec: 'vp9' }]
  throw new Error(`unknown codec family ${family}`)
}

// Tries hardware first, then whatever the browser has. Returns the first
// supported config plus whether it's the hardware one - isConfigSupported
// answers false for 'prefer-hardware' when there's no hardware encoder.
async function pickEncoderConfig({ families, width, height, fps, bitrate, accelerations }) {
  for (const hardwareAcceleration of accelerations) {
    for (const family of families) {
      for (const { codec, muxCodec } of codecCandidates(family, width, height, fps)) {
        const config = {
          codec,
          width,
          height,
          bitrate: Math.round(bitrate),
          framerate: fps,
          hardwareAcceleration,
          ...(muxCodec === 'avc' ? { avc: { format: 'avc' } } : {}),
        }
        try {
          const { supported } = await VideoEncoder.isConfigSupported(config)
          if (supported) return { config, muxCodec, hardware: hardwareAcceleration === 'prefer-hardware' }
        } catch {
          // Malformed for this browser - try the next candidate.
        }
      }
    }
  }
  throw new Error(`no video encoder for ${families.join('/')} at ${width}x${height}`)
}

async function pickDecoderConfig(track, accelerations) {
  const base = {
    codec: track.codec,
    codedWidth: track.video.width,
    codedHeight: track.video.height,
    description: track.description,
  }
  for (const hardwareAcceleration of accelerations) {
    const config = { ...base, hardwareAcceleration }
    try {
      const { supported } = await VideoDecoder.isConfigSupported(config)
      if (supported) return { config, hardware: hardwareAcceleration === 'prefer-hardware' }
    } catch {
      // fall through
    }
  }
  throw new Error(`no video decoder for ${track.codec}`)
}

// First attempt: hardware where the browser has it, else whatever it picks.
// Second: force the browser's software codecs. Hardware encoders are the
// usual thing to fail partway - isConfigSupported can say yes to a config
// the driver then rejects at configure() or mid-encode - and a software
// WebCodecs run is still far faster than falling all the way back to
// ffmpeg.wasm. If both fail, the error names both reasons, for the UI.
//
// The first attempt also takes the fast paths (`fast`: the scrub proxy lets
// the encoder do its own downscaling and, on software codecs, encodes
// several chunks in parallel - see buildIntraProxyOnce). The retry is the
// conservative version of everything: one encoder, scaling on a canvas.
const ATTEMPTS = [
  { accelerations: ['prefer-hardware', 'no-preference'], fast: true },
  { accelerations: ['prefer-software'], fast: false },
]

async function withSoftwareRetry(run, onProgress) {
  let firstError = null
  for (const attempt of ATTEMPTS) {
    try {
      return await run(attempt)
    } catch (err) {
      // Nothing to do with which codecs were used (e.g. a container this
      // path can't read) - a software retry would only fail the same way.
      if (err?.retryable === false) throw err
      if (!firstError) {
        firstError = err
        console.warn('WebCodecs transcode failed, retrying with software codecs', err)
        onProgress?.(0)
      } else {
        throw new Error(`${describe(firstError)}; software retry: ${describe(err)}`)
      }
    }
  }
  throw firstError
}

// demux() with a message fit for the UI. MP4/MOV and WebM/MKV go through
// here; anything else (AVI, MPEG-TS, ...) is ffmpeg.wasm's job.
async function readContainer(file) {
  try {
    return await demux(file)
  } catch (err) {
    const wrapped = new Error(`couldn't read ${file.name} for WebCodecs (${describe(err)})`)
    wrapped.retryable = false
    throw wrapped
  }
}

// For the UI: which half ran where, e.g. "decode GPU, encode software H.264".
// "GPU" means the browser granted a prefer-hardware config.
function describeCodecs(decodeHardware, encoder) {
  const family = encoder.muxCodec === 'avc' ? 'H.264' : encoder.muxCodec.toUpperCase()
  return `decode ${decodeHardware ? 'GPU' : 'software'}, encode ${encoder.hardware ? 'GPU' : 'software'} ${family}`
}

function describe(err) {
  return err?.message || err?.name || String(err)
}

function estimateFps(samples) {
  if (samples.length < 2) return 30
  const times = samples.map((s) => s.presentationTimeUs).sort((a, b) => a - b)
  const spanUs = times[times.length - 1] - times[0]
  return spanUs > 0 ? Math.min(120, Math.max(1, ((times.length - 1) * 1e6) / spanUs)) : 30
}

// How many frames either codec may have queued before feeding more waits.
// Unbounded queues would decode a whole file's worth of frames (GPU memory,
// quickly) ahead of an encoder that can't keep up.
const MAX_QUEUE = 8

function waitForQueues(decoder, encoder) {
  if (decoder.decodeQueueSize <= MAX_QUEUE && encoder.encodeQueueSize <= MAX_QUEUE) return null
  return new Promise((resolve) => {
    const check = () => {
      if (decoder.decodeQueueSize <= MAX_QUEUE && encoder.encodeQueueSize <= MAX_QUEUE) resolve()
      else setTimeout(check, 2)
    }
    check()
  })
}

// The in-memory MP4 writer every encode here uses. Exported for
// test/webcodecsTranscode.mux.test.mjs, which checks that what this writes
// is what the scrub cache's demuxer reads back.
export function createMp4Muxer(muxCodec, width, height) {
  const target = new ArrayBufferTarget()
  const muxer = new Muxer({
    target,
    video: { codec: muxCodec, width, height },
    // moov up front: mp4box (the scrub cache's demuxer) and players can
    // read it without scanning to the end.
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
  })
  return { muxer, target }
}

// Streams one encoder's output into an MP4 in memory.
function createEncoderPipeline({ config, muxCodec }) {
  const { muxer, target } = createMp4Muxer(muxCodec, config.width, config.height)
  let error = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => {
      error = err
    },
  })
  encoder.configure(config)
  return {
    encoder,
    throwIfFailed() {
      if (error) throw error
    },
    async finish() {
      await encoder.flush()
      if (error) throw error
      encoder.close()
      muxer.finalize()
      return new Blob([target.buffer], { type: 'video/mp4' })
    },
    abort() {
      if (encoder.state !== 'closed') encoder.close()
    },
  }
}

// Decodes samples[start, end) (decode order) of one demuxed track, calling
// onFrame for every output frame in presentation order. onFrame owns the
// frame and must close it. Throttles on both codecs' queues.
async function decodeRange({ decoderConfig, samples, start, end, onFrame, pipeline }) {
  let error = null
  const decoder = new VideoDecoder({
    output: (frame) => {
      if (error) {
        frame.close()
        return
      }
      try {
        onFrame(frame)
      } catch (err) {
        error = err
        frame.close()
      }
    },
    error: (err) => {
      error = err
    },
  })
  decoder.configure(decoderConfig)
  try {
    for (let i = start; i < end; i++) {
      if (error) throw error
      pipeline.throwIfFailed()
      const wait = waitForQueues(decoder, pipeline.encoder)
      if (wait) await wait
      const s = samples[i]
      decoder.decode(
        new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: s.presentationTimeUs,
          duration: s.durationUs,
          data: s.data,
        }),
      )
    }
    await decoder.flush()
    if (error) throw error
  } finally {
    if (decoder.state !== 'closed') decoder.close()
  }
}

// Letterbox: scale to fit inside, black bars. Crop: scale to cover, center
// the overflow. Same treatments as buildFitFilter in resolution.js, but
// using the frame's display size, so non-square-pixel sources keep their
// real shape.
function drawFitted(ctx, frame, width, height, fitMode) {
  const srcW = frame.displayWidth
  const srcH = frame.displayHeight
  const scale = fitMode === 'crop' ? Math.max(width / srcW, height / srcH) : Math.min(width / srcW, height / srcH)
  const drawW = srcW * scale
  const drawH = srcH * scale
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(frame, (width - drawW) / 2, (height - drawH) / 2, drawW, drawH)
}

// All-intra scrub proxy for VideoFrameCache - WebCodecs counterpart of
// transcodeToIntraProxy's ffmpeg command: every frame a keyframe, no
// audio, at most `maxWidth` wide. H.264 where the browser can encode it,
// VP9 otherwise (only our own decoder ever reads this file). Timestamps
// are the source's presentation times, so the proxy's clock matches the
// original's.
export function buildIntraProxy(file, options = {}) {
  return withSoftwareRetry((attempt) => buildIntraProxyOnce(file, { ...options, ...attempt }), options.onProgress)
}

async function buildIntraProxyOnce(file, { maxWidth, onProgress, families = ['avc', 'vp9'], accelerations, fast }) {
  const { track, decodeOrderSamples: samples } = await readContainer(file)
  if (samples.length === 0) throw new Error('no video samples')
  const decoder = await pickDecoderConfig(track, accelerations)

  const scale = Math.min(1, maxWidth / track.video.width)
  const width = even(track.video.width * scale)
  const height = even(track.video.height * scale)
  const fps = estimateFps(samples)
  // Intra-only frames can't borrow from their neighbors, so they need a
  // lot more bits than a normal encode to look the same.
  const encoder = await pickEncoderConfig({ families, width, height, fps, bitrate: width * height * fps * 0.3, accelerations })

  // Every proxy frame is a keyframe, so the source can be cut at its own
  // keyframes into chunks that decode and encode independently, and the
  // results just concatenate. Software codecs are CPU-bound per instance,
  // so on a multi-core machine that's close to a linear speedup (measured
  // 63 -> 100 fps with two chunks on 4 cores). Hardware encoders are left
  // at one: they're already fast, and consumer GPUs cap concurrent
  // encode sessions.
  const parts = fast && !encoder.hardware ? Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2))) : 1
  const segments = splitAtKeyframes(samples, parts)

  let done = 0
  // One per segment, created synchronously in segment order below - so
  // this is also source order, whichever finishes first.
  const encoders = []
  try {
    await Promise.all(
      segments.map(async ([start, end]) => {
        const seg = createChunkCollector(encoder.config)
        encoders.push(seg)
        // Fast path: hand decoded frames straight to the encoder, which
        // scales them to its configured size itself - skips a canvas draw
        // and a VideoFrame-from-canvas copy per frame (measured 54 -> 63
        // fps). The retry draws on a canvas, which every implementation
        // accepts.
        const canvas = fast ? null : new OffscreenCanvas(width, height)
        const ctx = canvas?.getContext('2d')
        await decodeRange({
          decoderConfig: decoder.config,
          samples,
          start,
          end,
          pipeline: seg,
          onFrame: (frame) => {
            if (ctx) {
              ctx.drawImage(frame, 0, 0, width, height)
              const out = new VideoFrame(canvas, { timestamp: frame.timestamp, duration: frame.duration ?? undefined })
              frame.close()
              seg.encoder.encode(out, { keyFrame: true })
              out.close()
            } else {
              seg.encoder.encode(frame, { keyFrame: true })
              frame.close()
            }
            done++
            onProgress?.(done / samples.length)
          },
        })
        await seg.flush()
      }),
    )

    // One MP4 can only carry one decoder config. Parallel encoders given
    // the same config produce the same one in practice; if they ever
    // don't, this attempt fails and the single-encoder retry runs.
    for (const seg of encoders) {
      if (!sameDecoderConfig(seg.decoderConfig, encoders[0].decoderConfig)) {
        throw new Error('parallel encoders produced different decoder configs')
      }
    }
    const { muxer, target } = createMp4Muxer(encoder.muxCodec, width, height)
    for (const seg of encoders) {
      seg.chunks.forEach((chunk, i) => muxer.addVideoChunk(chunk, i === 0 ? { decoderConfig: seg.decoderConfig } : undefined))
    }
    muxer.finalize()
    return {
      blob: new Blob([target.buffer], { type: 'video/mp4' }),
      hardware: decoder.hardware && encoder.hardware,
      codec: encoder.config.codec,
      detail: describeCodecs(decoder.hardware, encoder),
    }
  } catch (err) {
    encoders.forEach((seg) => seg.abort())
    throw err
  }
}

// [start, end) decode-order ranges, each starting on a keyframe, with
// roughly equal sample counts.
function splitAtKeyframes(samples, parts) {
  const target = samples.length / parts
  const bounds = [0]
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].is_sync && i - bounds[bounds.length - 1] >= target && bounds.length < parts) bounds.push(i)
  }
  return bounds.map((start, k) => [start, bounds[k + 1] ?? samples.length])
}

function descriptionBytes(description) {
  if (!description) return null
  return ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description)
}

function sameDecoderConfig(a, b) {
  if (!a || !b) return a === b
  if (a.codec !== b.codec) return false
  const da = descriptionBytes(a.description)
  const db = descriptionBytes(b.description)
  if (!da || !db) return da === db
  return da.length === db.length && da.every((v, i) => v === db[i])
}

// An encoder whose output is kept in memory rather than muxed straight
// away, for the parallel proxy path.
function createChunkCollector(config) {
  const chunks = []
  let decoderConfig = null
  let error = null
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig && !decoderConfig) decoderConfig = meta.decoderConfig
      chunks.push(chunk)
    },
    error: (err) => {
      error = err
    },
  })
  encoder.configure(config)
  return {
    encoder,
    chunks,
    get decoderConfig() {
      return decoderConfig
    },
    throwIfFailed() {
      if (error) throw error
    },
    async flush() {
      await encoder.flush()
      if (error) throw error
      encoder.close()
    },
    abort() {
      if (encoder.state !== 'closed') encoder.close()
    },
  }
}

// Keyframe spacing for export - regular enough for players to seek
// quickly, sparse enough not to cost much size.
const EXPORT_KEYFRAME_INTERVAL_US = 2e6

// Encodes the video track (every clip's [inPoint, outPoint), back to back,
// fitted to width x height) into a video-only MP4. The output clock is
// exact: clip N starts at the sum of the clip lengths before it, and each
// clip's last frame is cut short at its outPoint, so audio built from the
// same clip lengths (see exportSequence) lines up with it.
//
// `families` is the output codec preference - export wants H.264 only;
// tests can ask for VP9 on machines with no H.264 encoder.
export function encodeVideoTrack(clips, options = {}) {
  return withSoftwareRetry((attempt) => encodeVideoTrackOnce(clips, { ...options, ...attempt }), options.onProgress)
}

async function encodeVideoTrackOnce(clips, { width, height, fitMode = 'letterbox', onProgress, families = ['avc'], accelerations }) {
  const demuxed = new Map() // sourceId -> { track, decodeOrderSamples, decoder }
  for (const clip of clips) {
    if (demuxed.has(clip.sourceId)) continue
    const result = await readContainer(clip.file)
    result.decoder = await pickDecoderConfig(result.track, accelerations)
    demuxed.set(clip.sourceId, result)
  }

  const first = demuxed.get(clips[0].sourceId).track.video
  const outWidth = even(width || first.width)
  const outHeight = even(height || first.height)
  const fps = Math.max(...[...demuxed.values()].map((d) => estimateFps(d.decodeOrderSamples)))
  // ~6Mbps at 1080p30: comfortably above what a phone records at, since
  // this is a re-encode of an already-compressed source.
  const encoder = await pickEncoderConfig({
    families,
    width: outWidth,
    height: outHeight,
    fps,
    bitrate: outWidth * outHeight * fps * 0.1,
    accelerations,
  })

  // Which samples each clip needs: from the last keyframe at or before its
  // inPoint (decoding can only start at a keyframe) up to the first
  // keyframe that starts at or after its outPoint.
  const plans = clips.map((clip) => {
    const { decodeOrderSamples: samples } = demuxed.get(clip.sourceId)
    const inUs = clip.inPoint * 1e6
    const outUs = clip.outPoint * 1e6
    let start = 0
    let end = samples.length
    for (let i = 0; i < samples.length; i++) {
      if (!samples[i].is_sync) continue
      if (samples[i].presentationTimeUs <= inUs) start = i
      else if (i > start && samples[i].presentationTimeUs >= outUs) {
        end = i
        break
      }
    }
    // Frames the clip actually keeps (see onFrame below), for progress.
    const frameCount = samples
      .slice(start, end)
      .filter((s) => s.presentationTimeUs + s.durationUs > inUs && s.presentationTimeUs < outUs).length
    return { clip, samples, start, end, inUs, outUs, frameCount }
  })
  const totalFrames = plans.reduce((sum, p) => sum + p.frameCount, 0) || 1

  const canvas = new OffscreenCanvas(outWidth, outHeight)
  const ctx = canvas.getContext('2d')
  const pipeline = createEncoderPipeline(encoder)
  let offsetUs = 0
  let lastKeyUs = -Infinity
  let lastOutUs = -1
  let done = 0

  try {
    for (const plan of plans) {
      const { clip, inUs, outUs } = plan
      const clipOffsetUs = offsetUs
      await decodeRange({
        decoderConfig: demuxed.get(clip.sourceId).decoder.config,
        samples: plan.samples,
        start: plan.start,
        end: plan.end,
        pipeline,
        onFrame: (frame) => {
          const ts = frame.timestamp
          const dur = frame.duration || 1e6 / fps
          // Keep a frame if any of it is on screen within [inUs, outUs):
          // the frame showing at the in point (which usually started just
          // before it) through the last one starting before the out point.
          if (ts + dur <= inUs || ts >= outUs) {
            frame.close()
            return
          }
          const outTs = Math.round(clipOffsetUs + Math.max(0, ts - inUs))
          // Two source frames can collapse onto one output timestamp (the
          // pre-in-point frame and one exactly at it); muxers need them
          // strictly increasing.
          if (outTs <= lastOutUs) {
            frame.close()
            return
          }
          const outDur = Math.max(1, Math.round(Math.min(ts + dur, outUs) - Math.max(ts, inUs)))
          let out
          if (frame.displayWidth === outWidth && frame.displayHeight === outHeight) {
            // Already the output size (the usual case: project resolution
            // defaults to the first clip's) - re-stamp it and skip the
            // canvas draw and copy.
            out = new VideoFrame(frame, { timestamp: outTs, duration: outDur })
          } else {
            drawFitted(ctx, frame, outWidth, outHeight, fitMode)
            out = new VideoFrame(canvas, { timestamp: outTs, duration: outDur })
          }
          frame.close()
          const keyFrame = outTs - lastKeyUs >= EXPORT_KEYFRAME_INTERVAL_US
          if (keyFrame) lastKeyUs = outTs
          pipeline.encoder.encode(out, { keyFrame })
          out.close()
          lastOutUs = outTs
          done++
          onProgress?.(Math.min(1, done / totalFrames))
        },
      })
      offsetUs += clipLength(clip) * 1e6
    }
    const blob = await pipeline.finish()
    return {
      blob,
      hardware: encoder.hardware && [...demuxed.values()].every((d) => d.decoder.hardware),
      codec: encoder.config.codec,
      detail: describeCodecs([...demuxed.values()].every((d) => d.decoder.hardware), encoder),
    }
  } catch (err) {
    pipeline.abort()
    throw err
  }
}
