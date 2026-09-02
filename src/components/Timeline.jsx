import { clipLength, totalLength } from '../lib/clip'
import { formatTime } from '../lib/format'

export default function Timeline({ clips, onRemove, onMove }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{clips.length} clip{clips.length === 1 ? '' : 's'}</span>
        <span>Total {formatTime(totalLength(clips))}</span>
      </div>

      {clips.length === 0 ? (
        <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-slate-200 text-sm text-slate-400">
          Marked clips will appear here in order
        </div>
      ) : (
        <ol className="flex flex-col gap-2">
          {clips.map((clip, index) => (
            <li
              key={clip.id}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <span className="w-5 shrink-0 text-center text-sm text-slate-400">{index + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-slate-700">{clip.sourceName}</div>
                <div className="text-xs text-slate-400">
                  {formatTime(clip.inPoint)} – {formatTime(clip.outPoint)} ({formatTime(clipLength(clip))})
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => onMove(index, index - 1)}
                  className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  aria-label="Move up"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={index === clips.length - 1}
                  onClick={() => onMove(index, index + 1)}
                  className="rounded px-2 py-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"
                  aria-label="Move down"
                >
                  ↓
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(clip.id)}
                  className="rounded px-2 py-1 text-red-500 hover:bg-red-50"
                  aria-label="Remove"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
