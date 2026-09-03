import { useCallback, useEffect, useRef, useState } from 'react'
import { clipLength, totalLength } from '../lib/clip'

// The "replacing video source" trick: a single <video> element can only ever
// play one clip's URL at a time, so a multi-clip timeline is previewed by
// swapping video.src to the next clip and seeking to its inPoint the instant
// playback crosses the current clip's outPoint. Since sources are local blob
// URLs the swap is effectively instant (no network fetch), so playback reads
// as continuous even though it's really N separate clips under the hood.
export function useSequencePlayer(clips) {
  const videoRef = useRef(null)
  const clipsRef = useRef(clips)
  clipsRef.current = clips

  const [clipIndex, setClipIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [globalTime, setGlobalTime] = useState(0)

  const duration = totalLength(clips)

  // Keep the current clip in range if the timeline shrinks (e.g. a clip removed).
  useEffect(() => {
    if (clipIndex >= clips.length) {
      setClipIndex(0)
      setGlobalTime(0)
    }
  }, [clips, clipIndex])

  const offsetOf = useCallback((index) => {
    let offset = 0
    for (let i = 0; i < index; i++) offset += clipLength(clipsRef.current[i])
    return offset
  }, [])

  const loadClip = useCallback((index, { play } = {}) => {
    const video = videoRef.current
    const clip = clipsRef.current[index]
    if (!video || !clip) return

    const resume = () => {
      video.currentTime = clip.inPoint
      video.removeEventListener('loadedmetadata', resume)
      if (play) video.play()
    }

    if (video.src !== clip.url) {
      video.src = clip.url
      video.addEventListener('loadedmetadata', resume)
    } else {
      resume()
    }
    setClipIndex(index)
  }, [])

  const checkPosition = useCallback(() => {
    const video = videoRef.current
    const clip = clipsRef.current[clipIndex]
    if (!video || !clip) return

    setGlobalTime(offsetOf(clipIndex) + Math.max(0, video.currentTime - clip.inPoint))

    if (video.currentTime >= clip.outPoint) {
      if (clipIndex + 1 < clipsRef.current.length) {
        loadClip(clipIndex + 1, { play: isPlaying })
      } else {
        video.pause()
        setIsPlaying(false)
      }
    }
  }, [clipIndex, isPlaying, loadClip, offsetOf])

  // Drive cut-point detection from actual decoded frames rather than the
  // 'timeupdate' event, which the spec only guarantees fires "4 to 66 times
  // per second" - coarse enough to let playback overshoot an out-point by
  // up to ~250ms before the swap to the next clip happens.
  // requestVideoFrameCallback fires once per presented frame (frame-
  // accurate, and it naturally stops when playback stops); this falls back
  // to requestAnimationFrame, still much tighter than timeupdate, on
  // browsers without it.
  useEffect(() => {
    const video = videoRef.current
    if (!video || !isPlaying) return

    let cancelled = false
    let handle = null
    const useFrameCallback = typeof video.requestVideoFrameCallback === 'function'

    function scheduleNext() {
      if (cancelled) return
      handle = useFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick)
    }

    function tick() {
      if (cancelled) return
      checkPosition()
      scheduleNext()
    }

    scheduleNext()

    return () => {
      cancelled = true
      if (useFrameCallback) video.cancelVideoFrameCallback?.(handle)
      else cancelAnimationFrame(handle)
    }
  }, [isPlaying, checkPosition])

  // Load the first clip whenever the sequence changes underneath us.
  useEffect(() => {
    if (clips.length > 0) loadClip(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips])

  const play = useCallback(() => {
    if (clipsRef.current.length === 0) return
    const video = videoRef.current
    const clip = clipsRef.current[clipIndex]
    // If we've played off the end, restart from the top.
    if (clip && video.currentTime >= clip.outPoint && clipIndex === clipsRef.current.length - 1) {
      loadClip(0, { play: true })
    } else {
      video.play()
    }
    setIsPlaying(true)
  }, [clipIndex, loadClip])

  const pause = useCallback(() => {
    videoRef.current?.pause()
    setIsPlaying(false)
  }, [])

  const restart = useCallback(() => {
    loadClip(0, { play: isPlaying })
  }, [isPlaying, loadClip])

  // Seek to an absolute position on the combined timeline, resolving which
  // clip that falls in and swapping the source if needed.
  const seek = useCallback((time) => {
    const list = clipsRef.current
    let remaining = Math.max(0, Math.min(time, totalLength(list)))
    let index = 0
    while (index < list.length - 1 && remaining > clipLength(list[index])) {
      remaining -= clipLength(list[index])
      index += 1
    }
    const video = videoRef.current
    const targetTime = list[index].inPoint + remaining
    if (index !== clipIndex || video.src !== list[index].url) {
      loadClip(index, { play: isPlaying })
      const onReady = () => {
        video.currentTime = targetTime
        video.removeEventListener('loadedmetadata', onReady)
      }
      video.addEventListener('loadedmetadata', onReady)
    } else {
      video.currentTime = targetTime
    }
    setGlobalTime(offsetOf(index) + remaining)
  }, [clipIndex, isPlaying, loadClip, offsetOf])

  return {
    videoRef,
    clipIndex,
    isPlaying,
    globalTime,
    duration,
    play,
    pause,
    restart,
    seek,
  }
}
