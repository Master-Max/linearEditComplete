import { useRef } from 'react'
import { loadVideoSource } from '../lib/loadVideoSource'
import ClassicPlayerDeck from './ClassicPlayerDeck'
import ClassicEditorConsole from './ClassicEditorConsole'
import ClassicRecorderDeck from './ClassicRecorderDeck'
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
  ffmpeg,
}) {
  const fileInputRef = useRef(null)

  async function handleLoadFiles(fileList) {
    const file = Array.from(fileList).find((f) => f.type.startsWith('video/'))
    if (!file) return
    const source = await loadVideoSource(file)
    onAddSource(source)
    onSelectSource(source.id)
  }

  return (
    <div className="classic-editor">
      <div id="monitors" className="flexy">
        <ClassicPlayerDeck
          source={selectedSource}
          onLoad={() => fileInputRef.current?.click()}
          onEject={() => onSelectSource(null)}
          onAddClip={onAddClip}
        />
        <ClassicEditorConsole clips={clips} onRemove={onRemoveClip} onMove={onMoveClip} />
        <ClassicRecorderDeck clips={clips} />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => handleLoadFiles(e.target.files)}
      />

      <div id="controls">
        <div className="export-wrap">
          <ExportPanel clips={clips} ffmpeg={ffmpeg} />
        </div>
      </div>
    </div>
  )
}
