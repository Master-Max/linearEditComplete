import { useEffect, useRef, useState } from 'react'
import { usePlayerMarks } from '../hooks/usePlayerMarks'
import { formatTimecode } from './formatTimecode'

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
  const marks = usePlayerMarks(videoRef, source)
  const rewindTimer = useRef(null)

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

  useEffect(() => () => clearInterval(rewindTimer.current), [])

  function play() {
    clearInterval(rewindTimer.current)
    const v = videoRef.current
    if (!v) return
    v.playbackRate = 1
    v.play()
  }

  function still() {
    clearInterval(rewindTimer.current)
    videoRef.current?.pause()
  }

  function fastForward() {
    clearInterval(rewindTimer.current)
    const v = videoRef.current
    if (!v) return
    v.playbackRate = 4
    v.play()
  }

  function rewind() {
    clearInterval(rewindTimer.current)
    const v = videoRef.current
    if (!v) return
    v.pause()
    // HTML5 video can't play backwards, so REW is emulated by stepping
    // currentTime back on a short interval — the same trick the original
    // PlayerMonitor used for its reverse() transport.
    rewindTimer.current = setInterval(() => {
      v.currentTime = Math.max(0, v.currentTime - 0.08)
      if (v.currentTime <= 0) clearInterval(rewindTimer.current)
    }, 20)
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

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        key={source?.id ?? 'empty'}
        ref={videoRef}
        src={source?.url}
        onLoadedMetadata={marks.resetMarks}
        onTimeUpdate={(e) => marks.setCurrentTime(e.currentTarget.currentTime)}
      />

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
          <b onClick={still} className={`switch${keyClass('still')}`}>
            STILL
            {keyHint('still')}
          </b>
          <b onClick={rewind} className={`switch${keyClass('rewind')}`}>
            REW
            {keyHint('rewind')}
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
