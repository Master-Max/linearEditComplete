import { useEffect, useRef } from 'react'
import { usePlayerMarks } from '../hooks/usePlayerMarks'
import { formatTimecode } from './formatTimecode'

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

  // JKL-style transport shortcuts, mirroring the deck's own buttons.
  // Skipped while focus is in a form control (e.g. the resolution panel's
  // selects/radios) so native typing/selection isn't hijacked.
  useEffect(() => {
    function isTypingTarget(el) {
      if (!el) return false
      const tag = el.tagName
      return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable
    }

    function handleKeyDown(e) {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(document.activeElement)) return

      switch (e.key.toLowerCase()) {
        case ' ':
          e.preventDefault()
          play()
          break
        case 'k':
          still()
          break
        case 'j':
          rewind()
          break
        case 'l':
          fastForward()
          break
        case 'i':
          marksRef.current.markIn()
          break
        case 'o':
          marksRef.current.markOut()
          break
        case 'arrowleft':
          e.preventDefault()
          jog(-1 / 30)
          break
        case 'arrowright':
          e.preventDefault()
          jog(1 / 30)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
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

      <div className="center-div">
        <div className="row">
          <b onClick={onLoad} className="switch blue-button">LOAD</b>
          <b onClick={onEject} className="switch blue-button">EJECT</b>
        </div>
      </div>
      <br />
      <div className="center-div">
        <div className="row">
          <b onClick={play} className="switch">PLAY</b>
          <b onClick={still} className="switch">STILL</b>
          <b onClick={rewind} className="switch">REW</b>
          <b onClick={fastForward} className="switch">FF</b>
        </div>
      </div>
      <br />
      <div className="center-div">
        <div className="row">
          <b onClick={marks.markIn} className="switch grey-button">MARK IN</b>
          <b onClick={marks.markOut} className="switch grey-button">MARK OUT</b>
        </div>
      </div>
      <br />
      <div id="jogger" className="center-div">
        <div className="center-div">
          <b className="light">JOG</b>
        </div>
        <div className="row">
          <b onClick={() => jog(-1 / 30)} className="switch">{'<'}</b>
          <b onClick={() => jog(1 / 30)} className="switch">{'>'}</b>
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
