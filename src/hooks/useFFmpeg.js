import { useCallback, useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

// Self-hosted core (copied into public/ffmpeg) so nothing is fetched from a
// third-party CDN and processing works fully offline after first load.
const CORE_BASE = `${window.location.origin}/ffmpeg`

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
    async (clips) => {
      const ffmpeg = ffmpegRef.current ?? (await load())
      setError(null)
      setProgress(0)

      const written = []
      try {
        const trimmedNames = []

        for (let i = 0; i < clips.length; i++) {
          const clip = clips[i]
          setStatusText(`Trimming clip ${i + 1} of ${clips.length}…`)
          const inputName = `in${i}.${extensionOf(clip.file.name)}`
          const trimmedName = `trim${i}.mp4`

          await ffmpeg.writeFile(inputName, await fetchFile(clip.file))
          written.push(inputName)

          await ffmpeg.exec([
            '-ss', String(clip.inPoint),
            '-to', String(clip.outPoint),
            '-i', inputName,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-c:a', 'aac',
            trimmedName,
          ])
          written.push(trimmedName)
          trimmedNames.push(trimmedName)

          // Free the (possibly large) source file from the virtual FS now
          // that the trimmed copy exists.
          await ffmpeg.deleteFile(inputName)
          written.splice(written.indexOf(inputName), 1)
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
