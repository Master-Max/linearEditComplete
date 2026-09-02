import { useRef, useState } from 'react'
import { formatTime } from '../lib/format'

export default function SourceMonitor({ source, onAddClip }) {
  const videoRef = useRef(null)
  const [inPoint, setInPoint] = useState(0)
  const [outPoint, setOutPoint] = useState(source?.duration ?? 0)
  const [currentTime, setCurrentTime] = useState(0)

  if (!source) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border border-slate-200 text-sm text-slate-400">
        Upload a video to preview it here
      </div>
    )
  }

  function markIn() {
    const t = videoRef.current?.currentTime ?? 0
    setInPoint(Math.min(t, outPoint))
  }

  function markOut() {
    const t = videoRef.current?.currentTime ?? 0
    setOutPoint(Math.max(t, inPoint))
  }

  function handleAdd() {
    if (outPoint <= inPoint) return
    onAddClip({
      sourceId: source.id,
      sourceName: source.name,
      file: source.file,
      url: source.url,
      duration: source.duration,
      inPoint,
      outPoint,
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
        onLoadedMetadata={() => {
          setInPoint(0)
          setOutPoint(source.duration)
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
      />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-slate-500">Playhead {formatTime(currentTime)}</span>
        <button
          type="button"
          onClick={markIn}
          className="rounded bg-slate-200 px-3 py-1 font-medium hover:bg-slate-300"
        >
          Mark In
        </button>
        <span>In {formatTime(inPoint)}</span>
        <button
          type="button"
          onClick={markOut}
          className="rounded bg-slate-200 px-3 py-1 font-medium hover:bg-slate-300"
        >
          Mark Out
        </button>
        <span>Out {formatTime(outPoint)}</span>
        <button
          type="button"
          onClick={handleAdd}
          disabled={outPoint <= inPoint}
          className="ml-auto rounded bg-indigo-600 px-4 py-1.5 font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          Add to Timeline
        </button>
      </div>
    </div>
  )
}
