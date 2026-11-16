import { useState } from 'react'

// Mark in/out points against a <video> ref, resetting whenever the
// underlying source changes (keyed by sourceId).
// `getLiveTime`, if given, returns the time of the picture on screen right
// now (or null if it can't say) - marks prefer it to the `currentTime`
// state, which only updates a few times a second during playback.
export function usePlayerMarks(videoRef, source, getLiveTime) {
  const [inPoint, setInPoint] = useState(0)
  const [outPoint, setOutPoint] = useState(source?.duration ?? 0)
  const [currentTime, setCurrentTime] = useState(0)

  function resetMarks() {
    setInPoint(0)
    setOutPoint(source?.duration ?? 0)
  }

  // Marks land on the frame that's on screen at the press. That isn't
  // always videoRef.current.currentTime - during a canvas scrub (see
  // ClassicPlayerDeck's rewind()) <video> sits paused and stale underneath -
  // so the deck supplies getLiveTime to answer it. The mark is also pushed
  // into `currentTime` so the clock shows the value that was just marked.
  function markTime() {
    const live = getLiveTime?.()
    if (live == null) return currentTime
    setCurrentTime(live)
    return live
  }

  function markIn() {
    setInPoint(Math.min(markTime(), outPoint))
  }

  function markOut() {
    setOutPoint(Math.max(markTime(), inPoint))
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
