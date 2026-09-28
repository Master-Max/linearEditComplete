import { useSequencePlayer } from './useSequencePlayer'
import { useAudioSequencePlayer } from './useAudioSequencePlayer'
import { useAudioTrack } from './useAudioTrack'

// Stable empty track, so the players' "sequence changed" effects don't fire
// on every render for whichever track isn't in use.
const NO_CLIPS = []

// Everything a recorder monitor needs to preview the timeline, whichever
// tracks are in use:
// - video clips (with or without an audio track): the video sequence
//   player is the clock, and useAudioTrack slaves the audio track to it.
// - audio track only: the audio sequence player is its own clock.
// `player` is whichever one is driving, so transport controls don't need
// to care. Both players always exist (hooks can't be conditional); the
// idle one just gets an empty track.
export function useRecorderPlayback(clips, audioClips, { keepClipAudio }) {
  const audioOnly = clips.length === 0 && audioClips.length > 0
  const videoPlayer = useSequencePlayer(clips)
  const audioPlayer = useAudioSequencePlayer(audioOnly ? audioClips : NO_CLIPS)
  const trackAudioRef = useAudioTrack(audioOnly ? NO_CLIPS : audioClips, videoPlayer, { keepClipAudio })

  return {
    audioOnly,
    player: audioOnly ? audioPlayer : videoPlayer,
    videoRef: videoPlayer.videoRef,
    // Both <audio> elements always render; only one ever plays.
    audioRefs: [audioPlayer.audioRef, trackAudioRef],
  }
}
