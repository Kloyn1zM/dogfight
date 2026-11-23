export interface Prng {
  next(): number
  getState(): number
}

/**
 * Детермінований PRNG (mulberry32).
 * Ідентичний seed на клієнті й сервері дає однакову послідовність у [0, 1).
 */
export function createPrng(seed = 0x12345678): Prng {
  let state = seed >>> 0

  return {
    next(): number {
      state = (state + 0x6d2b79f5) >>> 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    },
    getState(): number {
      return state
    },
  }
}
