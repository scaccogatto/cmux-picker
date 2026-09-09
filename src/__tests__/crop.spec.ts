// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { cropRegion } from '../extension/crop.ts'

describe('cropRegion', () => {
  const viewport = { w: 1000, h: 800 }
  const image = { w: 2000, h: 1600 }

  it('scale 1: element well inside image with margin', () => {
    // Scale 1 because viewport.w = image.w
    const result = cropRegion(
      { x: 100, y: 100, w: 100, h: 100 },
      40,
      { w: 1000, h: 800 },
      { w: 1000, h: 800 }
    )
    // x = (100 - 40) * 1 = 60, y = 60
    // w = (100 + 80) * 1 = 180, h = 180
    expect(result).toEqual({ sx: 60, sy: 60, sw: 180, sh: 180 })
  })

  it('scale 2: image twice the viewport size doubles everything', () => {
    const result = cropRegion(
      { x: 100, y: 100, w: 100, h: 100 },
      40,
      { w: 1000, h: 800 },
      { w: 2000, h: 1600 }
    )
    // Scale = 2000 / 1000 = 2
    // x = (100 - 40) * 2 = 120, y = 120
    // w = (100 + 80) * 2 = 360, h = 360
    expect(result).toEqual({ sx: 120, sy: 120, sw: 360, sh: 360 })
  })

  it('element at top-left corner clamps to 0', () => {
    const result = cropRegion(
      { x: 10, y: 10, w: 100, h: 100 },
      40,
      viewport,
      image
    )
    // Scale = 2
    // x = (10 - 40) * 2 = -60, clamped to 0
    // y = (10 - 40) * 2 = -60, clamped to 0
    // w = (100 + 80) * 2 = 360, sw = min(360, 2000 - 0) = 360
    // h = (100 + 80) * 2 = 360, sh = min(360, 1600 - 0) = 360
    expect(result).toEqual({ sx: 0, sy: 0, sw: 360, sh: 360 })
  })

  it('tiny element grows to at least 16 px', () => {
    const result = cropRegion(
      { x: 100, y: 100, w: 2, h: 2 },
      1,
      { w: 1000, h: 800 },
      { w: 2000, h: 1600 }
    )
    // Scale = 2
    // x = (100 - 1) * 2 = 198, y = 198
    // w = (2 + 2) * 2 = 8, clamped to min 16 = 16
    // h = (2 + 2) * 2 = 8, clamped to min 16 = 16
    expect(result).toEqual({ sx: 198, sy: 198, sw: 16, sh: 16 })
  })

  it('huge element caps at 4000 px', () => {
    const result = cropRegion(
      { x: 100, y: 100, w: 5000, h: 5000 },
      100,
      { w: 1000, h: 800 },
      { w: 10000, h: 10000 }
    )
    // Scale = 10000 / 1000 = 10
    // x = (100 - 100) * 10 = 0
    // y = (100 - 100) * 10 = 0
    // w = (5000 + 200) * 10 = 52000, clamped to max 4000 = 4000
    // h = (5000 + 200) * 10 = 52000, clamped to max 4000 = 4000
    expect(result).toEqual({ sx: 0, sy: 0, sw: 4000, sh: 4000 })
  })

  it('element exceeding right edge narrows sw to fit', () => {
    const result = cropRegion(
      { x: 1900, y: 100, w: 100, h: 100 },
      40,
      viewport,
      image
    )
    // Scale = 2
    // x = (1900 - 40) * 2 = 3720, y = 120
    // w = (100 + 80) * 2 = 360
    // h = (100 + 80) * 2 = 360
    // sx = min(3720, 2000 - 1) = 1999
    // sw = clamp(360, 16, 4000) = 360, then min(360, 2000 - 1999) = 1
    expect(result).toEqual({ sx: 1999, sy: 120, sw: 1, sh: 360 })
  })

  it('element exceeding bottom edge narrows sh to fit', () => {
    const result = cropRegion(
      { x: 100, y: 1550, w: 100, h: 100 },
      40,
      viewport,
      image
    )
    // Scale = 2
    // x = (100 - 40) * 2 = 120
    // y = (1550 - 40) * 2 = 3020, clamped to 1600 - 1 = 1599
    // w = (100 + 80) * 2 = 360
    // h = (100 + 80) * 2 = 360
    // sy = 1599
    // sh = clamp(360, 16, 4000) = 360, then min(360, 1600 - 1599) = 1
    expect(result).toEqual({ sx: 120, sy: 1599, sw: 360, sh: 1 })
  })

  it('viewport.w === 0 uses scale 1', () => {
    const result = cropRegion(
      { x: 100, y: 100, w: 100, h: 100 },
      40,
      { w: 0, h: 800 },
      { w: 2000, h: 1600 }
    )
    // Scale = 1 (fallback for viewport.w === 0)
    // x = (100 - 40) * 1 = 60
    // y = (100 - 40) * 1 = 60
    // w = (100 + 80) * 1 = 180
    // h = (100 + 80) * 1 = 180
    expect(result).toEqual({ sx: 60, sy: 60, sw: 180, sh: 180 })
  })

  it('rounding applied to computed coordinates', () => {
    const result = cropRegion(
      { x: 100.4, y: 100.6, w: 100.1, h: 100.9 },
      40.5,
      { w: 1000, h: 800 },
      { w: 2000, h: 1600 }
    )
    // Scale = 2
    // x = (100.4 - 40.5) * 2 = 119.8, rounds to 120
    // y = (100.6 - 40.5) * 2 = 120.2, rounds to 120
    // w = (100.1 + 81) * 2 = 362.2, rounds to 362
    // h = (100.9 + 81) * 2 = 363.8, rounds to 364
    expect(result).toEqual({ sx: 120, sy: 120, sw: 362, sh: 364 })
  })

  it('ensures sw and sh are at least 1', () => {
    // Very small element and very large margin relative to scale
    const result = cropRegion(
      { x: 0, y: 0, w: 1, h: 1 },
      200,
      { w: 1000, h: 800 },
      { w: 1000, h: 800 }
    )
    // Scale = 1
    // x = (0 - 200) * 1 = -200, clamped to 0
    // y = (0 - 200) * 1 = -200, clamped to 0
    // w = (1 + 400) * 1 = 401, clamped to 401
    // h = (1 + 400) * 1 = 401, clamped to 401
    expect(result.sw).toBeGreaterThanOrEqual(1)
    expect(result.sh).toBeGreaterThanOrEqual(1)
  })
})
