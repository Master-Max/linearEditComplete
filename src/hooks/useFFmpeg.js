import { useCallback, useRef, useState } from 'react'
import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'
import { buildFitFilter } from '../lib/resolution'
import { clipLength, totalLength } from '../lib/clip'
import { buildIntraProxy, encodeVideoTrack, isWebCodecsTranscodeSupported } from '../lib/webcodecsTranscode'

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

// Every exported segment's audio is resampled to this one format, so
// segments from sources recorded at different rates or channel counts can
// still be joined with a stream-copy concat (which can't convert anything).
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_FORMAT_FILTER = `aresample=${AUDIO_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo`

// ffmpeg.wasm has no ffprobe, but `ffmpeg -i file` with no output still
// prints the input's stream list before erroring out on the missing
// output - so scan that log for an audio stream. The non-zero exit is
// expected here, not a failure.
async function probeHasAudio(ffmpeg, inputName) {
  let found = false
  const onLog = ({ message }) => {
    if (/Stream #\d+:\d+.*: Audio:/.test(message)) found = true
  }
  ffmpeg.on('log', onLog)
  try {
    await ffmpeg.exec(['-hide_banner', '-i', inputName])
  } finally {
    ffmpeg.off('log', onLog)
  }
  return found
}

// Joins already-uniform segments with the concat demuxer (stream copy, no
// re-encode), tracking every file it creates in `written` for cleanup.
async function concatSegments(ffmpeg, names, listName, outputName, written) {
  await ffmpeg.writeFile(listName, names.map((name) => `file '${name}'`).join('\n'))
  written.push(listName)
  await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', listName, '-c', 'copy', outputName])
  written.push(outputName)
}

let nextPreviewId = 1

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
    async (clips, { width, height, fitMode = 'letterbox', audioClips = [], keepClipAudio = true } = {}) => {
      const ffmpeg = ffmpegRef.current ?? (await load())
      setError(null)
      setProgress(0)

      const written = []
      // The same source can be cut into multiple timeline clips (e.g. three
      // highlights pulled from one long recording), or feed both tracks at
      // once (a video's own sound lifted onto the audio track), so write
      // each unique source into the virtual FS once and reuse it, rather
      // than re-reading and re-writing the whole file per clip.
      const inputNames = new Map() // sourceId -> virtual FS filename
      const hasAudio = new Map() // sourceId -> whether it has an audio stream
      const remainingUses = new Map() // sourceId -> clips still needing it
      for (const clip of [...clips, ...audioClips]) {
        remainingUses.set(clip.sourceId, (remainingUses.get(clip.sourceId) ?? 0) + 1)
      }

      async function inputFor(clip) {
        let inputName = inputNames.get(clip.sourceId)
        if (!inputName) {
          inputName = `src${clip.sourceId}.${extensionOf(clip.file.name)}`
          await ffmpeg.writeFile(inputName, await fetchFile(clip.file))
          inputNames.set(clip.sourceId, inputName)
          written.push(inputName)
          hasAudio.set(clip.sourceId, await probeHasAudio(ffmpeg, inputName))
        }
        return inputName
      }

      // Free a source from the virtual FS once every clip referencing it
      // (on either track) has been trimmed, not eagerly per-clip.
      async function releaseInput(clip) {
        const remaining = remainingUses.get(clip.sourceId) - 1
        remainingUses.set(clip.sourceId, remaining)
        if (remaining === 0) {
          const inputName = inputNames.get(clip.sourceId)
          await ffmpeg.deleteFile(inputName)
          written.splice(written.indexOf(inputName), 1)
        }
      }

      // The audio half of a trim's filtergraph: the source's own first
      // audio stream, or generated silence when there isn't one (or its
      // sound is being dropped). Every segment coming out the same way -
      // always exactly one stereo 48kHz stream - is what lets the final
      // stream-copy concat join them: before this, one silent source on an
      // otherwise-audible timeline gave that segment no audio stream at
      // all, and concat either failed or dropped sound from there on.
      function audioChain(clip, useSourceAudio) {
        return useSourceAudio && hasAudio.get(clip.sourceId)
          ? `[0:a:0]${AUDIO_FORMAT_FILTER}[a]`
          : `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo[a]`
      }

      // No video clips: the audio track is exported on its own, as M4A.
      const audioOnly = clips.length === 0

      // Trims each clip to WAV and joins them, sample-exact - WAV rather
      // than AAC because every AAC segment carries its own encoder priming,
      // which a stream-copy concat would turn into a tiny gap at each cut.
      // `useSourceAudio` false gives exact-length silence per clip instead.
      async function buildAudioTrack(trackClips, prefix, outputName, useSourceAudio, label) {
        const names = []
        for (let i = 0; i < trackClips.length; i++) {
          const clip = trackClips[i]
          setStatusText(`${label} ${i + 1} of ${trackClips.length}…`)
          const trimmedName = `${prefix}${i}.wav`
          const inputName = await inputFor(clip)
          await ffmpeg.exec([
            '-i', inputName,
            '-filter_complex', audioChain(clip, useSourceAudio),
            '-map', '[a]',
            '-ss', String(clip.inPoint), '-t', String(clipLength(clip)),
            '-c:a', 'pcm_s16le',
            trimmedName,
          ])
          written.push(trimmedName)
          names.push(trimmedName)
          await releaseInput(clip)
        }
        await concatSegments(ffmpeg, names, `${prefix}_list.txt`, outputName, written)
      }

      try {
        if (audioOnly && audioClips.length === 0) throw new Error('Nothing to export - the timeline is empty')

        // Video on WebCodecs first (see webcodecsTranscode.js) - the GPU's
        // encoder where there is one, native code regardless. Any failure
        // (no H.264 encoder, a source mp4box can't demux, ...) drops back to
        // the all-ffmpeg path below, which handles everything.
        let webcodecsVideo = null
        let fallbackReason = null
        if (!audioOnly) {
          if (isWebCodecsTranscodeSupported()) {
            setStatusText('Encoding video with WebCodecs…')
            try {
              webcodecsVideo = await encodeVideoTrack(clips, { width, height, fitMode, onProgress: setProgress })
            } catch (err) {
              console.warn('WebCodecs export failed, falling back to ffmpeg.wasm', err)
              fallbackReason = err?.message || String(err)
              setProgress(0)
            }
          } else {
            fallbackReason = 'this browser has no WebCodecs video encoder'
          }
        }

        let outputName
        let videoEngine = null
        let engineDetail = null

        if (audioOnly) {
          await buildAudioTrack(audioClips, 'atrim', 'audio_track.wav', true, 'Trimming audio clip')
          setStatusText('Encoding audio…')
          await ffmpeg.exec(['-i', 'audio_track.wav', '-c:a', 'aac', '-b:a', '192k', 'output.m4a'])
          written.push('output.m4a')
          outputName = 'output.m4a'
        } else if (webcodecsVideo) {
          videoEngine = webcodecsVideo.hardware ? 'gpu' : 'webcodecs'
          engineDetail = webcodecsVideo.detail
          await ffmpeg.writeFile('wc_video.mp4', new Uint8Array(await webcodecsVideo.blob.arrayBuffer()))
          written.push('wc_video.mp4')

          // Audio inputs after the video (input 0): the clips' own sound,
          // cut to exactly the same lengths the video was, then the audio
          // track - each only when it's in use.
          const inputs = ['-i', 'wc_video.mp4']
          let clipAudio = null
          let bed = null
          if (keepClipAudio) {
            await buildAudioTrack(clips, 'vatrim', 'clip_audio.wav', true, 'Cutting clip audio')
            inputs.push('-i', 'clip_audio.wav')
            clipAudio = `[${inputs.length / 2 - 1}:a]`
          }
          if (audioClips.length > 0) {
            await buildAudioTrack(audioClips, 'atrim', 'audio_track.wav', true, 'Trimming audio clip')
            inputs.push('-i', 'audio_track.wav')
            bed = `[${inputs.length / 2 - 1}:a]`
          }
          // Same mixing rules as the ffmpeg path: amix without
          // normalization, the audio track padded/cut to the video's length.
          let audioGraph
          if (clipAudio && bed) {
            audioGraph = `${bed}apad[bed];${clipAudio}[bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`
          } else if (clipAudio) {
            audioGraph = `${clipAudio}anull[a]`
          } else if (bed) {
            audioGraph = `${bed}apad[a]`
          } else {
            audioGraph = `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo[a]`
          }

          setStatusText('Adding audio…')
          await ffmpeg.exec([
            ...inputs,
            '-filter_complex', audioGraph,
            '-map', '0:v', '-map', '[a]',
            '-t', String(totalLength(clips)),
            '-c:v', 'copy', '-c:a', 'aac',
            'output.mp4',
          ])
          written.push('output.mp4')
          outputName = 'output.mp4'
        } else {
          videoEngine = 'ffmpeg'
          const trimmedNames = []
          for (let i = 0; i < clips.length; i++) {
            const clip = clips[i]
            setStatusText(`Trimming clip ${i + 1} of ${clips.length}…`)
            const trimmedName = `trim${i}.mp4`
            const inputName = await inputFor(clip)

            // Normalize every clip to the project resolution before concat: the
            // final join uses stream copy, which requires identical encoded
            // dimensions across every segment or it fails/corrupts the output.
            const videoFilter = width && height ? buildFitFilter(fitMode, width, height) : 'null'

            // -ss after -i is "accurate" (output-side) seeking: ffmpeg decodes
            // from the start of the input up to inPoint before writing
            // anything, rather than fast-seeking the demuxer to the nearest
            // keyframe. Slower on long sources, but it's what fixes audible
            // A/V drift right at cut points - fast input seeking can let the
            // video and audio streams snap to slightly different actual
            // timestamps. -t (duration) is used instead of -to (absolute end
            // time) because -to's meaning shifts once -ss becomes an output
            // option; duration has no such ambiguity. It's also what bounds
            // anullsrc, which would otherwise generate silence forever.
            await ffmpeg.exec([
              '-i', inputName,
              '-filter_complex', `[0:v:0]${videoFilter}[v];${audioChain(clip, keepClipAudio)}`,
              '-map', '[v]', '-map', '[a]',
              '-ss', String(clip.inPoint), '-t', String(clipLength(clip)),
              '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac',
              trimmedName,
            ])
            written.push(trimmedName)
            trimmedNames.push(trimmedName)
            await releaseInput(clip)
          }

          setStatusText('Joining clips…')
          await concatSegments(ffmpeg, trimmedNames, 'concat_list.txt', 'joined.mp4', written)
          outputName = 'joined.mp4'

          if (audioClips.length > 0) {
            await buildAudioTrack(audioClips, 'atrim', 'audio_track.wav', true, 'Trimming audio clip')
            setStatusText('Mixing audio track…')
            // The video track decides the export's length: apad lets an audio
            // track shorter than the video run out into silence instead of
            // ending the output early, and -t cuts one that's longer.
            // Mixing uses amix with normalize=0 so neither side is attenuated -
            // amix's default scales each input by 1/N, which would halve the
            // clips' own sound just for adding a music bed under it.
            const mix = keepClipAudio
              ? '[1:a]apad[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]'
              : '[1:a]apad[a]'
            await ffmpeg.exec([
              '-i', 'joined.mp4',
              '-i', 'audio_track.wav',
              '-filter_complex', mix,
              '-map', '0:v', '-map', '[a]',
              '-t', String(totalLength(clips)),
              '-c:v', 'copy', '-c:a', 'aac',
              'output.mp4',
            ])
            written.push('output.mp4')
            outputName = 'output.mp4'
          }
        }

        const data = await ffmpeg.readFile(outputName)
        const blob = new Blob([data.buffer], { type: audioOnly ? 'audio/mp4' : 'video/mp4' })
        return {
          url: URL.createObjectURL(blob),
          kind: audioOnly ? 'audio' : 'video',
          videoEngine,
          engineDetail,
          fallbackReason: videoEngine === 'ffmpeg' ? fallbackReason : null,
        }
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
  //
  // Tries WebCodecs first (see buildIntraProxy in webcodecsTranscode.js):
  // hardware decode/encode where available, and native code either way -
  // minutes of ffmpeg.wasm work typically becomes seconds. Resolves to
  // { blob, engine, fallbackReason }, engine being 'gpu' (hardware decode
  // and encode), 'webcodecs' (the browser's native software codecs) or
  // 'ffmpeg'; fallbackReason says why it's 'ffmpeg', for the UI.
  const transcodeToIntraProxy = useCallback(
    async (file, { onProgress } = {}) => {
      let fallbackReason = 'this browser has no WebCodecs video encoder'
      if (isWebCodecsTranscodeSupported()) {
        try {
          const result = await buildIntraProxy(file, { maxWidth: PROXY_MAX_WIDTH, onProgress })
          return { blob: result.blob, engine: result.hardware ? 'gpu' : 'webcodecs', detail: result.detail }
        } catch (err) {
          console.warn('WebCodecs scrub proxy failed, falling back to ffmpeg.wasm', err)
          fallbackReason = err?.message || String(err)
          onProgress?.(0)
        }
      }

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
        return { blob: new Blob([data.buffer], { type: 'video/mp4' }), engine: 'ffmpeg', fallbackReason }
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

  // Converts an audio file the browser can't play natively (see
  // loadVideoSource's makePlayable) to `format` - 'm4a' (AAC) or 'wav'
  // (PCM) - for preview only; export always reads the original. Like
  // transcodeToIntraProxy, this deliberately leaves the shared progress/
  // status/error state alone, and uses its own FS names (numbered, since
  // several files can be dropped at once) so it can't collide with a
  // proxy transcode or export queued on the same instance.
  const transcodeAudioForPreview = useCallback(
    async (file, format) => {
      const ffmpeg = ffmpegRef.current ?? (await load())
      const n = nextPreviewId++
      const inputName = `preview-src${n}.${extensionOf(file.name)}`
      const outputName = `preview-out${n}.${format}`
      const codecArgs = format === 'wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '192k']
      try {
        await ffmpeg.writeFile(inputName, await fetchFile(file))
        const code = await ffmpeg.exec(['-i', inputName, '-vn', ...codecArgs, outputName])
        if (code !== 0) throw new Error(`ffmpeg couldn't convert ${file.name} (exit code ${code})`)
        const data = await ffmpeg.readFile(outputName)
        return new Blob([data.buffer], { type: format === 'wav' ? 'audio/wav' : 'audio/mp4' })
      } finally {
        await Promise.all([
          ffmpeg.deleteFile(inputName).catch(() => {}),
          ffmpeg.deleteFile(outputName).catch(() => {}),
        ])
      }
    },
    [load],
  )

  return {
    loaded,
    loading,
    progress,
    statusText,
    error,
    load,
    exportSequence,
    transcodeToIntraProxy,
    transcodeAudioForPreview,
  }
}
