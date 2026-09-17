import { useState } from 'react'

// Mark in/out points against a <video> ref, resetting whenever the
// underlying source changes (keyed by sourceId).
export function usePlayerMarks(videoRef, source) {
  const [inPoint, setInPoint] = useState(0)
  const [outPoint, setOutPoint] = useState(source?.duration ?? 0)
  const [currentTime, setCurrentTime] = useState(0)

  function resetMarks() {
    setInPoint(0)
    setOutPoint(source?.duration ?? 0)
  }

  // markIn/markOut read the tracked `currentTime` state rather than
  // videoRef.current.currentTime directly - during a WebCodecs frame-cache
  // scrub (see ClassicPlayerDeck's rewind()) the <video> element itself sits
  // paused and stale while a canvas shows the actual scrub position, so
  // videoRef.current.currentTime would be wrong mid-scrub. `currentTime` is
  // kept live by both the video's own timeupdate handler and the scrub loop.
  function markIn() {
    setInPoint(Math.min(currentTime, outPoint))
  }

  function markOut() {
    setOutPoint(Math.max(currentTime, inPoint))
  }

  function goToIn() {
    if (videoRef.current) videoRef.current.currentTime = inPoint
  }

  function goToOut() {
    if (videoRef.current) videoRef.current.currentTime = outPoint
  }

  return {
    inPoint,
    outPoint,
    currentTime,
    setCurrentTime,
    resetMarks,
    markIn,
    markOut,
    goToIn,
    goToOut,
  }
}
