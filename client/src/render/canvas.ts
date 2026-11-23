export interface CanvasSize {
  w: number
  h: number
}

export interface CanvasHandle {
  readonly ctx: CanvasRenderingContext2D
  readonly size: CanvasSize
  destroy(): void
}

export function createCanvas(
  canvas: HTMLCanvasElement,
  { onResize }: { onResize?: (size: CanvasSize) => void } = {},
): CanvasHandle {
  const rawCtx = canvas.getContext('2d')
  if (!rawCtx) {
    throw new Error('Could not acquire 2D canvas context')
  }
  const ctx: CanvasRenderingContext2D = rawCtx
  const size: CanvasSize = { w: 0, h: 0 }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1
    size.w = window.innerWidth
    size.h = window.innerHeight
    canvas.width = Math.floor(size.w * dpr)
    canvas.height = Math.floor(size.h * dpr)
    canvas.style.width = `${size.w}px`
    canvas.style.height = `${size.h}px`
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    onResize?.(size)
  }

  window.addEventListener('resize', resize)
  resize()

  return {
    ctx,
    size,
    destroy() {
      window.removeEventListener('resize', resize)
    },
  }
}
