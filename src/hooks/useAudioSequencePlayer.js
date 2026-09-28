import { useCallback, useEffect, useRef, useState } from 'react'
import { clipLength, locateOnTrack, totalLength } from '../lib/clip'

// useSequencePlayer's counterpart for a timeline with no video clips: the
// audio track has to be its own clock then, since there's no <video> for
// useAudioTrack to follow. Same "replace the source at each out-point"
// trick on one <audio> element, and the same return shape, so the
// recorder monitors can drive either one through the same controls.
//
// Cut detection runs on requestAnimationFrame rather than
// requestVideoFrameCallback (audio has no presented frames to hook). That
// can overshoot an out-point by up to one display frame (~16ms), which is
// inaudible next to the video player's frame-accuracy concerns - export is
// sample-exact regardless.
export function useAudioSequencePlayer(clips) {
  const audioRef = useRef(null)
  const clipsRef = useRef(clips)
  clipsRef.current = clips
  // Read from the rAF loop, which would otherwise see a stale index from
  // whichever render scheduled it.
  const clipIndexRef = useRef(0)

  const [clipIndex, setClipIndex] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [globalTime, setGlobalTime] = useState(0)
  const reachedEndRef = useRef(false)

  const duration = totalLength(clips)

  const offsetOf = useCallback((index) => {
    let offset = 0
    for (let i = 0; i < index; i++) offset += clipLength(clipsRef.current[i])
    return offset
  }, [])

  const loadClip = useCallback((index, { play = false, offset = 0 } = {}) => {
    const audio = audioRef.current
    const clip = clipsRef.current[index]
    if (!audio || !clip) return
    reachedEndRef.current = false
    if (audio.src !== clip.url) audio.src = clip.url
    // Allowed before metadata loads - held as the start position until then.
    audio.currentTime = clip.inPoint + offset
    if (play) audio.play().catch(() => {})
    clipIndexRef.current = index
    setClipIndex(index)
    setGlobalTime(offsetOf(index) + offset)
  }, [offsetOf])

  useEffect(() => {
    if (!isPlaying) return
    let handle = null

    function tick() {
      const audio = audioRef.current
      const index = clipIndexRef.current
      const clip = clipsRef.current[index]
      if (!audio || !clip) return

      const time = audio.currentTime
      setGlobalTime(offsetOf(index) + Math.max(0, time - clip.inPoint))

      if (time >= clip.outPoint || audio.ended) {
        if (index + 1 < clipsRef.current.length) {
          loadClip(index + 1, { play: true })
        } else {
          audio.pause()
          setIsPlaying(false)
          reachedEndRef.current = true
          return
        }
      }
      handle = requestAnimationFrame(tick)
    }

    handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [isPlaying, loadClip, offsetOf])

  // Load the first clip whenever the sequence changes underneath us.
  useEffect(() => {
    if (clips.length > 0) {
      loadClip(0)
    } else {
      audioRef.current?.pause()
      setIsPlaying(false)
      setGlobalTime(0)
    }
  }, [clips, loadClip])

  const play = useCallback(() => {
    if (clipsRef.current.length === 0) return
    if (reachedEndRef.current) {
      loadClip(0, { play: true })
    } else {
      audioRef.current?.play().catch(() => {})
    }
    setIsPlaying(true)
  }, [loadClip])

  const pause = useCallback(() => {
    audioRef.current?.pause()
    setIsPlaying(false)
  }, [])

  const restart = useCallback(() => {
    loadClip(0, { play: isPlaying })
  }, [isPlaying, loadClip])

  const seek = useCallback((time) => {
    const list = clipsRef.current
    if (list.length === 0) return
    const clamped = Math.max(0, Math.min(time, totalLength(list)))
    // Exactly at the end, locateOnTrack reports "past the track" - park on
    // the last clip's final instant instead.
    const hit = locateOnTrack(list, clamped) ?? {
      index: list.length - 1,
      offset: clipLength(list[list.length - 1]),
    }
    loadClip(hit.index, { play: isPlaying, offset: hit.offset })
  }, [isPlaying, loadClip])

  return {
    audioRef,
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
