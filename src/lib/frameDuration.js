// Frame duration for jog when there's no sample table to ask (the HTML5
// path - see ClassicPlayerDeck's jog()). <video> doesn't expose a frame
// rate, but requestVideoFrameCallback hands over each presented frame's
// mediaTime, and the smallest gap ever seen between two of them is one
// frame: playback can skip frames (FF at 4x usually does), which only makes
// a gap bigger, never smaller.

export const DEFAULT_FRAME_DURATION = 1 / 30

// Gaps outside this range aren't a frame step: under 1/240s is timestamp
// noise or a repeated frame, over 1/5s is a seek or a stall.
const MIN_GAP = 1 / 240
const MAX_GAP = 1 / 5

// Returns the new estimate given the previous one (null until the first
// usable gap) and the mediaTime gap between two presented frames.
export function refineFrameDuration(estimate, gapSeconds) {
  if (!(gapSeconds >= MIN_GAP && gapSeconds <= MAX_GAP)) return estimate
  return estimate == null ? gapSeconds : Math.min(estimate, gapSeconds)
}
