/**
 * Узагальнений пул об'єктів для гарячих циклів симуляції та рендеру.
 * Зменшує тиск на young-generation V8 GC шляхом перевикористання екземплярів.
 */
export class ObjectPool<T> {
  readonly #factory: () => T
  readonly #reset?: (item: T) => void
  readonly #free: T[] = []
  readonly #maxSize: number

  #created = 0
  #reused = 0

  constructor(
    factory: () => T,
    {
      initialSize = 0,
      maxSize = 1024,
      reset,
    }: {
      initialSize?: number
      maxSize?: number
      reset?: (item: T) => void
    } = {},
  ) {
    this.#factory = factory
    this.#maxSize = maxSize
    this.#reset = reset

    for (let i = 0; i < initialSize; i += 1) {
      this.#free.push(this.#factory())
      this.#created += 1
    }
  }

  get available(): number {
    return this.#free.length
  }

  get created(): number {
    return this.#created
  }

  get reused(): number {
    return this.#reused
  }

  acquire(): T {
    const existing = this.#free.pop()
    if (existing !== undefined) {
      this.#reused += 1
      return existing
    }
    this.#created += 1
    return this.#factory()
  }

  release(item: T): void {
    this.#reset?.(item)
    if (this.#free.length < this.#maxSize) {
      this.#free.push(item)
    }
  }

  clear(): void {
    this.#free.length = 0
  }
}
