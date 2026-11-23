/**
 * Незмінний 2D-вектор із `readonly x, y` (контракт чистоти, перевірений компілятором).
 */
export class Vector2 {
  readonly x: number
  readonly y: number

  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length)
  }

  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y)
  }

  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y)
  }

  scale(factor: number): Vector2 {
    return new Vector2(this.x * factor, this.y * factor)
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y
  }

  length(): number {
    return Math.hypot(this.x, this.y)
  }

  normalize(): Vector2 {
    const len = this.length()
    if (len === 0) return new Vector2(0, 0)
    return new Vector2(this.x / len, this.y / len)
  }

  rotate(angle: number): Vector2 {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c)
  }

  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y
  }

  distanceTo(v: Vector2): number {
    return Math.hypot(this.x - v.x, this.y - v.y)
  }
}
