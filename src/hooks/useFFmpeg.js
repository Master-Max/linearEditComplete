import { useCallback, useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { buildFitFilter } from '../lib/resolution'
import { clipLength } from '../lib/clip'

// Self-hosted core (copied into public/ffmpeg) so nothing is fetched from a
// third-party CDN and processing works fully offline after first load.
// Resolved relative to the page (not window.location.origin) so it still
// works when the app is served from a subpath, e.g. GitHub Pages project
// sites at username.github.io/repo-name/.
const CORE_BASE = `${import.meta.env.BASE_URL}ffmpeg`

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

  const load = useCallback(async () => {
    if (ffmpegRef.current) return ffmpegRef.current
    setLoading(true)
    setError(null)
    try {
      const ffmpeg = new FFmpeg()
      ffmpeg.on('progress', ({ progress: p }) => {
        setProgress(Math.min(1, Math.max(0, p)))
      })
      // The worker itself runs from a blob URL, and it can't cross into a
      // same-origin-but-different-URL script via a plain <script>/import
      // fetch from within that scope — so the core files must be pulled in
      // as blob URLs too, even though they're already same-origin.
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      ])
      await ffmpeg.load({ coreURL, wasmURL })
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

  return { loaded, loading, progress, statusText, error, load, exportSequence }
}
