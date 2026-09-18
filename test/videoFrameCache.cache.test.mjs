import assert from 'node:assert/strict'
import test from 'node:test'

import { VideoFrameCache } from '../src/lib/videoFrameCache.js'

// The frame-lookup and prefetch-direction logic below is plain array/index
// arithmetic with no decoder or file involved, so - like the demux tests -
// it's exercised directly against a bare VideoFrameCache.prototype object
// carrying only the fields each method actually reads.
function bareCache(fields) {
  return Object.assign(Object.create(VideoFrameCache.prototype), fields)
}

test('_bestCachedFrame finds the largest cached timestamp at or before target via binary search', () => {
  const frames = new Map([
    [1000, 'frame@1000'],
    [3000, 'frame@3000'],
    [7000, 'frame@7000'],
  ])
  const cache = bareCache({ cachedTimestampsUs: [1000, 3000, 7000], frames })

  assert.equal(cache._bestCachedFrame(7000), 'frame@7000', 'exact match on the last entry')
  assert.equal(cache._bestCachedFrame(6999), 'frame@3000', 'falls back to the previous entry')
  assert.equal(cache._bestCachedFrame(999), null, 'nothing cached before the first entry')
  assert.equal(cache._bestCachedFrame(999999), 'frame@7000', 'clamps to the last entry when target is past it')
})

test('_bestCachedFrame skips gaps left by evicted GOPs, not just the nearest neighbour in insertion order', () => {
  // Simulates two retained GOPs with an evicted one in between - the cache
  // must still binary-search past the gap to 3000, not fall through to null
  // or to something evicted.
  const frames = new Map([
    [1000, 'frame@1000'],
    [3000, 'frame@3000'],
    // 5000 was here and got evicted.
    [9000, 'frame@9000'],
  ])
  const cache = bareCache({ cachedTimestampsUs: [1000, 3000, 9000], frames })
  assert.equal(cache._bestCachedFrame(6000), 'frame@3000')
})

test('_earliestCachedFrame returns the lowest cached timestamp, or null when nothing is cached', () => {
  assert.equal(bareCache({ cachedTimestampsUs: [], frames: new Map() })._earliestCachedFrame(), null)

  const frames = new Map([
    [5000, 'frame@5000'],
    [2000, 'frame@2000'],
  ])
  const cache = bareCache({ cachedTimestampsUs: [2000, 5000], frames })
  assert.equal(cache._earliestCachedFrame(), 'frame@2000')
})

test('_insertCachedTimestamp/_removeCachedTimestamp keep cachedTimestampsUs sorted and in sync with frames', () => {
  const cache = bareCache({ cachedTimestampsUs: [], frames: new Map() })
  for (const ts of [5000, 1000, 3000, 4000, 2000]) {
    cache.frames.set(ts, `frame@${ts}`)
    cache._insertCachedTimestamp(ts)
  }
  assert.deepEqual(cache.cachedTimestampsUs, [1000, 2000, 3000, 4000, 5000])

  cache.frames.delete(3000)
  cache._removeCachedTimestamp(3000)
  assert.deepEqual(cache.cachedTimestampsUs, [1000, 2000, 4000, 5000])

  // Removing a timestamp that was never inserted (e.g. a double-evict) is a
  // no-op rather than corrupting the array.
  cache._removeCachedTimestamp(3000)
  assert.deepEqual(cache.cachedTimestampsUs, [1000, 2000, 4000, 5000])
})

// _prefetchAround is what background-decodes the GOPs neighbouring wherever
// REW/jog just asked for a frame. With a travel direction known, it should
// only chase the neighbour actually ahead of travel - chasing both wastes
// decode-queue time on the side REW is moving away from (see the comment on
// _prefetchAround in videoFrameCache.js).
function directionTestCache(requested) {
  return bareCache({
    windowRadiusGops: 1,
    keyframeIndices: [0, 10, 20],
    frames: new Map(),
    approximateFrameBytes: 1,
    _ensureGopDecoded(gopStart) {
      requested.push(gopStart)
      return Promise.resolve()
    },
  })
}

test('_prefetchAround requests both neighbours when direction is unknown', () => {
  const requested = []
  directionTestCache(requested)._prefetchAround(10, 0)
  assert.deepEqual(requested.sort(), [0, 20])
})

test('_prefetchAround skips the trailing neighbour while moving forward', () => {
  const requested = []
  directionTestCache(requested)._prefetchAround(10, 1)
  assert.deepEqual(requested, [20])
})

test('_prefetchAround skips the leading neighbour while moving backward (REW)', () => {
  const requested = []
  directionTestCache(requested)._prefetchAround(10, -1)
  assert.deepEqual(requested, [0])
})
