import { useState } from 'react'

export default function ResolutionMismatchNotice({ notice, fitMode, onDismiss }) {
  const [dontRemind, setDontRemind] = useState(false)

  if (!notice) return null

  function handleClose() {
    onDismiss(dontRemind)
    setDontRemind(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl">
        <h3 className="text-sm font-semibold text-slate-800">Resolution mismatch</h3>
        <p className="mt-2 text-sm text-slate-600">
          <span className="font-medium">{notice.sourceName}</span> is {notice.sourceWidth}×{notice.sourceHeight},
          which doesn't match the project resolution ({notice.projectWidth}×{notice.projectHeight}). It'll be{' '}
          {fitMode === 'crop' ? 'cropped to fill the frame' : 'letterboxed with black bars'} in the preview and
          export.
        </p>
        <label className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          <input type="checkbox" checked={dontRemind} onChange={(e) => setDontRemind(e.target.checked)} />
          Don't remind me again
        </label>
        <button
          type="button"
          onClick={handleClose}
          className="mt-4 w-full rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Got it
        </button>
      </div>
    </div>
  )
}
