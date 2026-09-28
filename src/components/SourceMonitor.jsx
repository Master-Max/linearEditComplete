import { useRef } from 'react'
import { formatTime } from '../lib/format'
import { usePlayerMarks } from '../hooks/usePlayerMarks'

export default function SourceMonitor({ source, onAddClip, onAddAudioClip }) {
  const videoRef = useRef(null)
  const marks = usePlayerMarks(videoRef, source)

  if (!source) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-slate-200 text-sm text-slate-400">
        Upload a video to preview it here
      </div>
    )
  }

  const isAudio = source.kind === 'audio'
  const canAdd = marks.outPoint > marks.inPoint

  function handleAdd(addToTrack) {
    if (!canAdd) return
    addToTrack({
      sourceId: source.id,
      sourceName: source.name,
      file: source.file,
      url: source.url,
      duration: source.duration,
      inPoint: marks.inPoint,
      outPoint: marks.outPoint,
    })
  }

  return (
    <div className="flex flex-col gap-3">
      {isAudio ? (
        <audio
          key={source.id}
          ref={videoRef}
          src={source.url}
          controls
          className="w-full"
          onLoadedMetadata={marks.resetMarks}
          onTimeUpdate={(e) => marks.setCurrentTime(e.currentTarget.currentTime)}
        />
      ) : (
        <video
          key={source.id}
          ref={videoRef}
          src={source.url}
          controls
          className="w-full rounded-lg bg-black"
          onLoadedMetadata={marks.resetMarks}
          onTimeUpdate={(e) => marks.setCurrentTime(e.currentTarget.currentTime)}
        />
      )}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-slate-500">Playhead {formatTime(marks.currentTime)}</span>
        <button
          type="button"
          onClick={marks.markIn}
          className="rounded bg-slate-200 px-3 py-1 font-medium hover:bg-slate-300"
        >
          Mark In
        </button>
        <span>In {formatTime(marks.inPoint)}</span>
        <button
          type="button"
          onClick={marks.markOut}
          className="rounded bg-slate-200 px-3 py-1 font-medium hover:bg-slate-300"
        >
          Mark Out
        </button>
        <span>Out {formatTime(marks.outPoint)}</span>
        <div className="ml-auto flex gap-2">
          {/* A video source can feed either track - adding it to the audio
              track lifts just its sound, e.g. an interview's audio laid
              under B-roll. An audio file has no picture to put on the video
              track. */}
          <button
            type="button"
            onClick={() => handleAdd(onAddAudioClip)}
            disabled={!canAdd}
            className={`rounded px-4 py-1.5 font-medium disabled:cursor-not-allowed disabled:bg-slate-300 ${
              isAudio
                ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                : 'bg-slate-200 text-slate-700 hover:bg-slate-300 disabled:text-white'
            }`}
          >
            Add to Audio Track
          </button>
          {!isAudio && (
            <button
              type="button"
              onClick={() => handleAdd(onAddClip)}
              disabled={!canAdd}
              className="rounded bg-indigo-600 px-4 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              Add to Video Track
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
