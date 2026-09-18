import { useEffect, useRef, useState } from 'react'
import { usePlayerMarks } from '../hooks/usePlayerMarks'
import { formatTimecode } from './formatTimecode'
import { VideoFrameCache, isFrameCacheSupported } from '../lib/videoFrameCache'

// Nominal REW rate, matching FF's native 4x playbackRate.
const REWIND_RATE = 4

// How often the canvas render loops (REW, and forward playback/FF) are
// allowed to push a new currentTime into React state. <video>'s own
// 'timeupdate' event - what drives the clock the rest of the time - is
// already throttled by the browser to a few times a second; calling
// marks.setCurrentTime on every single drawn frame instead (up to 60Hz for
// REW, and yet more callbacks in real time for FF) means a full re-render of
// the deck (clock text, IN/OUT lights, etc.) on the same thread that's also
// decoding/drawing that frame, which is what made REW/jog feel sluggish and
// FF stutter once playback moved onto this canvas path. The frame drawing
// itself is untouched - only how often the *visible clock text* refreshes.
const CLOCK_UPDATE_INTERVAL_MS = 66

// VideoFrameCache's own default window radius (see WINDOW_RADIUS_GOPS in
// videoFrameCache.js) is deliberately small - 1 - because a GOP in the
// camera-original file can run into the hundreds of frames, and each one
// costs real decoded-frame memory. Once the source has been transcoded to
// an all-intra proxy (see the ffmpeg-backed effect below), a "GOP" is a
// single frame, so the same memory budget buys a much wider retained
// window: 15 either side of 1080p is ~90MB, comfortably under
// PREFETCH_BYTE_BUDGET, and gives REW/jog a deep enough buffer that
// stepping around the current position rarely triggers a fresh decode.
const PROXY_WINDOW_RADIUS_FRAMES = 15

// The canvas is only ever displayed at a fixed 480x270 CSS box
// (classic.css), regardless of source resolution - so drawing a source
// frame onto it at full native resolution (REW/jog's frame-cache fallback
// when no proxy exists, and every forward-canvas frame, which always draws
// straight from <video> rather than the proxy - see startForwardCanvas)
// is pure waste. Worse than waste for FF: that extra full-resolution
// drawImage competes for the same thread <video>'s own decode needs to
// sustain 4x, which is what turns "normal, then jumps to catch up" into a
// visible pattern rather than an occasional dropped frame. Capped the same
// way the REW proxy is (PROXY_MAX_WIDTH in useFFmpeg.js).
const CANVAS_MAX_WIDTH = 960

// Sizes canvas's backing buffer to fit sourceWidth/sourceHeight within
// CANVAS_MAX_WIDTH, preserving aspect ratio and never upscaling - a no-op
// once already sized right, so cheap to call on every drawn frame. Returns
// false when there's nothing to draw yet (source has no known size).
function fitCanvasToSource(canvas, sourceWidth, sourceHeight) {
  if (!sourceWidth || !sourceHeight) return false
  const scale = Math.min(1, CANVAS_MAX_WIDTH / sourceWidth)
  const width = Math.round(sourceWidth * scale)
  const height = Math.round(sourceHeight * scale)
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  return true
}

// Paints whatever <video> currently has decoded onto the canvas, best-
// effort - used to avoid a flash of the canvas's own black background at
// the instant it's swapped in for REW or forward playback. video.videoWidth
// is set as soon as metadata loads, well before any frame is actually
// decoded, so readyState also has to clear HAVE_CURRENT_DATA or drawImage
// throws InvalidStateError; wrapped in try/catch too since that guard is
// necessarily racy against a video that's mid-seek (e.g. currentTime was
// just set moments earlier) - either way, a missed pre-draw here just means
// the first real decoded frame is what appears a tick later, not a crash
// that silently skips the v.play() call after it.
function paintCurrentVideoFrame(video, canvas, ctx) {
  if (!video || !canvas || !ctx || !video.videoWidth || video.readyState < video.HAVE_CURRENT_DATA) return
  try {
    if (!fitCanvasToSource(canvas, video.videoWidth, video.videoHeight)) return
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  } catch {
    // Best-effort - see comment above.
  }
}

