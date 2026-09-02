import { useState } from 'react'
import VideoUpload from './components/VideoUpload'
import SourceList from './components/SourceList'
import SourceMonitor from './components/SourceMonitor'
import Timeline from './components/Timeline'
import ExportPanel from './components/ExportPanel'
import { createClip } from './lib/clip'
import { useFFmpeg } from './hooks/useFFmpeg'

export default function App() {
  const [sources, setSources] = useState([])
  const [selectedSourceId, setSelectedSourceId] = useState(null)
  const [clips, setClips] = useState([])
  const ffmpeg = useFFmpeg()

  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null

  function handleAddSource(source) {
    setSources((prev) => [...prev, source])
    setSelectedSourceId((current) => current ?? source.id)
  }

  function handleAddClip(clipArgs) {
    setClips((prev) => [...prev, createClip(clipArgs)])
  }

  function handleRemoveClip(id) {
    setClips((prev) => prev.filter((c) => c.id !== id))
  }

  function handleMoveClip(from, to) {
    setClips((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  return (
    <div className="min-h-full bg-slate-100">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-xl font-semibold text-slate-800">Linear Edit</h1>
        <p className="text-sm text-slate-400">
          Trim and stitch clips entirely on your device — powered by ffmpeg.wasm.
        </p>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
        <VideoUpload onAdd={handleAddSource} />

        <SourceList sources={sources} selectedId={selectedSourceId} onSelect={setSelectedSourceId} />

        <SourceMonitor source={selectedSource} onAddClip={handleAddClip} />

        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-slate-700">Timeline</h2>
          <Timeline clips={clips} onRemove={handleRemoveClip} onMove={handleMoveClip} />
        </section>

        <ExportPanel clips={clips} ffmpeg={ffmpeg} />
      </main>
    </div>
  )
}
