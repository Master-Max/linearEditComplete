import { useSequencePlayer } from '../hooks/useSequencePlayer'
import { formatTime } from '../lib/format'

export default function RecorderMonitor({ clips, resolution, fitMode }) {
  const player = useSequencePlayer(clips)

  if (clips.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-slate-200 text-sm text-slate-400">
        Add clips to the timeline to preview the sequence
      </div>
    )
  }

  // Lock the preview box to the project's aspect ratio so playback doesn't
  // jump in size/shape as it crosses into a clip of a different resolution;
  // object-fit mirrors the letterbox/crop treatment the export will apply.
  const aspectRatio =
    resolution?.width && resolution?.height ? `${resolution.width} / ${resolution.height}` : '16 / 9'

  return (
    <div className="flex flex-col gap-3">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={player.videoRef}
        className="w-full rounded-lg bg-black"
        style={{ aspectRatio, objectFit: fitMode === 'crop' ? 'cover' : 'contain' }}
      />

      <input
        type="range"
        min={0}
        max={player.duration || 0}
        step={0.01}
        value={player.globalTime}
        onChange={(e) => player.seek(Number(e.target.value))}
        className="w-full"
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          onClick={() => (player.isPlaying ? player.pause() : player.play())}
          className="rounded bg-slate-800 px-4 py-1.5 font-medium text-white hover:bg-slate-700"
        >
          {player.isPlaying ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          onClick={player.restart}
          className="rounded bg-slate-200 px-3 py-1 font-medium hover:bg-slate-300"
        >
          Restart
        </button>
        <span className="text-slate-500">
          {formatTime(player.globalTime)} / {formatTime(player.duration)}
        </span>
        <span className="ml-auto text-slate-400">
          Clip {player.clipIndex + 1} of {clips.length}
        </span>
      </div>
    </div>
  )
}
