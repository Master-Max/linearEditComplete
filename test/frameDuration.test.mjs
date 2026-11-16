import test from 'node:test'
import assert from 'node:assert/strict'
import { refineFrameDuration } from '../src/lib/frameDuration.js'

function estimateFrom(gaps) {
  return gaps.reduce((estimate, gap) => refineFrameDuration(estimate, gap), null)
}

test('settles on one frame even when most gaps skipped frames (FF)', () => {
  // 24fps at 4x on a 60Hz screen: mostly 1-2 frame gaps, in any order.
  assert.equal(estimateFrom([2 / 24, 2 / 24, 1 / 24, 2 / 24]), 1 / 24)
})

test('ignores seeks, stalls, repeats and backward jumps', () => {
  assert.equal(estimateFrom([0, 1e-6, 3.2, -0.5, NaN, 1 / 25]), 1 / 25)
  assert.equal(estimateFrom([12, -1]), null)
})
