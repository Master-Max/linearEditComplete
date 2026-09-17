import { useEffect, useRef, useState } from 'react'
import { usePlayerMarks } from '../hooks/usePlayerMarks'
import { formatTimecode } from './formatTimecode'
import { VideoFrameCache, isFrameCacheSupported } from '../lib/videoFrameCache'

// Nominal REW rate, matching FF's native 4x playbackRate.
const REWIND_RATE = 4

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
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)
  } catch {
    // Best-effort - see comment above.
  }
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

export default function ClassicPlayerDeck({ source, onLoad, onEject, onAddClip }) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const marks = usePlayerMarks(videoRef, source)
  const rewindTimer = useRef(null)
  const rewindRaf = useRef(null)
  const forwardRvfc = useRef(null)
  const frameCacheRef = useRef(null)
  const scrubTimeRef = useRef(0)
  const lastDrawnTimeRef = useRef(0)
  const [isCanvasActive, setIsCanvasActive] = useState(false)

  // Demux+decode the source with WebCodecs (see src/lib/videoFrameCache.js)
  // as soon as it loads, so rewind()/play()/fastForward() have a ready
  // frame cache to render from instead of the <video> element's own
  // decode. Anything that fails here (unsupported browser, non-MP4/MOV
  // container, unsupported codec) just leaves frameCacheRef.current null,
  // and every transport falls back to driving <video> directly, as before
  // this cache existed.
  useEffect(() => {
    let cancelled = false
    frameCacheRef.current?.close()
    frameCacheRef.current = null

    if (source?.file && isFrameCacheSupported()) {
      const cache = new VideoFrameCache(source.file)
      cache
        .init()
        .then(() => {
          if (cancelled) {
            cache.close()
            return
          }
          frameCacheRef.current = cache
        })
        .catch((err) => {
          console.warn('WebCodecs frame cache unavailable, REW will reseek instead', err)
        })
    }

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

  // Drives the overlay canvas from the WebCodecs frame cache during normal
  // forward playback (PLAY/FF), instead of letting <video>'s own decoded
  // frames be what's on screen - see the "WebCodecs-based scrub/rewind"
  // entry in ROADMAP.md. <video> keeps playing completely normally
  // underneath (same play()/playbackRate calls as always) and is still
  // what actually produces audio and drives the playback clock; only the
  // pixels shown come from our own decode instead of the browser's. Reading
  // metadata.mediaTime from requestVideoFrameCallback - the exact
  // presentation time of the frame <video> itself just displayed - is what
  // keeps the two in lockstep without needing any separate audio/timing
  // engine: video's own audio is already synced to that timeline, we're
  // just asking "what should be on screen at the instant video reached
  // this point" and drawing our own answer over it.
  //
  // Known rough edge: getFrameAtOrBefore decodes a whole GOP synchronously
  // the first time playback crosses into one it hasn't cached yet (see
  // VideoFrameCache._decodeGop), so there's a real chance of a brief stall
  // right at each GOP boundary rather than a perfectly smooth scan through
  // long forward playback - worth specifically watching for during testing,
  // especially at FF's 4x rate where boundaries come up more often per
  // second of wall-clock time. A prefetch-the-next-GOP-ahead-of-time step
  // would be the fix if that shows up as a real problem.
  function startForwardCanvas(cache) {
    const video = videoRef.current
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!video || !canvas || !ctx || typeof video.requestVideoFrameCallback !== 'function') return

    // Paint the frame <video> is already showing before swapping the canvas
    // in, same as startCanvasRewind - no flash of the canvas's black
    // background while the cache decodes the first frame.
    paintCurrentVideoFrame(video, canvas, ctx)
    setIsCanvasActive(true)

    async function onFrame(now, metadata) {
      try {
        const frame = await cache.getFrameAtOrBefore(metadata.mediaTime)
        if (forwardRvfc.current == null) return // stopped while awaiting decode
        if (frame) {
          if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
          if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
          ctx.drawImage(frame, 0, 0)
          marks.setCurrentTime(frame.timestamp / 1e6)
        }
      } catch (err) {
        // Decode failed mid-playback - drop back to <video>'s own rendering
        // rather than freezing on a dead canvas. <video> itself was never
        // touched, so it's already showing the right thing.
        console.warn('Frame cache decode failed during playback, showing <video> directly', err)
        stopForwardCanvas()
        return
      }

      if (!video.paused && !video.ended) {
        forwardRvfc.current = video.requestVideoFrameCallback(onFrame)
      } else {
        // Playback stopped on its own (FF/PLAY ran off the end) rather than
        // via still()/rewind() - nothing left to render, hand back to
        // <video>'s own display of its final frame.
        stopForwardCanvas()
      }
    }

    forwardRvfc.current = video.requestVideoFrameCallback(onFrame)
  }

  function play() {
    clearInterval(rewindTimer.current)
    stopCanvasRewind()
    stopForwardCanvas()
    const v = videoRef.current
    if (!v) return
    v.playbackRate = 1
    const cache = frameCacheRef.current
    if (cache) startForwardCanvas(cache)
    // play() returns a promise that rejects with AbortError if the play
    // request gets interrupted (e.g. a pause()/another play() call lands
    // before it resolves - REW does exactly that). Expected and harmless,
    // but needs a catch or it surfaces as an unhandled rejection.
    v.play().catch(() => {})
  }

  function still() {
    clearInterval(rewindTimer.current)
    stopCanvasRewind()
    stopForwardCanvas()
    videoRef.current?.pause()
  }

  function fastForward() {
    clearInterval(rewindTimer.current)
    stopCanvasRewind()
    stopForwardCanvas()
    const v = videoRef.current
    if (!v) return
    v.playbackRate = 4
    const cache = frameCacheRef.current
    if (cache) startForwardCanvas(cache)
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
    let lastTs = performance.now()
    let stopped = false

    async function step(now) {
      if (stopped) return
      const elapsed = (now - lastTs) / 1000
      lastTs = now
      const time = Math.max(0, scrubTimeRef.current - elapsed * REWIND_RATE)
      scrubTimeRef.current = time

      try {
        const frame = await cache.getFrameAtOrBefore(time)
        if (stopped) return
        if (frame && ctx) {
          if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth
          if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight
          ctx.drawImage(frame, 0, 0)
          // Track the actual frame drawn, not the idealized continuous
          // `time` above - getFrameAtOrBefore returns the nearest frame AT
          // OR BEFORE that time, so the two can differ by up to one frame's
          // duration. The clock (and the eventual <video> sync in
          // stopCanvasRewind) should reflect what's actually on screen.
          lastDrawnTimeRef.current = frame.timestamp / 1e6
        }
      } catch (err) {
        // Decode failed mid-scrub (corrupt sample, decoder hiccup) - fall
        // back to the reseek-based loop from wherever we got to rather than
        // freezing on a dead scrub.
        console.warn('Frame cache decode failed mid-scrub, falling back to reseeking', err)
        stopped = true
        stopCanvasRewind()
        startReseekRewind()
        return
      }

      marks.setCurrentTime(lastDrawnTimeRef.current)
      if (time <= 0) {
        stopped = true
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

  function jog(step) {
    still()
    const v = videoRef.current
    if (!v) return
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, v.currentTime + step))
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
          jog(-1 / 30)
          break
        case 'jogRight':
          jog(1 / 30)
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
          <b onClick={() => jog(-1 / 30)} className={`switch${keyClass('jogLeft')}`}>
            {'<'}
            {keyHint('jogLeft')}
          </b>
          <b onClick={() => jog(1 / 30)} className={`switch${keyClass('jogRight')}`}>
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
