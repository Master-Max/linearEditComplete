let nextId = 1

export function createClip({ sourceId, sourceName, file, url, duration, inPoint = 0, outPoint }) {
  return {
    id: nextId++,
    sourceId,
    sourceName,
    file,
    url,
    duration,
    inPoint,
    outPoint: outPoint ?? duration,
  }
}

export function clipLength(clip) {
  return Math.max(0, clip.outPoint - clip.inPoint)
}

export function totalLength(clips) {
  return clips.reduce((sum, clip) => sum + clipLength(clip), 0)
}
