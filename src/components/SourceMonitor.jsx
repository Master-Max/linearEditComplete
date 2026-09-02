import { useRef } from 'react'
import { formatTime } from '../lib/format'
import { usePlayerMarks } from '../hooks/usePlayerMarks'

export default function SourceMonitor({ source, onAddClip }) {
  const videoRef = useRef(null)
  const marks = usePlayerMarks(videoRef, source)

  if (!source) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-slate-200 text-sm text-slate-400">
        Upload a video to preview it here
      </div>
    )
  }

  function handleAdd() {
    if (marks.outPoint <= marks.inPoint) return
    onAddClip({
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
      <video
        key={source.id}
        ref={videoRef}
        src={source.url}
        controls
        className="w-full rounded-lg bg-black"
        onLoadedMetadata={marks.resetMarks}
        onTimeUpdate={(e) => marks.setCurrentTime(e.currentTarget.currentTime)}
      />

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
        <button
          type="button"
          onClick={handleAdd}
          disabled={marks.outPoint <= marks.inPoint}
          className="ml-auto rounded bg-indigo-600 px-4 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Add to Timeline
        </button>
      </div>
    </div>
  )
}
