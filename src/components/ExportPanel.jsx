import { useState } from 'react'

export default function ExportPanel({ clips, ffmpeg }) {
  const [resultUrl, setResultUrl] = useState(null)
  const [exporting, setExporting] = useState(false)

  const busy = ffmpeg.loading || exporting

  async function handleExport() {
    setExporting(true)
    if (resultUrl) URL.revokeObjectURL(resultUrl)
    setResultUrl(null)
    try {
      const url = await ffmpeg.exportSequence(clips)
      setResultUrl(url)
    } catch {
      // ffmpeg.error already carries the message; surfaced below.
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-700">Export</h2>
        <button
          type="button"
          onClick={handleExport}
          disabled={clips.length === 0 || busy}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {ffmpeg.loading ? 'Loading ffmpeg…' : exporting ? 'Exporting…' : 'Export Video'}
        </button>
      </div>

      {busy && (
        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full bg-indigo-500 transition-all"
            style={{ width: `${Math.round(ffmpeg.progress * 100)}%` }}
          />
        </div>
      )}
      {exporting && ffmpeg.statusText && (
        <p className="text-xs text-slate-400">{ffmpeg.statusText}</p>
      )}

      {ffmpeg.error && (
        <p className="text-sm text-red-600">{ffmpeg.error.message ?? String(ffmpeg.error)}</p>
      )}

      {resultUrl && (
        <div className="flex flex-col gap-2">
          <video src={resultUrl} controls className="w-full rounded-lg bg-black" />
          <a
            href={resultUrl}
            download="linear-edit-export.mp4"
            className="self-start rounded bg-slate-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            Download MP4
          </a>
        </div>
      )}
    </div>
  )
}
