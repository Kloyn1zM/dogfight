import { describe, expect, it } from 'vitest'
import { Vector2 } from '@dogfight/shared'

describe('Vector2', () => {
  it('defaults to (0, 0) and stores readonly coordinates', () => {
    const zero = new Vector2()
    expect(zero.x).toBe(0)
    expect(zero.y).toBe(0)

    const v = new Vector2(3, -4)
    expect(v.x).toBe(3)
    expect(v.y).toBe(-4)
  })

  it('constructs from angle and optional length', () => {
    const right = Vector2.fromAngle(0)
    expect(right.x).toBeCloseTo(1, 10)
    expect(right.y).toBeCloseTo(0, 10)

    const down = Vector2.fromAngle(Math.PI / 2, 5)
    expect(down.x).toBeCloseTo(0, 10)
    expect(down.y).toBeCloseTo(5, 10)
  })

  it('adds two vectors without mutating operands', () => {
    const a = new Vector2(2, 3)
    const b = new Vector2(-5, 7)
    const sum = a.add(b)

    expect(sum.x).toBe(-3)
    expect(sum.y).toBe(10)
    expect(a.x).toBe(2)
    expect(a.y).toBe(3)
    expect(b.x).toBe(-5)
    expect(b.y).toBe(7)
  })

  it('subtracts two vectors without mutating operands', () => {
    const a = new Vector2(10, 4)
    const b = new Vector2(3, 9)
    const diff = a.sub(b)

    expect(diff.x).toBe(7)
    expect(diff.y).toBe(-5)
    expect(a.x).toBe(10)
    expect(b.y).toBe(9)
  })

  it('scales by positive, negative, and zero factors', () => {
    const v = new Vector2(4, -2)
    expect(v.scale(2.5)).toEqual(new Vector2(10, -5))
    expect(v.scale(-1)).toEqual(new Vector2(-4, 2))
    const z = v.scale(0)
    expect(z.x === 0 && z.y === 0).toBe(true)
  })

  it('computes lengthSq and length accurately', () => {
    const v = new Vector2(3, 4)
    expect(v.lengthSq()).toBe(25)
    expect(v.length()).toBe(5)
  })

  it('normalizes non-zero vectors to unit length', () => {
    const u = new Vector2(6, 8).normalize()
    expect(u.x).toBeCloseTo(0.6, 10)
    expect(u.y).toBeCloseTo(0.8, 10)
    expect(u.length()).toBeCloseTo(1, 10)
  })

  it('returns (0, 0) when normalizing a zero vector', () => {
    const u = new Vector2(0, 0).normalize()
    expect(u.x).toBe(0)
    expect(u.y).toBe(0)
  })

  it('rotates by an angle and preserves magnitude', () => {
    const v = new Vector2(3, 0)
    const rotated = v.rotate(Math.PI / 2)
    expect(rotated.x).toBeCloseTo(0, 10)
    expect(rotated.y).toBeCloseTo(3, 10)
    expect(rotated.length()).toBeCloseTo(v.length(), 10)
  })

  it('computes dot product for orthogonal, parallel, and opposite vectors', () => {
    const right = new Vector2(2, 0)
    const up = new Vector2(0, 3)
    expect(right.dot(up)).toBe(0)
    expect(right.dot(new Vector2(4, 0))).toBe(8)
    expect(right.dot(new Vector2(-3, 0))).toBe(-6)
  })

  it('computes symmetric Euclidean distanceTo', () => {
    const a = new Vector2(1, 2)
    const b = new Vector2(4, 6)
    expect(a.distanceTo(b)).toBe(5)
    expect(b.distanceTo(a)).toBe(5)
    expect(a.distanceTo(a)).toBe(0)
  })
})
