let nextSourceId = 1

// Browsers don't always give a file a useful MIME type: an empty string is
// common for .flac/.opus/.aiff/.mkv on Windows and Linux, and .ogg often
// comes through as application/ogg. So the extension is the fallback
// whenever the type isn't audio/* or video/*.
const AUDIO_EXTENSIONS = [
  'mp3', 'wav', 'wave', 'm4a', 'm4b', 'aac', 'flac', 'ogg', 'oga', 'opus', 'weba',
  'aif', 'aiff', 'aifc', 'caf', 'wma', 'amr', 'ac3', 'mka', 'alac',
]
const VIDEO_EXTENSIONS = [
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', '3gp', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'ogv', 'flv',
]

// For <input accept>: some OS pickers filter strictly by what's listed here,
// and don't map every extension above onto audio/* or video/*.
export const MEDIA_ACCEPT = [
  'video/*',
  'audio/*',
  ...[...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS].map((ext) => `.${ext}`),
].join(',')

function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

export function isAudioFile(file) {
  if (file.type.startsWith('audio/')) return true
  if (file.type.startsWith('video/')) return false
  return AUDIO_EXTENSIONS.includes(extensionOf(file.name))
}

export function isMediaFile(file) {
  return (
    file.type.startsWith('video/') ||
    isAudioFile(file) ||
    VIDEO_EXTENSIONS.includes(extensionOf(file.name))
  )
}

// Resolves with the element's metadata once `url` loads, or rejects if the
// browser can't decode it.
function readMetadata(url, name) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.src = url
    video.onloadedmetadata = () => {
      resolve({ duration: video.duration, width: video.videoWidth, height: video.videoHeight })
    }
    // Without this a file the browser can't decode left the promise
    // pending forever.
    video.onerror = () => reject(new Error(`Can't play ${name} in this browser`))
  })
}

// Formats `makePlayable` is asked for, in order, until one loads. AAC is
// compact and plays in every major browser; WAV is the fallback for builds
// without an AAC decoder (open-source Chromium, some Linux Firefox
// installs), since every browser plays PCM, at the cost of ~10MB a minute.
const PREVIEW_FORMATS = ['m4a', 'wav']

// `makePlayable(file, format)`, if given, is tried when the browser can't
// play an audio file itself (AIFF, WMA and AMR in Chrome, for example). It
// should resolve to a Blob of `file` converted to `format` (one of
// PREVIEW_FORMATS). The first conversion the browser can load becomes the
// source's preview `url`, while `file` stays the untouched original. Export reads `file` through ffmpeg, which decodes
// far more formats than the browser does, so the conversion only ever
// affects preview and never costs export a generation of quality.
export async function loadVideoSource(file, { makePlayable } = {}) {
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

  let url = URL.createObjectURL(materialized)
  let metadata
  try {
    metadata = await readMetadata(url, file.name)
  } catch (err) {
    URL.revokeObjectURL(url)
    if (!makePlayable || !isAudioFile(file)) throw err
    metadata = null
    for (const format of PREVIEW_FORMATS) {
      let converted
      try {
        converted = await makePlayable(materialized, format)
      } catch (convertErr) {
        // ffmpeg can't read it either, so it's not a format problem the
        // browser alone has - most likely a damaged or mislabeled file.
        console.warn(`Converting ${file.name} to ${format} failed`, convertErr)
        throw new Error(`${file.name} couldn't be read as audio - it may be damaged or not really a media file`)
      }
      url = URL.createObjectURL(converted)
      try {
        metadata = await readMetadata(url, file.name)
        break
      } catch {
        URL.revokeObjectURL(url)
      }
    }
    if (!metadata) throw err
  }

  return {
    id: nextSourceId++,
    file: materialized,
    url,
    name: file.name,
    // Audio loads through the same <video> element (it plays audio just
    // fine, and reports 0x0 dimensions), but can only go on the audio track
    // and never counts toward the project resolution. No picture at all
    // also counts as audio, which catches audio-only .mp4/.webm files that
    // arrive typed as video/*.
    kind: isAudioFile(file) || metadata.width === 0 ? 'audio' : 'video',
    duration: metadata.duration,
    width: metadata.width,
    height: metadata.height,
  }
}
