import { clipLength, totalLength } from '../lib/clip'
import { formatTimecode } from './formatTimecode'

export default function ClassicEditorConsole({ clips, onRemove, onMove }) {
  return (
    <div id="editor">
      <div id="main-edit">
        <div className="part-box clip-list">
          <p className="clip-list-title">TIMELINE — {formatTimecode(totalLength(clips))}</p>
          {clips.length === 0 ? (
            <p className="clip-list-empty">No clips yet</p>
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
      </div>
    </div>
  )
}
