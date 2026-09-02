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

  function markIn() {
    const t = videoRef.current?.currentTime ?? 0
    setInPoint(Math.min(t, outPoint))
  }

  function markOut() {
    const t = videoRef.current?.currentTime ?? 0
    setOutPoint(Math.max(t, inPoint))
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
