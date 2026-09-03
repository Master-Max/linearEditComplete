// libx264 requires even width/height.
function evenize(n) {
  return n % 2 === 0 ? n : n - 1
}

export function resolutionsMatch(a, b) {
  return a?.width === b?.width && a?.height === b?.height
}

// Builds an ffmpeg -vf filter that normalizes any input to width x height,
// either by padding with black bars (letterbox, preserves the whole frame)
// or by scaling to fill and cropping the overflow (crop, can cut content).
export function buildFitFilter(fitMode, width, height) {
  const w = evenize(width)
  const h = evenize(height)
  if (fitMode === 'crop') {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`
}

export const RESOLUTION_PRESETS = [
  { label: '1920 × 1080 (Full HD)', width: 1920, height: 1080 },
  { label: '1280 × 720 (HD)', width: 1280, height: 720 },
  { label: '3840 × 2160 (4K)', width: 3840, height: 2160 },
  { label: '1080 × 1920 (Vertical HD)', width: 1080, height: 1920 },
]
