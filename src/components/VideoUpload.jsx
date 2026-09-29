import { useRef, useState } from 'react'
import { isMediaFile, MEDIA_ACCEPT } from '../lib/loadVideoSource'

export default function VideoUpload({ onAdd, loadSource, onError }) {
  const inputRef = useRef(null)
  // Files still loading - reading into memory, and for audio the browser
  // can't play, converting through ffmpeg, which can take a few seconds.
  const [pending, setPending] = useState(0)

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(isMediaFile)
    if (files.length === 0) return
    setPending((n) => n + files.length)
    const results = await Promise.allSettled(files.map((file) => loadSource(file)))
    setPending((n) => n - files.length)
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        onAdd(result.value)
      } else {
        onError(files[i], result.reason)
      }
    })
  }

  return (
    <div
      className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-6 py-10 text-center hover:border-slate-400"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        handleFiles(e.dataTransfer.files)
      }}
    >
      <p className="text-sm text-slate-600">
        Drag video or audio files here, or{' '}
        <button
          type="button"
          className="font-medium text-indigo-600 hover:underline"
          onClick={() => inputRef.current?.click()}
        >
          browse
        </button>
      </p>
      <p className="text-xs text-slate-400">
        MP3, WAV, M4A, FLAC, OGG and more. Files never leave your computer — all editing runs locally in the browser.
      </p>
      {pending > 0 && (
        <p className="text-xs text-indigo-600">
          Loading {pending} file{pending === 1 ? '' : 's'}…
        </p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={MEDIA_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          handleFiles(e.target.files)
          // Let the same file be picked again after removing it.
          e.target.value = ''
        }}
      />
    </div>
  )
}
