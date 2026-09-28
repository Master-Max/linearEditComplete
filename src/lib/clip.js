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

// Resolves an absolute time on a track (clips laid end to end from 0) to the
// clip under it and how far into that clip it falls. Returns null past the
// track's end - an audio track shorter than the video track just goes
// silent from there, rather than clamping to its last clip.
export function locateOnTrack(clips, time) {
  let start = 0
  for (let index = 0; index < clips.length; index++) {
    const length = clipLength(clips[index])
    if (time < start + length) {
      return { index, clip: clips[index], offset: Math.max(0, time - start) }
    }
    start += length
  }
  return null
}
