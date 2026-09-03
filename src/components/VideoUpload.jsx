import { useRef } from 'react'
import { loadVideoSource } from '../lib/loadVideoSource'

export default function VideoUpload({ onAdd }) {
  const inputRef = useRef(null)

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('video/'))
    const results = await Promise.allSettled(files.map(loadVideoSource))
    for (const result of results) {
      if (result.status === 'fulfilled') {
        onAdd(result.value)
      } else {
        console.error('Failed to load video file:', result.reason)
      }
    }
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
        Drag video files here, or{' '}
        <button
          type="button"
          className="font-medium text-indigo-600 hover:underline"
          onClick={() => inputRef.current?.click()}
        >
          browse
        </button>
      </p>
      <p className="text-xs text-slate-400">
        Files never leave your computer — all editing runs locally in the browser.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        multiple
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
    </div>
  )
}