// Formats the scrub-proxy stat line ("File transcoded — 3.2s for 0.1 minute
// video") - whole seconds once the wait is long enough that a decimal is
// just noise, one decimal place below that so a short clip doesn't round to
// a misleading "0s".
function formatScrubPrepSeconds(seconds) {
  return seconds >= 10 ? `${Math.round(seconds)}` : seconds.toFixed(1)
}

function formatMinutes(seconds) {
  return (seconds / 60).toFixed(1)
}

// Maps each shortcut key to the switch it should visually "press" while
// held, so keyboard use gets the same :active feedback as a mouse click.
const KEY_ACTIONS = {
  ' ': 'play',
  k: 'still',
  j: 'rewind',
  l: 'fastForward',
  i: 'markIn',
  o: 'markOut',
  ',': 'jogLeft',
  '.': 'jogRight',
}

// Display label for each action's badge, shown over its button when key
// hints are toggled on.
const ACTION_KEY_LABELS = {
  play: 'SPACE',
  still: 'K',
  rewind: 'J',
  fastForward: 'L',
  markIn: 'I',
  markOut: 'O',
  jogLeft: '<',
  jogRight: '>',
}

export default function ClassicPlayerDeck({ source, onLoad, onEject, onAddClip, ffmpeg }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const marks = usePlayerMarks(videoRef, source)
  const rewindTimer = useRef(null)
  const rewindRaf = useRef(null)
  const forwardRvfc = useRef(null)
  const frameCacheRef = useRef(null)
  const [isPreparingScrub, setIsPreparingScrub] = useState(false)
  const [scrubPrepProgress, setScrubPrepProgress] = useState(0)
  // Set once the proxy transcode finishes ({ seconds, sourceDuration }),
  // so users can see roughly what the "Preparing fast scrub…" wait cost
  // them - cleared on the next source load, alongside the other state above.
  const [scrubPrepStats, setScrubPrepStats] = useState(null)
  // ffmpeg is a fresh object identity from useFFmpeg() on every render of
  // App - reading it through a ref (kept fresh every render, like marksRef
  // below) rather than depending on it directly keeps the cache-build
  // effect from re-running, and re-transcoding, on every unrelated re-render.
  const ffmpegRef = useRef(ffmpeg)
  ffmpegRef.current = ffmpeg
  const scrubTimeRef = useRef(0)
  const lastDrawnTimeRef = useRef(0)
  // Bumped at the start of every transport action (play/still/fastForward/
  // rewind/jog). jog()'s async cleanup (see below) captures this value and
  // checks it's still current before touching isCanvasActive, so a jog
  // whose <video> catch-up 'seeked' event fires late - after some other
  // transport action has already taken over - can't clobber that later
  // action's canvas state.
  const transportGeneration = useRef(0)
  const [isCanvasActive, setIsCanvasActive] = useState(false)
  // Wall-clock time of the last marks.setCurrentTime call made from a canvas
  // render loop - see CLOCK_UPDATE_INTERVAL_MS/updateClock below.
  const lastClockUpdateRef = useRef(0)

  // Pushes `time` into the clock/marks state, throttled to
  // CLOCK_UPDATE_INTERVAL_MS unless `force` is set (used for the last frame
  // of a run, so the displayed clock always lands exactly where the run
  // actually stopped rather than up to one throttle interval short).
  function updateClock(time, force = false) {
    const now = performance.now()
    if (!force && now - lastClockUpdateRef.current < CLOCK_UPDATE_INTERVAL_MS) return
    lastClockUpdateRef.current = now
    marks.setCurrentTime(time)
  }

  // Builds the WebCodecs frame cache (see src/lib/videoFrameCache.js) as
  // soon as the source loads, so rewind()/play()/fastForward() have a
  // ready frame cache to render from instead of the <video> element's own
  // decode. Anything that fails here (unsupported browser, non-MP4/MOV
  // container, unsupported codec) just leaves frameCacheRef.current null,
  // and every transport falls back to driving <video> directly, as before
  // this cache existed.
  //
  // Before demuxing, tries to transcode the source to an all-intra proxy
  // (see transcodeToIntraProxy in useFFmpeg.js) and build the cache from
  // that instead of the camera-original file - every output frame is its
  // own GOP, which is what actually fixes REW/jog's GOP-decode latency
  // rather than just working around it (see "Transcode footage on load" in
  // TECHDEBT.md). If ffmpeg can't run at all, or the transcode itself
  // fails, this falls through to demuxing the original file exactly as
  // before the proxy existed - the proxy is a strict enhancement, never a
  // requirement.
  useEffect(() => {
    // The <video> element itself remounts on source change (it's keyed by
    // source?.id), but this component doesn't - so the "cancel everything
    // on unmount" effect below never fires here, and without this, an
    // active REW/PLAY/FF/jog loop from the previous source would keep
    // running (its scheduling refs untouched) right through an EJECT or a
    // new LOAD. Bumping the generation is what actually matters: it makes
    // any in-flight step()/onFrame() call (mid-await on a decode from the
    // frame cache that's about to be closed below) a safe no-op instead of
    // it running to completion against a source that no longer applies -
    // same protection as every other transport action gets, just triggered
    // by a prop change instead of a button press. The cancel calls below
    // are best-effort on top of that (harmless if they end up targeting a
    // freshly-remounted <video> rather than the one that scheduled them).
    transportGeneration.current++
    clearInterval(rewindTimer.current)
    cancelAnimationFrame(rewindRaf.current)
    rewindRaf.current = null
    if (forwardRvfc.current != null) {
      videoRef.current?.cancelVideoFrameCallback?.(forwardRvfc.current)
      forwardRvfc.current = null
    }
    setIsCanvasActive(false)

    let cancelled = false
    frameCacheRef.current?.close()
    frameCacheRef.current = null
    setIsPreparingScrub(false)
    setScrubPrepProgress(0)
    setScrubPrepStats(null)

    async function buildCache() {
      if (!source?.file || !isFrameCacheSupported()) return

      let proxyFile = null
      const ffmpegApi = ffmpegRef.current
      if (ffmpegApi && !ffmpegApi.error) {
        setIsPreparingScrub(true)
        const startedAt = performance.now()
        try {
          proxyFile = await ffmpegApi.transcodeToIntraProxy(source.file, {
            onProgress: (p) => {
              if (!cancelled) setScrubPrepProgress(p)
            },
          })
          if (!cancelled) {
            setScrubPrepStats({ seconds: (performance.now() - startedAt) / 1000, sourceDuration: source.duration })
          }
        } catch (err) {
          console.warn('Intra-frame scrub proxy failed, REW/jog will use the source GOPs', err)
        } finally {
          if (!cancelled) setIsPreparingScrub(false)
        }
        if (cancelled) return
      }

      const cache = proxyFile
        ? new VideoFrameCache(proxyFile, { windowRadiusGops: PROXY_WINDOW_RADIUS_FRAMES })
        : new VideoFrameCache(source.file)

      try {
        await cache.init()
      } catch (err) {
        console.warn('WebCodecs frame cache unavailable, REW will reseek instead', err)
        return
      }
      if (cancelled) {
        cache.close()
        return
      }
      frameCacheRef.current = cache
    }

    buildCache()

    return () => {
      cancelled = true
      frameCacheRef.current?.close()
      frameCacheRef.current = null
    }
  }, [source?.id, source?.file])

  // markIn/markOut close over inPoint/outPoint state, so the keydown
  // listener below (mounted once) reads them through a ref that's kept
  // fresh every render, rather than depending on `marks` directly - marks
  // itself changes on every currentTime tick during playback, which would
  // otherwise thrash the listener many times a second.
  const marksRef = useRef(marks)
  marksRef.current = marks

  const [pressedActions, setPressedActions] = useState(() => new Set())
  const [showKeyHints, setShowKeyHints] = useState(false)

  function keyClass(action) {
    return pressedActions.has(action) ? ' key-active' : ''
  }

  function keyHint(action) {
    if (!showKeyHints) return null
    return <span className="key-hint">{ACTION_KEY_LABELS[action]}</span>
  }

  useEffect(
    () => () => {
      clearInterval(rewindTimer.current)
      cancelAnimationFrame(rewindRaf.current)
      if (forwardRvfc.current != null) videoRef.current?.cancelVideoFrameCallback?.(forwardRvfc.current)
    },
    [],
  )

  // Ends a canvas-driven scrub in progress (if any), syncing the <video>
  // element to wherever the scrub left off before handing control back to
  // it. Called at the top of every other transport action so switching
  // straight from REW to PLAY/FF/STILL/JOG doesn't leave the canvas
  // showing a stale frame. Syncs to lastDrawnTimeRef (the actual frame last
  // drawn), not scrubTimeRef (the idealized continuous scrub position - see
  // startCanvasRewind), so the video resumes from exactly what was on
  // screen rather than a slightly later moment mid-frame.
  function stopCanvasRewind() {
    if (rewindRaf.current == null) return
    cancelAnimationFrame(rewindRaf.current)
    rewindRaf.current = null
    setIsCanvasActive(false)
    const v = videoRef.current
    if (v) v.currentTime = lastDrawnTimeRef.current
  }

  // Ends the forward-playback render loop (see startForwardCanvas) started
  // by play()/fastForward(). No need to touch video.currentTime here the
  // way stopCanvasRewind does - <video> was never paused or frozen while
  // canvas was drawing over it, it was actively playing the whole time, so
  // whatever it's showing once we stop covering it is already correct.
  function stopForwardCanvas() {
    if (forwardRvfc.current == null) return
    videoRef.current?.cancelVideoFrameCallback?.(forwardRvfc.current)
    forwardRvfc.current = null
    setIsCanvasActive(false)
  }

  // Keeps the overlay canvas as the single display surface during forward
  // playback (PLAY/FF), mirroring each frame <video> presents onto it via
  // requestVideoFrameCallback.
  //
  // This deliberately does NOT pull frames from the WebCodecs cache the way
  // REW does, and that's the whole point: for forward playback <video> has
  // already decoded exactly the right frame, on the browser's own hardware-
  // timed schedule, by the time rVFC hands us metadata.mediaTime for it.
  // Decoding it a second time ourselves can at best match that and in
  // practice loses to it - the earlier version awaited
  // cache.getFrameAtOrBefore() here and only re-registered the next
  // callback afterwards, so every frame <video> presented during that await
  // never got a callback at all and was silently skipped. Measured at 50ms
  // decode latency against a 25fps source (40ms/frame), that dropped 11 of
  // 24 frames and spread the survivors over 51-100ms gaps instead of a
  // steady 40 - visible as jitter. It also meant decoding every frame twice
  // (once natively for <video>, once for us), which is real CPU on 1080p
  // and can make the native playback itself hitch.
  //
  // So: re-register synchronously, draw synchronously, source the pixels
  // from the element that already has them. Canvas still owns the display
  // (no video/canvas swapping mid-transport, which is what the decoupling
  // was for), and the frame cache still earns its keep on REW and jog,
  // where <video> genuinely can't help.
  function startForwardCanvas() {
    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!video || !canvas || !ctx || typeof video.requestVideoFrameCallback !== 'function') return

    // Paint what <video> is showing before swapping the canvas in, same as
    // startCanvasRewind - no flash of the canvas's black background.
    paintCurrentVideoFrame(video, canvas, ctx)
    setIsCanvasActive(true)
    // Reset so this run's first clock update lands immediately rather than
    // being throttled against whatever the previous run's last update was.
    lastClockUpdateRef.current = 0
    // See the matching comment in startCanvasRewind for why this is a
    // shared, always-current counter rather than a check against
    // forwardRvfc.current alone: that ref being reassigned (a newer
    // startForwardCanvas/startCanvasRewind call replacing it) reads as
    // "still active" just as easily as it being null does.
    const myGeneration = transportGeneration.current

    function onFrame(now, metadata) {
      if (transportGeneration.current !== myGeneration) return

      // Re-register first and synchronously. Nothing between the callback
      // firing and this line can let a presented frame slip past
      // unrendered - which is exactly what awaiting before this allowed.
      const stillRunning = !video.paused && !video.ended
      if (stillRunning) forwardRvfc.current = video.requestVideoFrameCallback(onFrame)

      if (fitCanvasToSource(canvas, video.videoWidth, video.videoHeight)) {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        } catch {
          // Not drawable this instant - keep the previous frame up rather
          // than blanking the canvas for one tick.
        }
      }
      lastDrawnTimeRef.current = metadata.mediaTime
      // Force the final update so the clock lands exactly on the last
      // presented frame instead of up to CLOCK_UPDATE_INTERVAL_MS short.
      updateClock(metadata.mediaTime, !stillRunning)

      if (!stillRunning) {
        // Playback stopped on its own (ran off the end) rather than via
        // still()/rewind() - hand back to <video>'s own display.
        stopForwardCanvas()
      }
    }

    forwardRvfc.current = video.requestVideoFrameCallback(onFrame)
  }

  function play() {
    transportGeneration.current++
    clearInterval(rewindTimer.current)
    stopCanvasRewind()
    stopForwardCanvas()
    const v = videoRef.current
    if (!v) return
    v.playbackRate = 1
    // Gated on the frame cache existing even though forward rendering no
    // longer reads from it: that's the signal REW will also be canvas-based
    // this session, so the display surface stays consistent across
    // transports. Without a cache, REW falls back to reseeking <video>
    // directly and <video> stays the visible element throughout.
    if (frameCacheRef.current) startForwardCanvas()
    // play() returns a promise that rejects with AbortError if the play
    // request gets interrupted (e.g. a pause()/another play() call lands
    // before it resolves - REW does exactly that). Expected and harmless,
    // but needs a catch or it surfaces as an unhandled rejection.
    v.play().catch(() => {})
  }

  function still() {
    transportGeneration.current++
    clearInterval(rewindTimer.current)
    stopCanvasRewind()
    stopForwardCanvas()
    videoRef.current?.pause()
  }

  function fastForward() {
    transportGeneration.current++
    clearInterval(rewindTimer.current)
    stopCanvasRewind()
    stopForwardCanvas()
    const v = videoRef.current
    if (!v) return
    v.playbackRate = 4
    if (frameCacheRef.current) startForwardCanvas() // see the note in play()
    v.play().catch(() => {})
  }

  // Walks the WebCodecs frame cache backward, drawing each frame to the
  // overlay canvas instead of touching video.currentTime - see
  // src/lib/videoFrameCache.js and the "Player deck REW runs slower than
  // FF" entry in TECHDEBT.md for why avoiding <video> seeks is the point.
  // Steps by actual elapsed wall-clock time (rather than assuming a fixed
  // tick length) so the rate holds even if a frame decode takes a tick or
  // two longer than usual.
  function startCanvasRewind(cache, startTime) {
    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    scrubTimeRef.current = startTime

    // Paint the frame the <video> is already showing (it's already paused
    // at startTime by rewind()) before swapping the canvas in, so there's
    // no flash of the canvas's own black background while the first cache
    // decode is still in flight.
    paintCurrentVideoFrame(video, canvas, ctx)
    lastDrawnTimeRef.current = startTime
    setIsCanvasActive(true)
    // Reset so this run's first clock update lands immediately rather than
    // being throttled against whatever the previous run's last update was.
    lastClockUpdateRef.current = 0
    let lastTs = performance.now()
    // Captured now, checked after every await below - NOT a local `stopped`
    // flag, because stopCanvasRewind() (called from play()/still()/etc, all
    // of which bump transportGeneration first) can only cancel the *next*
    // scheduled tick. It can't reach into a step() call that's already
    // mid-await on a frame decode, so a purely local flag never gets set in
    // time: that in-flight call finishes unaware anything changed and
    // reschedules itself via requestAnimationFrame(step), leaving REW
    // silently still running - and eventually calling stopCanvasRewind()
    // itself once its own countdown reaches 0, yanking video.currentTime
    // backward - well after PLAY/FF/STILL/another REW has taken over. This
    // is the "rewind still happening after pressing play" bug: checking the
    // shared, always-current counter instead catches that case.
    const myGeneration = transportGeneration.current

    async function step(now) {
      if (transportGeneration.current !== myGeneration) return
      const elapsed = (now - lastTs) / 1000
      lastTs = now
      const time = Math.max(0, scrubTimeRef.current - elapsed * REWIND_RATE)
      scrubTimeRef.current = time

      let frame
      try {
        frame = await cache.getFrameAtOrBefore(time)
      } catch (err) {
        if (transportGeneration.current !== myGeneration) return // superseded while decoding
        // Decode failed mid-scrub (corrupt sample, decoder hiccup) - fall
        // back to the reseek-based loop from wherever we got to rather than
        // freezing on a dead scrub.
        console.warn('Frame cache decode failed mid-scrub, falling back to reseeking', err)
        stopCanvasRewind()
        startReseekRewind()
        return
      }
      if (transportGeneration.current !== myGeneration) return // superseded while decoding

      if (!frame) {
        // The cache resolved but had nothing to give. Anything that gets us
        // here is not going to fix itself on the next tick, and continuing
        // would just leave REW visibly frozen on the last drawn frame -
        // hand over to the reseek loop, which needs nothing from the cache.
        console.warn('Frame cache returned no frame for REW, falling back to reseeking')
        stopCanvasRewind()
        startReseekRewind()
        return
      }

      if (ctx && fitCanvasToSource(canvas, frame.displayWidth, frame.displayHeight)) {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
        // Track the actual frame drawn, not the idealized continuous
        // `time` above - getFrameAtOrBefore returns the nearest frame AT
        // OR BEFORE that time, so the two can differ by up to one frame's
        // duration. The clock (and the eventual <video> sync in
        // stopCanvasRewind) should reflect what's actually on screen.
        lastDrawnTimeRef.current = frame.timestamp / 1e6
      }

      // Force the final update so the clock lands exactly where REW
      // stopped instead of up to CLOCK_UPDATE_INTERVAL_MS short.
      updateClock(lastDrawnTimeRef.current, time <= 0)
      if (time <= 0) {
        stopCanvasRewind()
        return
      }
      rewindRaf.current = requestAnimationFrame(step)
    }

    rewindRaf.current = requestAnimationFrame(step)
  }

  // Original REW implementation, kept as the fallback for browsers/sources
  // the WebCodecs frame cache can't handle (see isFrameCacheSupported() and
  // VideoFrameCache.init() in src/lib/videoFrameCache.js).
  function startReseekRewind() {
    const v = videoRef.current
    if (!v) return
    v.pause()
    // HTML5 video can't play backwards, so REW is emulated by stepping
    // currentTime back on a short interval — the same trick the original
    // PlayerMonitor used for its reverse() transport. Skipping a tick
    // while the video is still mid-seek (v.seeking) matters on a real,
    // longer video: a single seek can take longer than this interval, and
    // firing the next one before the last one resolves piles up seek
    // requests faster than the browser can process them - which reads as
    // the player freezing.
    rewindTimer.current = setInterval(() => {
      if (v.seeking) return
      v.currentTime = Math.max(0, v.currentTime - 0.08)
      if (v.currentTime <= 0) clearInterval(rewindTimer.current)
    }, 20)
  }

  function rewind() {
    transportGeneration.current++
    clearInterval(rewindTimer.current)
    stopCanvasRewind()
    stopForwardCanvas()
    const v = videoRef.current
    if (!v) return
    v.pause()

    const cache = frameCacheRef.current
    if (cache) {
      startCanvasRewind(cache, v.currentTime)
    } else {
      startReseekRewind()
    }
  }

  // Single-frame nudge. Reads from the WebCodecs frame cache (same one REW
  // and forward playback use) rather than reseeking <video> directly, so a
  // jog into an already-prefetched neighboring GOP (see WINDOW_RADIUS_GOPS
  // in videoFrameCache.js) draws instantly instead of paying <video>'s own
  // seek latency - which matters most when jogging repeatedly, since each
  // press would otherwise be an independent reseek.
  async function jog(direction) {
    still() // bumps transportGeneration, stops any active REW/forward loop
    const myGeneration = transportGeneration.current
    const v = videoRef.current
    if (!v) return

    const cache = frameCacheRef.current
    if (!cache) {
      // No sample table to consult, so fall back to nudging the clock by an
      // assumed frame duration. Inexact on anything that isn't ~30fps, but
      // <video> has nothing better to offer here.
      const target = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + direction / 30))
      v.currentTime = target
      return
    }

    // Ask the sample table which frame is actually adjacent rather than
    // assuming a frame duration - see nextFrameTimeSeconds() in
    // videoFrameCache.js for why guessing gets this wrong at every frame
    // rate except exactly 30fps.
    const from = v.currentTime
    const target =
      direction > 0 ? cache.nextFrameTimeSeconds(from) : cache.previousFrameTimeSeconds(from)
    // Already sitting on the first or last frame - nothing to step to.
    if (target == null) return

    try {
      const frame = await cache.getFrameAtOrBefore(target)
      if (transportGeneration.current !== myGeneration) return // superseded mid-decode
      if (!frame) {
        v.currentTime = target
        return
      }
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (canvas && ctx && fitCanvasToSource(canvas, frame.displayWidth, frame.displayHeight)) {
        ctx.drawImage(frame, 0, 0, canvas.width, canvas.height)
        setIsCanvasActive(true)
      }
      const shownTime = frame.timestamp / 1e6
      lastDrawnTimeRef.current = shownTime
      marks.setCurrentTime(shownTime)
      v.currentTime = shownTime
      // The canvas draw above is instant; <video>'s own seek to the same
      // position is not. Once it catches up, hand back to showing <video>
      // directly rather than leaving the canvas up indefinitely - but only
      // if nothing else (another jog, PLAY, FF, REW) has taken over since.
      v.addEventListener(
        'seeked',
        () => {
          if (transportGeneration.current === myGeneration) setIsCanvasActive(false)
        },
        { once: true },
      )
    } catch (err) {
      console.warn('Frame cache decode failed for jog, reseeking directly', err)
      if (transportGeneration.current === myGeneration) v.currentTime = target
    }
  }

  function addToTimeline() {
    if (!source || marks.outPoint <= marks.inPoint) return
    onAddClip({
      sourceId: source.id,
      sourceName: source.name,
      file: source.file,
      url: source.url,
      duration: source.duration,
      inPoint: marks.inPoint,
      outPoint: marks.outPoint,
    })
  }

  // JKL-style transport shortcuts, mirroring the deck's own buttons - held
  // keys also flip the matching switch into its :active look (see
  // key-active in classic.css) so keyboard use gets the same press
  // feedback as a click. Skipped while focus is in a form control (e.g.
  // the resolution panel's selects/radios) so native typing/selection
  // isn't hijacked.
  useEffect(() => {
    function isTypingTarget(el) {
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable
    }

    function runAction(action) {
      switch (action) {
        case 'play':
          play()
          break
        case 'still':
          still()
          break
        case 'rewind':
          rewind()
          break
        case 'fastForward':
          fastForward()
          break
        case 'markIn':
          marksRef.current.markIn()
          break
        case 'markOut':
          marksRef.current.markOut()
          break
        case 'jogLeft':
          jog(-1)
          break
        case 'jogRight':
          jog(1)
          break
        default:
          break
      }
    }

    function handleKeyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(document.activeElement)) return
      const action = KEY_ACTIONS[e.key.toLowerCase()]
      if (!action) return
      e.preventDefault()
      setPressedActions((prev) => (prev.has(action) ? prev : new Set(prev).add(action)))
      // Key repeat re-fires keydown without a keyup in between - only run
      // the action on the initial press, not every repeat tick.
      if (!e.repeat) runAction(action)
    }

    function handleKeyUp(e) {
      const action = KEY_ACTIONS[e.key.toLowerCase()]
      if (!action) return
      setPressedActions((prev) => {
        if (!prev.has(action)) return prev
        const next = new Set(prev)
        next.delete(action)
        return next
      })
    }

    // Alt-tabbing away (or anything else that eats the keyup) shouldn't
    // leave a switch stuck looking pressed.
    function handleBlur() {
      setPressedActions((prev) => (prev.size === 0 ? prev : new Set()))
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('blur', handleBlur)
    }
    // play/still/rewind/fastForward/jog close only over stable refs, so a
    // mount-once listener behaves the same as one rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div id="player">
      <p>PLAYER</p>
      <div className="row right-justify">
        <b className={marks.inPoint > 0 ? 'light lock' : 'light'}>IN</b>
        <b className={marks.outPoint < (source?.duration ?? 0) ? 'light lock' : 'light'}>OUT</b>
      </div>
      <div className="clock">{formatTimecode(marks.currentTime)}</div>
      {isPreparingScrub && (
        <>
          <p className="scrub-status">Preparing fast scrub…</p>
          <div className="scrub-progress-track">
            <div className="scrub-progress-fill" style={{ width: `${Math.round(scrubPrepProgress * 100)}%` }} />
          </div>
        </>
      )}
      {!isPreparingScrub && scrubPrepStats && (
        <p className="scrub-status">
          File transcoded — {formatScrubPrepSeconds(scrubPrepStats.seconds)}s for{' '}
          {formatMinutes(scrubPrepStats.sourceDuration)} minute video
        </p>
      )}

      <div className="player-frame">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          key={source?.id ?? 'empty'}
          ref={videoRef}
          src={source?.url}
          onLoadedMetadata={marks.resetMarks}
          onTimeUpdate={(e) => marks.setCurrentTime(e.currentTarget.currentTime)}
        />
        {/* Shown whenever the WebCodecs frame cache is driving the display -
            REW (startCanvasRewind) or forward playback (startForwardCanvas)
            - covering the <video> element underneath, which keeps playing/
            decoding normally (and is what actually produces audio) but
            isn't what's on screen while this is up. */}
        <canvas ref={canvasRef} style={{ display: isCanvasActive ? 'block' : 'none' }} />
      </div>

      <div className="load-eject-row">
        <button
          type="button"
          onClick={() => setShowKeyHints((v) => !v)}
          className={`key-help-button${showKeyHints ? ' active' : ''}`}
          aria-pressed={showKeyHints}
          aria-label="Show keyboard shortcuts"
          title="Show keyboard shortcuts"
        >
          ?
        </button>
        <div className="center-div">
          <div className="row">
            <b onClick={onLoad} className="switch blue-button">LOAD</b>
            <b onClick={onEject} className="switch blue-button">EJECT</b>
          </div>
        </div>
      </div>
      <br />
      <div className="center-div">
        <div className="row">
          <b onClick={play} className={`switch${keyClass('play')}`}>
            PLAY
            {keyHint('play')}
          </b>
          <b onClick={rewind} className={`switch${keyClass('rewind')}`}>
            REW
            {keyHint('rewind')}
          </b>
          <b onClick={still} className={`switch${keyClass('still')}`}>
            STILL
            {keyHint('still')}
          </b>
          <b onClick={fastForward} className={`switch${keyClass('fastForward')}`}>
            FF
            {keyHint('fastForward')}
          </b>
        </div>
      </div>
      <br />
      <div className="center-div">
        <div className="row">
          <b onClick={marks.markIn} className={`switch grey-button${keyClass('markIn')}`}>
            MARK IN
            {keyHint('markIn')}
          </b>
          <b onClick={marks.markOut} className={`switch grey-button${keyClass('markOut')}`}>
            MARK OUT
            {keyHint('markOut')}
          </b>
        </div>
      </div>
      <br />
      <div id="jogger" className="center-div">
        <div className="center-div">
          <b className="light">JOG</b>
        </div>
        <div className="row">
          <b onClick={() => jog(-1)} className={`switch${keyClass('jogLeft')}`}>
            {'<'}
            {keyHint('jogLeft')}
          </b>
          <b onClick={() => jog(1)} className={`switch${keyClass('jogRight')}`}>
            {'>'}
            {keyHint('jogRight')}
          </b>
        </div>
      </div>
      <br />
      <div className="center-div">
        <div className="row">
          <b
            onClick={addToTimeline}
            className="switch switch-big red-button"
            style={{ opacity: source && marks.outPoint > marks.inPoint ? 1 : 0.4 }}
          >
            ADD TO TIMELINE
          </b>
        </div>
      </div>
    </div>
  )
}
