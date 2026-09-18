import { useCallback, useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { buildFitFilter } from '../lib/resolution'
import { clipLength } from '../lib/clip'

// Self-hosted cores (copied into public/ffmpeg and public/ffmpeg-mt) so
// nothing is fetched from a third-party CDN and processing works fully
// offline after first load. Resolved relative to the page (not
// window.location.origin) so it still works when the app is served from a
// subpath, e.g. GitHub Pages project sites at username.github.io/repo-name/.
const CORE_BASE = `${import.meta.env.BASE_URL}ffmpeg`
// Multi-threaded build of the same ffmpeg-core version - real transcode
// speedup (see TECHDEBT.md's "scrub-proxy transcode is single-threaded"
// entry for real-world numbers), but it needs SharedArrayBuffer, which only
// exists when the page is cross-origin isolated (COOP/COEP response
// headers). This app's current host, GitHub Pages, can't set those - see
// the same TECHDEBT.md entry for what hosting that can would take. Until
// then, isCrossOriginIsolated() below is always false here and load() just
// uses CORE_BASE, exactly as before this existed.
const CORE_MT_BASE = `${import.meta.env.BASE_URL}ffmpeg-mt`

function isCrossOriginIsolated() {
  return typeof window !== 'undefined' && window.crossOriginIsolated === true
}

// Widest the intra-frame scrub proxy (see transcodeToIntraProxy below) is
// allowed to be. The player deck's canvas only ever displays it at 480x270
// CSS pixels (classic.css), so anything wider than a couple of HiDPI
// multiples of that is pixels nobody sees - and every one of them costs
// transcode time, decode time, and retained-frame memory for REW/jog.
// Height follows via -2 (even, preserving aspect); never upscales a source
// already narrower than this.
const PROXY_MAX_WIDTH = 960

function extensionOf(filename) {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? 'mp4' : filename.slice(dot + 1)
}

export function useFFmpeg() {
  const ffmpegRef = useRef(null)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const [statusText, setStatusText] = useState('')
  const [error, setError] = useState(null)

  // Builds and loads one FFmpeg instance against `base`, registering the
  // shared progress listener. `workerFile`, when given, also fetches and
  // wires up ffmpeg-core.worker.js - the multi-threaded core's pthread
  // worker (see FFMessageLoadConfig.workerURL) - which the single-threaded
  // core doesn't have or need.
  //
  // The worker itself runs from a blob URL, and it can't cross into a
  // same-origin-but-different-URL script via a plain <script>/import fetch
  // from within that scope — so the core files must be pulled in as blob
  // URLs too, even though they're already same-origin.
  async function loadCore(base, { workerFile } = {}) {
    const ffmpeg = new FFmpeg()
    ffmpeg.on('progress', ({ progress: p }) => {
      setProgress(Math.min(1, Math.max(0, p)))
    })
    const urls = [
      toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    ]
    if (workerFile) urls.push(toBlobURL(`${base}/${workerFile}`, 'text/javascript'))
    const [coreURL, wasmURL, workerURL] = await Promise.all(urls)
    await ffmpeg.load(workerURL ? { coreURL, wasmURL, workerURL } : { coreURL, wasmURL })
    return ffmpeg
  }

  const load = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current
    setLoading(true)
    setError(null)
    try {
      let ffmpeg = null
      if (isCrossOriginIsolated()) {
        try {
          ffmpeg = await loadCore(CORE_MT_BASE, { workerFile: 'ffmpeg-core.worker.js' })
        } catch (err) {
          // Cross-origin isolated but the multi-threaded core still failed
          // to load (unexpected, but not a reason to fail outright) - fall
          // through to the single-threaded core below like any other
          // browser would.
          console.warn('Multi-threaded ffmpeg core failed to load, falling back to single-threaded', err)
        }
      }
      if (!ffmpeg) ffmpeg = await loadCore(CORE_BASE)

      ffmpegRef.current = ffmpeg
      setLoaded(true)
      return ffmpeg
    } catch (err) {
      setError(err)
      throw err
    } finally {
      setLoading(false)
    }
  }, [])

  const exportSequence = useCallback(
    async (clips, { width, height, fitMode = 'letterbox' } = {}) => {
      const ffmpeg = ffmpegRef.current ?? (await load())
      setError(null)
      setProgress(0)

      const written = []
      // The same source can be cut into multiple timeline clips (e.g. three
      // highlights pulled from one long recording), so write each unique
      // source into the virtual FS once and reuse it, rather than
      // re-reading and re-writing the whole file per clip.
      const inputNames = new Map() // sourceId -> virtual FS filename
      const remainingUses = new Map() // sourceId -> clips still needing it
      for (const clip of clips) {
        remainingUses.set(clip.sourceId, (remainingUses.get(clip.sourceId) ?? 0) + 1)
      }

      try {
        const trimmedNames = []

        for (let i = 0; i < clips.length; i++) {
          const clip = clips[i]
          setStatusText(`Trimming clip ${i + 1} of ${clips.length}…`)
          const trimmedName = `trim${i}.mp4`

          let inputName = inputNames.get(clip.sourceId)
          if (!inputName) {
            inputName = `src${clip.sourceId}.${extensionOf(clip.file.name)}`
            await ffmpeg.writeFile(inputName, await fetchFile(clip.file))
            inputNames.set(clip.sourceId, inputName)
            written.push(inputName)
          }

          // -ss after -i is "accurate" (output-side) seeking: ffmpeg decodes
          // from the start of the input up to inPoint before writing
          // anything, rather than fast-seeking the demuxer to the nearest
          // keyframe. Slower on long sources, but it's what fixes audible
          // A/V drift right at cut points - fast input seeking can let the
          // video and audio streams snap to slightly different actual
          // timestamps. -t (duration) is used instead of -to (absolute end
          // time) because -to's meaning shifts once -ss becomes an output
          // option; duration has no such ambiguity.
          const trimArgs = ['-i', inputName, '-ss', String(clip.inPoint), '-t', String(clipLength(clip))]
          // Normalize every clip to the project resolution before concat: the
          // final join uses stream copy, which requires identical encoded
          // dimensions across every segment or it fails/corrupts the output.
          if (width && height) {
            trimArgs.push('-vf', buildFitFilter(fitMode, width, height))
          }
          trimArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', trimmedName)

          await ffmpeg.exec(trimArgs)
          written.push(trimmedName)
          trimmedNames.push(trimmedName)

          // Free the source from the virtual FS once every clip referencing
          // it has been trimmed, not eagerly per-clip.
          const remaining = remainingUses.get(clip.sourceId) - 1
          remainingUses.set(clip.sourceId, remaining)
          if (remaining === 0) {
            await ffmpeg.deleteFile(inputName)
            written.splice(written.indexOf(inputName), 1)
          }
        }

        setStatusText('Joining clips…')
        const listContents = trimmedNames.map((name) => `file '${name}'`).join('\n')
        await ffmpeg.writeFile('concat_list.txt', listContents)
        written.push('concat_list.txt')

        await ffmpeg.exec([
          '-f', 'concat',
          '-safe', '0',
          '-i', 'concat_list.txt',
          '-c', 'copy',
          'output.mp4',
        ])
        written.push('output.mp4')

        const data = await ffmpeg.readFile('output.mp4')
        const blob = new Blob([data.buffer], { type: 'video/mp4' })
        return URL.createObjectURL(blob)
      } catch (err) {
        setError(err)
        throw err
      } finally {
        setStatusText('')
        await Promise.all(
          written.map((name) => ffmpeg.deleteFile(name).catch(() => {})),
        )
      }
    },
    [load],
  )

  // Transcodes `file`'s video track to an all-intra-frame (GOP-of-1) H.264
  // MP4 for VideoFrameCache to build its REW/jog frame cache from, instead
  // of the camera-original file. Every output frame is independently
  // decodable, so a "GOP" there is exactly one frame - the "decode the
  // whole GOP before showing anything" cost in getFrameAtOrBefore()
  // collapses from however long the source's own encoder made its GOPs
  // (real footage measured up to 480 frames - see TECHDEBT.md) to one,
  // regardless of source. See the "Transcode footage on load" entry in
  // TECHDEBT.md for the full rationale.
  //
  // -an: nothing that reads from this proxy plays audio - REW pauses
  // <video> and jog shows a single still frame, both already silent, and
  // PLAY/FF never touch this proxy at all (see startForwardCanvas in
  // ClassicPlayerDeck.jsx). Dropping the track shrinks an already-larger-
  // than-original file - intra frames don't compress against each other,
  // so even at a higher CRF than export uses this typically comes out
  // bigger than the source, not smaller.
  // -g 1 -bf 0: every frame is its own keyframe; no B-frames means no
  // reorder delay, so (unlike the camera-original) this proxy needs no
  // edit-list handling for its presentation timestamps to line up.
  // Deliberately not shared state (setProgress/setStatusText/setError) -
  // this runs in the background whenever a source loads, and shouldn't
  // make an unrelated Export click show a stale or confusing progress bar.
  // `onProgress`, if given, gets this call's own 0-1 ratio via a listener
  // scoped to this call alone (registered/unregistered around exec, not
  // left on the shared FFmpeg instance) - the caller's UI updates without
  // that instance's other listeners (e.g. exportSequence's) seeing it.
  const transcodeToIntraProxy = useCallback(
    async (file, { onProgress } = {}) => {
      const ffmpeg = ffmpegRef.current ?? (await load())
      const inputName = `proxy-src.${extensionOf(file.name)}`
      const outputName = 'proxy-out.mp4'
      const handleProgress = onProgress
        ? ({ progress: p }) => onProgress(Math.min(1, Math.max(0, p)))
        : null
      if (handleProgress) ffmpeg.on('progress', handleProgress)
      try {
        await ffmpeg.writeFile(inputName, await fetchFile(file))
        await ffmpeg.exec([
          '-i', inputName,
          '-an',
          '-vf', `scale='min(${PROXY_MAX_WIDTH},iw)':-2`,
          '-g', '1',
          '-bf', '0',
          '-pix_fmt', 'yuv420p',
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '28',
          outputName,
        ])
        const data = await ffmpeg.readFile(outputName)
        return new Blob([data.buffer], { type: 'video/mp4' })
      } finally {
        if (handleProgress) ffmpeg.off('progress', handleProgress)
        await Promise.all([
          ffmpeg.deleteFile(inputName).catch(() => {}),
          ffmpeg.deleteFile(outputName).catch(() => {}),
        ])
      }
    },
    [load],
  )

  return { loaded, loading, progress, statusText, error, load, exportSequence, transcodeToIntraProxy }
}
