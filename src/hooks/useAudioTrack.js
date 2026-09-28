import { useEffect, useRef } from 'react'
import { locateOnTrack } from '../lib/clip'

// How far the audio element may wander from where the video says it should
// be before it gets reseeked. Seeking an <audio> element is audible (a
// click, or a short dropout while it rebuffers), so this is deliberately
// loose: normal frame-to-frame jitter between the video's presented-frame
// time and audio.currentTime is tens of milliseconds and shouldn't trigger
// it, but a clip boundary, a seek, or a real stall all land well past it.
const RESYNC_THRESHOLD_SECONDS = 0.2

// Plays the separate audio track in step with a useSequencePlayer.
//
// The video sequence player stays the master clock - it's already frame-
// accurate about where the timeline is (see checkPosition there), and the
// audio track has no cut points of its own that need that precision. This
// just slaves one <audio> element to its globalTime: whichever audio clip
// sits under the playhead gets loaded and seeked to the matching offset,
// and nothing is played past the audio track's end. Clip boundaries fall
// out of the same resync check as a seek does - crossing into the next
// clip moves the target by at least that clip's inPoint jump.
//
// Also owns muting the video clips' own sound when `keepClipAudio` is off,
// so preview matches what exportSequence will render.
export function useAudioTrack(audioClips, player, { keepClipAudio }) {
  const audioRef = useRef(null)
  const { videoRef, globalTime, isPlaying } = player

  // No deps on purpose: the <video> can mount after this hook's first run
  // (RecorderMonitor only renders it once there are clips), and a boolean
  // assignment every render costs nothing.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !keepClipAudio
  })

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const hit = locateOnTrack(audioClips, globalTime)
    if (!hit) {
      if (!audio.paused) audio.pause()
      return
    }

    const target = hit.clip.inPoint + hit.offset
    if (audio.src !== hit.clip.url) {
      audio.src = hit.clip.url
      // Assigning currentTime before metadata has loaded is allowed - the
      // browser holds it as the default start position and applies it once
      // it can seek - so no loadedmetadata dance is needed here.
      audio.currentTime = target
    } else if (Math.abs(audio.currentTime - target) > RESYNC_THRESHOLD_SECONDS) {
      audio.currentTime = target
    }

    if (isPlaying && audio.paused) {
      audio.play().catch(() => {})
    } else if (!isPlaying && !audio.paused) {
      audio.pause()
    }
  }, [audioClips, globalTime, isPlaying])

  return audioRef
}
