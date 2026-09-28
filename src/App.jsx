import { useEffect, useMemo, useRef, useState } from 'react'
import VideoUpload from './components/VideoUpload'
import SourceList from './components/SourceList'
import SourceMonitor from './components/SourceMonitor'
import Timeline from './components/Timeline'
import RecorderMonitor from './components/RecorderMonitor'
import ExportPanel from './components/ExportPanel'
import ProjectSettings from './components/ProjectSettings'
import ResolutionMismatchNotice from './components/ResolutionMismatchNotice'
import ToastStack from './components/ToastStack'
import ClassicLayout from './classic/ClassicLayout'
import { createClip } from './lib/clip'
import { resolutionsMatch } from './lib/resolution'
import { isResolutionWarningDismissed, dismissResolutionWarningPermanently } from './lib/resolutionWarningPref'
import { useFFmpeg } from './hooks/useFFmpeg'
import { useToasts } from './hooks/useToasts'
import { getLayoutFromLocation, navigateToLayout } from './lib/route'

function moveItem(list, from, to) {
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

export default function App() {
  const [layout, setLayout] = useState(() => getLayoutFromLocation())
  const [sources, setSources] = useState([])
  const [selectedSourceId, setSelectedSourceId] = useState(null)
  const [clips, setClips] = useState([])
  // The audio track: clips laid end to end from 0:00 under the video track,
  // independent of where the video cuts fall. Mixed with the video clips'
  // own sound, or replacing it when keepClipAudio is off.
  const [audioClips, setAudioClips] = useState([])
  const [keepClipAudio, setKeepClipAudio] = useState(true)
  const [projectResolution, setProjectResolution] = useState({ mode: 'auto', width: null, height: null })
  const [fitMode, setFitMode] = useState('letterbox')
  const [mismatchNotice, setMismatchNotice] = useState(null)
  const ffmpeg = useFFmpeg()
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts()

  const selectedSource = sources.find((s) => s.id === selectedSourceId) ?? null

  const effectiveResolution = useMemo(() => {
    if (projectResolution.mode === 'manual' && projectResolution.width && projectResolution.height) {
      return { width: projectResolution.width, height: projectResolution.height }
    }
    const first = sources.find((s) => s.kind !== 'audio')
    return { width: first?.width ?? null, height: first?.height ?? null }
  }, [projectResolution, sources])

  // Keep layout state in sync with the address bar (browser back/forward,
  // or a direct load of /classic - see src/lib/route.js).
  useEffect(() => {
    function onPopState() {
      setLayout(getLayoutFromLocation())
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.title = layout === 'classic' ? 'Linear Edit — Classic' : 'Linear Edit'
  }, [layout])

  function switchLayout(next) {
    navigateToLayout(next)
    setLayout(next)
  }

  // Eagerly load ffmpeg on mount rather than waiting for the first export
  // click, so a device that can't run it (WASM disabled, blocked by a CSP,
  // out of memory on the ~32MB core, etc.) surfaces a toast right away.
  useEffect(() => {
    ffmpeg.load().catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const notifiedErrorRef = useRef(null)
  useEffect(() => {
    if (ffmpeg.error && notifiedErrorRef.current !== ffmpeg.error) {
      notifiedErrorRef.current = ffmpeg.error
      pushToast({
        tone: 'error',
        title: "Video export isn't available on this device",
        message: ffmpeg.error.message ?? String(ffmpeg.error),
      })
    }
    if (!ffmpeg.error) notifiedErrorRef.current = null
  }, [ffmpeg.error, pushToast])

  function handleAddSource(source) {
    if (
      source.kind !== 'audio' &&
      effectiveResolution.width &&
      effectiveResolution.height &&
      !resolutionsMatch(source, effectiveResolution) &&
      !isResolutionWarningDismissed()
    ) {
      setMismatchNotice({
        sourceName: source.name,
        sourceWidth: source.width,
        sourceHeight: source.height,
        projectWidth: effectiveResolution.width,
        projectHeight: effectiveResolution.height,
      })
    }

    setSources((prev) => [...prev, source])
    setSelectedSourceId((current) => current ?? source.id)
  }

  function handleMismatchDismiss(dontRemind) {
    if (dontRemind) dismissResolutionWarningPermanently()
    setMismatchNotice(null)
  }

  function handleAddClip(clipArgs) {
    setClips((prev) => [...prev, createClip(clipArgs)])
  }

  function handleRemoveClip(id) {
    setClips((prev) => prev.filter((c) => c.id !== id))
  }

  function handleMoveClip(from, to) {
    setClips((prev) => moveItem(prev, from, to))
  }

  function handleAddAudioClip(clipArgs) {
    setAudioClips((prev) => [...prev, createClip(clipArgs)])
  }

  function handleRemoveAudioClip(id) {
    setAudioClips((prev) => prev.filter((c) => c.id !== id))
  }

  function handleMoveAudioClip(from, to) {
    setAudioClips((prev) => moveItem(prev, from, to))
  }

  return (
    <div className="min-h-full bg-slate-100">
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      <ResolutionMismatchNotice notice={mismatchNotice} fitMode={fitMode} onDismiss={handleMismatchDismiss} />

      <header className="flex items-start justify-between gap-4 border-b border-slate-200 bg-white px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Linear Edit</h1>
          <p className="text-sm text-slate-400">
            Trim and stitch clips entirely on your device — powered by ffmpeg.wasm.
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex gap-1 rounded-lg bg-slate-100 p-1 text-sm">
            <button
              type="button"
              onClick={() => switchLayout('modern')}
              className={`rounded px-3 py-1 font-medium ${
                layout === 'modern' ? 'bg-white shadow text-slate-800' : 'text-slate-500'
              }`}
            >
              Modern
            </button>
            <button
              type="button"
              onClick={() => switchLayout('classic')}
              className={`rounded px-3 py-1 font-medium ${
                layout === 'classic' ? 'bg-white shadow text-slate-800' : 'text-slate-500'
              }`}
            >
              Classic
            </button>
          </div>
          <span className="text-xs text-slate-400">build {import.meta.env.VITE_COMMIT_HASH ?? 'dev'}</span>
        </div>
      </header>

      {layout === 'classic' ? (
        <ClassicLayout
          selectedSource={selectedSource}
          onAddSource={handleAddSource}
          onSelectSource={setSelectedSourceId}
          clips={clips}
          onAddClip={handleAddClip}
          onRemoveClip={handleRemoveClip}
          onMoveClip={handleMoveClip}
          audioClips={audioClips}
          onAddAudioClip={handleAddAudioClip}
          onRemoveAudioClip={handleRemoveAudioClip}
          onMoveAudioClip={handleMoveAudioClip}
          keepClipAudio={keepClipAudio}
          onKeepClipAudioChange={setKeepClipAudio}
          ffmpeg={ffmpeg}
          projectResolution={projectResolution}
          onResolutionChange={setProjectResolution}
          resolution={effectiveResolution}
          fitMode={fitMode}
          onFitModeChange={setFitMode}
        />
      ) : (
        <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">
          <ProjectSettings
            resolution={projectResolution}
            onResolutionChange={setProjectResolution}
            effectiveResolution={effectiveResolution}
            fitMode={fitMode}
            onFitModeChange={setFitMode}
          />

          <VideoUpload onAdd={handleAddSource} />

          <SourceList sources={sources} selectedId={selectedSourceId} onSelect={setSelectedSourceId} />

          <SourceMonitor source={selectedSource} onAddClip={handleAddClip} onAddAudioClip={handleAddAudioClip} />

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-slate-700">Video track</h2>
            <Timeline clips={clips} onRemove={handleRemoveClip} onMove={handleMoveClip} />
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Audio track</h2>
              <label className="flex items-center gap-1.5 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={keepClipAudio}
                  onChange={(e) => setKeepClipAudio(e.target.checked)}
                />
                Keep video clips' own sound
              </label>
            </div>
            <Timeline
              clips={audioClips}
              onRemove={handleRemoveAudioClip}
              onMove={handleMoveAudioClip}
              emptyText="Audio clips play under the video track from the start, back to back, independent of its cuts"
            />
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-slate-700">Preview</h2>
            <RecorderMonitor
              clips={clips}
              audioClips={audioClips}
              keepClipAudio={keepClipAudio}
              resolution={effectiveResolution}
              fitMode={fitMode}
            />
          </section>

          <ExportPanel
            clips={clips}
            audioClips={audioClips}
            keepClipAudio={keepClipAudio}
            ffmpeg={ffmpeg}
            resolution={effectiveResolution}
            fitMode={fitMode}
          />
        </main>
      )}
    </div>
  )
}
