export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00.0'
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`
}
