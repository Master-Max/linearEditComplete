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
  // Set by checkPosition when playback stops because it ran off the last
  // clip's end, cleared by anything that repositions playback (loadClip,
  // seek). play() reads this to decide whether pressing PLAY again should
  // restart from the top - it used to infer "ended" from
  // video.currentTime >= clip.outPoint, which relied on the old one-frame
  // overshoot actually reaching outPoint; checkPosition now stops just
  // before it, so that comparison can no longer tell "ended" from "still
  // has a hair left to play".
  const reachedEndRef = useRef(false)

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
    reachedEndRef.current = false

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

  // Tracks the previous tick's presented-frame time so checkPosition can
  // estimate the source's frame duration and predict the next frame's
  // timing - see checkPosition for why. Reset to null whenever a clip swap
  // happens so the new clip's first tick doesn't compare against the old
  // clip's unrelated timestamp.
  const lastFrameTimeRef = useRef(null)

  const checkPosition = useCallback(
    (_now, metadata) => {
      const video = videoRef.current
      const clip = clipsRef.current[clipIndex]
      if (!video || !clip) return

      // metadata.mediaTime (from requestVideoFrameCallback) is the exact
      // presentation time of the frame that was just shown - more precise
      // than video.currentTime, which the rAF fallback path doesn't have.
      const frameTime = metadata?.mediaTime ?? video.currentTime
      const frameDuration = lastFrameTimeRef.current != null
        ? Math.max(0, frameTime - lastFrameTimeRef.current)
        : 1 / 30 // no prior sample yet (first tick of a clip) - a reasonable guess
      lastFrameTimeRef.current = frameTime

      setGlobalTime(offsetOf(clipIndex) + Math.max(0, frameTime - clip.inPoint))

      // Cut as soon as the NEXT frame would land past outPoint, instead of
      // reacting only once a frame already past it has been shown. That
      // reactive check (frameTime >= clip.outPoint) is why preview could
      // show one extra frame beyond the marked out point even though
      // export matches exactly - ffmpeg re-encodes to an exact duration,
      // it doesn't have to land on whichever discrete frame the source
      // happens to have, so it never had this problem to begin with.
      // Predicting via the last measured frame duration assumes roughly
      // constant frame rate (true for the camera-recorded footage this app
      // targets); the half-frame margin absorbs normal timing jitter in
      // that estimate, biasing toward cutting a fraction of a frame early
      // over ever overshooting again.
      const nextFrameWouldOvershoot = frameTime + frameDuration * 0.5 >= clip.outPoint
      if (nextFrameWouldOvershoot) {
        if (clipIndex + 1 < clipsRef.current.length) {
          loadClip(clipIndex + 1, { play: isPlaying })
        } else {
          video.pause()
          setIsPlaying(false)
          reachedEndRef.current = true
        }
        lastFrameTimeRef.current = null
      }
    },
    [clipIndex, isPlaying, loadClip, offsetOf],
  )

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

    function tick(now, metadata) {
      if (cancelled) return
      checkPosition(now, metadata)
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
    // If we've played off the end, restart from the top.
    if (reachedEndRef.current) {
      loadClip(0, { play: true })
    } else {
      video.play()
    }
    setIsPlaying(true)
  }, [loadClip])

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
    reachedEndRef.current = false
    lastFrameTimeRef.current = null
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
