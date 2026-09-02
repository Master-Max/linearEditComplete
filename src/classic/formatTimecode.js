// Ported from the original PlayerClock/RecorderClock formatter: HH:MM:SS.mmm
export function formatTimecode(time = 0) {
  const r = { h: '00', m: '00', s: '00', ms: '000' }
  r.ms = (time % 1).toFixed(3).substring(2)

  const t = Math.trunc(time)
  if (t < 60) {
    r.s = t < 10 ? `0${t}` : `${t}`
  } else if (t < 3600) {
    const min = Math.floor(t / 60)
    const sec = t - min * 60
    r.m = min < 10 ? `0${min}` : `${min}`
    r.s = sec < 10 ? `0${sec}` : `${sec}`
  } else {
    const hour = Math.floor(t / 3600)
    const min = Math.floor((t - hour * 3600) / 60)
    const sec = t - hour * 3600 - min * 60
    r.h = hour < 10 ? `0${hour}` : `${hour}`
    r.m = min < 10 ? `0${min}` : `${min}`
    r.s = sec < 10 ? `0${sec}` : `${sec}`
  }

  return `${r.h}:${r.m}:${r.s}.${r.ms}`
}
