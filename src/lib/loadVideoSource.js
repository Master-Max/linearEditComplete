let nextSourceId = 1

export function isAudioFile(file) {
  return file.type.startsWith('audio/')
}

export function isMediaFile(file) {
  return file.type.startsWith('video/') || isAudioFile(file)
}

export async function loadVideoSource(file) {
  // A file picked via a mobile OS file picker (Android's Storage Access
  // Framework in particular) only grants read access for the current
  // interaction. URL.createObjectURL(file) can stream lazily from that
  // live handle rather than copying bytes, so if the browser gets
  // backgrounded and the OS revokes the grant, the blob URL goes dark —
  // the clip stays listed (its metadata is already in JS state) but the
  // video element shows broken/blank. Reading the bytes into memory right
  // now, while the grant is still fresh, decouples playback and export
  // from that handle for the rest of the session.
  const buffer = await file.arrayBuffer()
  const materialized = new File([buffer], file.name, { type: file.type })
  const url = URL.createObjectURL(materialized)

  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.src = url
    video.onloadedmetadata = () => {
      resolve({
        id: nextSourceId++,
        file: materialized,
        url,
        name: file.name,
        // Audio-only files load through the same <video> element (it plays
        // audio just fine, and reports 0x0 dimensions), but can only go on
        // the audio track and never count toward the project resolution.
        kind: isAudioFile(file) ? 'audio' : 'video',
        duration: video.duration,
        width: video.videoWidth,
        height: video.videoHeight,
      })
    }
    // Without this a file the browser can't decode (more likely now that
    // audio formats are accepted too) left the promise pending forever.
    video.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error(`Can't play ${file.name} in this browser`))
    }
  })
}
