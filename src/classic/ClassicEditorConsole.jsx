import { clipLength, totalLength } from '../lib/clip'
import { formatTimecode } from './formatTimecode'

function TrackList({ title, clips, emptyText, onRemove, onMove, children }) {
  return (
    <div className="part-box clip-list">
      <p className="clip-list-title">{title} — {formatTimecode(totalLength(clips))}</p>
      {children}
      {clips.length === 0 ? (
        <p className="clip-list-empty">{emptyText}</p>
      ) : (
        <ol className="clip-list-items">
          {clips.map((clip, index) => (
            <li key={clip.id}>
              <span className="clip-list-name">
                {index + 1}. {clip.sourceName}
              </span>
              <span className="clip-list-time">
                {formatTimecode(clip.inPoint)}–{formatTimecode(clip.outPoint)} ({formatTimecode(clipLength(clip))})
              </span>
              <span className="clip-list-actions">
                <button type="button" disabled={index === 0} onClick={() => onMove(index, index - 1)}>↑</button>
                <button type="button" disabled={index === clips.length - 1} onClick={() => onMove(index, index + 1)}>↓</button>
                <button type="button" onClick={() => onRemove(clip.id)}>✕</button>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

export default function ClassicEditorConsole({
  clips,
  onRemove,
  onMove,
  audioClips,
  onRemoveAudio,
  onMoveAudio,
  keepClipAudio,
  onKeepClipAudioChange,
}) {
  return (
    <div id="editor">
      <div id="main-edit">
        <TrackList title="VIDEO" clips={clips} emptyText="No clips yet" onRemove={onRemove} onMove={onMove} />
        <TrackList
          title="AUDIO"
          clips={audioClips}
          emptyText="No audio clips yet"
          onRemove={onRemoveAudio}
          onMove={onMoveAudio}
        >
          <label className="clip-list-option">
            <input
              type="checkbox"
              checked={keepClipAudio}
              onChange={(e) => onKeepClipAudioChange(e.target.checked)}
            />
            KEEP VIDEO SOUND
          </label>
        </TrackList>
      </div>
    </div>
  )
}
