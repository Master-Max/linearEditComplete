import { useSequencePlayer } from '../hooks/useSequencePlayer'
import { formatTimecode } from './formatTimecode'

export default function ClassicRecorderDeck({ clips }) {
  const player = useSequencePlayer(clips)

  function skip(delta) {
    if (clips.length === 0) return
    player.seek(Math.max(0, Math.min(player.duration, player.globalTime + delta)))
  }

  return (
    <div id="recorder">
      <p>RECORDER</p>
      <div className="row right-justify">
        <b className="light">{clips.length} CLIP{clips.length === 1 ? '' : 'S'}</b>
      </div>
      <div className="clock">{formatTimecode(player.globalTime)}</div>

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video ref={player.videoRef} />

      <div className="center-div">
        <div className="row">
          <b className="switch red-button" style={{ opacity: 0.4, cursor: 'not-allowed' }} title="Not implemented">
            REC
          </b>
          <b onClick={player.restart} className="switch blue-button">
            RESTART
          </b>
        </div>
      </div>
      <br />
      <div className="center-div">
        <div className="row">
          <b
            onClick={() => (player.isPlaying ? player.pause() : player.play())}
            className="switch"
            style={{ opacity: clips.length ? 1 : 0.4 }}
          >
            {player.isPlaying ? 'STILL' : 'PLAY'}
          </b>
          <b onClick={() => skip(-3)} className="switch">REW</b>
          <b onClick={() => skip(3)} className="switch">FF</b>
        </div>
      </div>
      <br />
      <div id="jogger" className="center-div">
        <div className="center-div">
          <b className="light">JOG</b>
        </div>
        <div className="row">
          <b onClick={() => skip(-1 / 30)} className="switch">{'<'}</b>
          <b onClick={() => skip(1 / 30)} className="switch">{'>'}</b>
        </div>
      </div>
    </div>
  )
}
