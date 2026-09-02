import { formatTime } from '../lib/format'

export default function SourceList({ sources, selectedId, onSelect }) {
  if (sources.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2">
      {sources.map((source) => (
        <button
          key={source.id}
          type="button"
          onClick={() => onSelect(source.id)}
          className={`rounded border px-3 py-1.5 text-left text-sm ${
            source.id === selectedId
              ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
          }`}
        >
          <div className="max-w-[10rem] truncate font-medium">{source.name}</div>
          <div className="text-xs text-slate-400">{formatTime(source.duration)}</div>
        </button>
      ))}
    </div>
  )
}
