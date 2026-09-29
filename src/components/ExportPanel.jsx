import { useState } from 'react'

// Which path exportSequence took for the video (see useFFmpeg.js).
const ENGINE_LABELS = {
  gpu: 'on the GPU (WebCodecs, hardware)',
  webcodecs: 'with WebCodecs (browser software encoder)',
  ffmpeg: 'with ffmpeg.wasm (CPU)',
}

export default function ExportPanel({ clips, audioClips, keepClipAudio, ffmpeg, resolution, fitMode }) {
  // { url, kind } - kind ('video' | 'audio') is captured from the export
  // itself, not the current timeline, which may have changed since.
  const [result, setResult] = useState(null)
  const [exporting, setExporting] = useState(false)

  const busy = ffmpeg.loading || exporting

  async function handleExport() {
    setExporting(true)
    if (result) URL.revokeObjectURL(result.url)
    setResult(null)
    try {
      const exported = await ffmpeg.exportSequence(clips, {
        width: resolution?.width,
        height: resolution?.height,
        fitMode,
        audioClips,
        keepClipAudio,
      })
      setResult(exported)
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
          disabled={(clips.length === 0 && audioClips.length === 0) || busy}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {ffmpeg.loading
            ? 'Loading ffmpeg…'
            : exporting
              ? 'Exporting…'
              : clips.length === 0 && audioClips.length > 0
                ? 'Export Audio'
                : 'Export Video'}
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

      {result && (
        <div className="flex flex-col gap-2">
          {result.kind === 'audio' ? (
            <audio src={result.url} controls className="w-full" />
          ) : (
            <video src={result.url} controls className="w-full rounded-lg bg-black" />
          )}
          <a
            href={result.url}
            download={result.kind === 'audio' ? 'linear-edit-export.m4a' : 'linear-edit-export.mp4'}
            className="self-start rounded bg-slate-800 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            {result.kind === 'audio' ? 'Download M4A' : 'Download MP4'}
          </a>
          {result.videoEngine && (
            <p className="text-xs text-slate-400">Video encoded {ENGINE_LABELS[result.videoEngine]}</p>
          )}
        </div>
      )}
    </div>
  )
}
