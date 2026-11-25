import type { EntityId } from '../types.ts'

export interface SpatialBody {
  readonly id: EntityId
  readonly x: number
  readonly y: number
  readonly radius: number
}

/**
 * Однорідна просторова сітка (spatial hash) із фіксованим кроком клітинки.
 * Перевикористовує масиви клітинок і буфер результатів між тиками (0 алокацій у steady-state)
 * та зберігає точний порядок вставки кандидатів для детермінізму колізій.
 */
export class SpatialHashGrid<T extends SpatialBody> {
  readonly cellSize: number
  readonly cols: number
  readonly rows: number
  readonly #cells: T[][]
  readonly #dirtyCells: number[] = []
  readonly #seenStamp = new Int32Array(65536)
  readonly #insertOrder = new Int32Array(65536)
  #stamp = 1
  #orderCounter = 0

  constructor(width: number, height: number, cellSize = 64) {
    this.cellSize = cellSize
    this.cols = Math.max(1, Math.ceil(width / cellSize))
    this.rows = Math.max(1, Math.ceil(height / cellSize))
    const totalCells = this.cols * this.rows
    this.#cells = new Array<T[]>(totalCells)
    for (let i = 0; i < totalCells; i += 1) {
      this.#cells[i] = []
    }
  }

  clear(): void {
    for (let i = 0; i < this.#dirtyCells.length; i += 1) {
      const idx = this.#dirtyCells[i]
      if (idx === undefined) continue
      const bucket = this.#cells[idx]
      if (bucket) bucket.length = 0
    }
    this.#dirtyCells.length = 0
    this.#orderCounter = 0
  }

  insert(item: T): void {
    this.#orderCounter += 1
    this.#insertOrder[item.id & 0xffff] = this.#orderCounter

    const inv = 1 / this.cellSize
    const minCol = Math.max(0, Math.floor((item.x - item.radius) * inv))
    const maxCol = Math.min(
      this.cols - 1,
      Math.floor((item.x + item.radius) * inv),
    )
    const minRow = Math.max(0, Math.floor((item.y - item.radius) * inv))
    const maxRow = Math.min(
      this.rows - 1,
      Math.floor((item.y + item.radius) * inv),
    )

    for (let row = minRow; row <= maxRow; row += 1) {
      const rowOffset = row * this.cols
      for (let col = minCol; col <= maxCol; col += 1) {
        const idx = rowOffset + col
        const bucket = this.#cells[idx]
        if (!bucket) continue
        if (bucket.length === 0) {
          this.#dirtyCells.push(idx)
        }
        bucket.push(item)
      }
    }
  }

  /**
   * Записує всіх кандидатів у `out` (без дублікатів) у точному порядку вставки.
   */
  queryCircle(x: number, y: number, radius: number, out: T[]): void {
    out.length = 0
    this.#stamp += 1
    if (this.#stamp >= 0x7ffffff0) {
      this.#seenStamp.fill(0)
      this.#stamp = 1
    }
    const stamp = this.#stamp

    const inv = 1 / this.cellSize
    const minCol = Math.max(0, Math.floor((x - radius) * inv))
    const maxCol = Math.min(this.cols - 1, Math.floor((x + radius) * inv))
    const minRow = Math.max(0, Math.floor((y - radius) * inv))
    const maxRow = Math.min(this.rows - 1, Math.floor((y + radius) * inv))

    for (let row = minRow; row <= maxRow; row += 1) {
      const rowOffset = row * this.cols
      for (let col = minCol; col <= maxCol; col += 1) {
        const bucket = this.#cells[rowOffset + col]
        if (!bucket || bucket.length === 0) continue
        for (let i = 0; i < bucket.length; i += 1) {
          const item = bucket[i]
          if (!item) continue
          const idKey = item.id & 0xffff
          if (this.#seenStamp[idKey] === stamp) continue
          this.#seenStamp[idKey] = stamp
          out.push(item)
        }
      }
    }

    // Inline insertion sort (0 алокацій) зберігає точний порядок Map для еквівалентності з O(n²)
    for (let i = 1; i < out.length; i += 1) {
      const cur = out[i]
      if (!cur) continue
      const curOrder = this.#insertOrder[cur.id & 0xffff] ?? 0
      let j = i - 1
      while (j >= 0) {
        const prev = out[j]
        if (!prev) break
        const prevOrder = this.#insertOrder[prev.id & 0xffff] ?? 0
        if (prevOrder <= curOrder) break
        out[j + 1] = prev
        j -= 1
      }
      out[j + 1] = cur
    }
  }
}
