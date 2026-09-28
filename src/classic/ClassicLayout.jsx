import { useRef } from 'react'
import { isMediaFile, loadVideoSource } from '../lib/loadVideoSource'
import ClassicPlayerDeck from './ClassicPlayerDeck'
import ClassicEditorConsole from './ClassicEditorConsole'
import ClassicRecorderDeck from './ClassicRecorderDeck'
import ClassicProjectSettings from './ClassicProjectSettings'
import ExportPanel from '../components/ExportPanel'
import './classic.css'

export default function ClassicLayout({
  selectedSource,
  onAddSource,
  onSelectSource,
  clips,
  onAddClip,
  onRemoveClip,
  onMoveClip,
  audioClips,
  onAddAudioClip,
  onRemoveAudioClip,
  onMoveAudioClip,
  keepClipAudio,
  onKeepClipAudioChange,
  ffmpeg,
  projectResolution,
  onResolutionChange,
  resolution,
  fitMode,
  onFitModeChange,
}) {
  const fileInputRef = useRef(null)

  async function handleLoadFiles(fileList) {
    const file = Array.from(fileList).find(isMediaFile)
    if (!file) return
    try {
      const source = await loadVideoSource(file)
      onAddSource(source)
      onSelectSource(source.id)
    } catch (err) {
      console.error('Failed to load video file:', err)
    }
  }

  return (
    <div className="classic-editor">
      <ClassicProjectSettings
        resolution={projectResolution}
        onResolutionChange={onResolutionChange}
        effectiveResolution={resolution}
        fitMode={fitMode}
        onFitModeChange={onFitModeChange}
      />

      <div id="monitors" className="flexy">
        <ClassicPlayerDeck
          source={selectedSource}
          onLoad={() => fileInputRef.current?.click()}
          onEject={() => onSelectSource(null)}
          onAddClip={onAddClip}
          onAddAudioClip={onAddAudioClip}
          ffmpeg={ffmpeg}
        />
        <ClassicEditorConsole
          clips={clips}
          onRemove={onRemoveClip}
          onMove={onMoveClip}
          audioClips={audioClips}
          onRemoveAudio={onRemoveAudioClip}
          onMoveAudio={onMoveAudioClip}
          keepClipAudio={keepClipAudio}
          onKeepClipAudioChange={onKeepClipAudioChange}
        />
        <ClassicRecorderDeck clips={clips} audioClips={audioClips} keepClipAudio={keepClipAudio} fitMode={fitMode} />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*"
        className="hidden"
        onChange={(e) => handleLoadFiles(e.target.files)}
      />

      <div id="controls">
        <div className="export-wrap">
          <ExportPanel
            clips={clips}
            audioClips={audioClips}
            keepClipAudio={keepClipAudio}
            ffmpeg={ffmpeg}
            resolution={resolution}
            fitMode={fitMode}
          />
        </div>
      </div>
    </div>
  )
}
