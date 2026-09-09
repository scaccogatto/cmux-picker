import type { Rect } from '../types.ts'

/**
 * Compute the region to crop from an image in device pixels.
 * Pure function: maps a CSS pixel rect with margin to image pixel coordinates.
 */
export function cropRegion(
  rect: Rect,
  margin: number,
  viewport: { w: number; h: number },
  image: { w: number; h: number }
): { sx: number; sy: number; sw: number; sh: number } {
  // Scale from CSS pixels (rect) to device pixels (image)
  const scale = viewport.w > 0 ? image.w / viewport.w : 1

  // Compute region bounds in image pixels
  const x = (rect.x - margin) * scale
  const y = (rect.y - margin) * scale
  const w = (rect.w + 2 * margin) * scale
  const h = (rect.h + 2 * margin) * scale

  // Helper: clamp value between min and max
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max))

  // Clamp start coordinates to image bounds
  const sx = clamp(Math.round(x), 0, Math.max(0, image.w - 1))
  const sy = clamp(Math.round(y), 0, Math.max(0, image.h - 1))

  // Clamp width to 16..4000, then ensure it fits in the image
  let sw = clamp(Math.round(w), 16, 4000)
  sw = Math.min(sw, Math.max(1, image.w - sx))

  // Clamp height to 16..4000, then ensure it fits in the image
  let sh = clamp(Math.round(h), 16, 4000)
  sh = Math.min(sh, Math.max(1, image.h - sy))

  return { sx, sy, sw, sh }
}

/**
 * Crop a screenshot data URL to a specific region and return base64 PNG.
 * Loads the image, computes the crop region, draws to canvas, and returns PNG base64.
 */
export async function cropDataUrl(
  dataUrl: string,
  rect: Rect,
  margin: number,
  viewport: { w: number; h: number }
): Promise<string> {
  // Create and load image
  const img = new Image()
  img.src = dataUrl
  await img.decode()

  // Compute crop region
  const { sx, sy, sw, sh } = cropRegion(rect, margin, viewport, {
    w: img.naturalWidth,
    h: img.naturalHeight,
  })

  // Create canvas and draw cropped region
  const canvas = document.createElement('canvas')
  canvas.width = sw
  canvas.height = sh

  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('Could not get canvas 2d context')

  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh)

  // Return PNG base64 (strip the data:image/png;base64, prefix)
  const dataUrlWithPrefix = canvas.toDataURL('image/png')
  const prefix = 'data:image/png;base64,'
  if (!dataUrlWithPrefix.startsWith(prefix)) {
    throw new Error('Unexpected canvas toDataURL format')
  }

  return dataUrlWithPrefix.slice(prefix.length)
}
