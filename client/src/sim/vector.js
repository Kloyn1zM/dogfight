/**
 * 2D-вектор із чистими методами (повертають новий Vector2, не мутують `this`)
 * та in-place утилітами (set/copy/addInPlace) для гарячих шляхів симуляції.
 */
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length)
  }

  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y)
  }

  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y)
  }

  scale(factor) {
    return new Vector2(this.x * factor, this.y * factor)
  }

  lengthSq() {
    return this.x * this.x + this.y * this.y
  }

  length() {
    return Math.hypot(this.x, this.y)
  }

  normalize() {
    const len = this.length()
    if (len === 0) return new Vector2(0, 0)
    return new Vector2(this.x / len, this.y / len)
  }

  rotate(angle) {
    const c = Math.cos(angle)
    const s = Math.sin(angle)
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c)
  }

  dot(v) {
    return this.x * v.x + this.y * v.y
  }

  distanceTo(v) {
    return Math.hypot(this.x - v.x, this.y - v.y)
  }

  clone() {
    return new Vector2(this.x, this.y)
  }

  set(x, y) {
    this.x = x
    this.y = y
    return this
  }

  copy(v) {
    this.x = v.x
    this.y = v.y
    return this
  }

  addInPlace(v) {
    this.x += v.x
    this.y += v.y
    return this
  }
}
