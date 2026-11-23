/**
 * Типізована шина подій (zero `as`, zero `any`, без залежності від DOM/Node).
 * Зв'язує ім'я події K із точним типом її payload E[K] на рівні компілятора.
 */
export class TypedBus<E extends Record<string, unknown>> {
  #listeners: { [K in keyof E]?: Set<(payload: E[K]) => void> } = {}

  on<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void {
    let set = this.#listeners[name]
    if (!set) {
      set = new Set()
      this.#listeners[name] = set
    }
    set.add(fn)
    return () => {
      set.delete(fn)
    }
  }

  once<K extends keyof E>(name: K, fn: (payload: E[K]) => void): () => void {
    const off = this.on(name, (payload) => {
      off()
      fn(payload)
    })
    return off
  }

  emit<K extends keyof E>(name: K, payload: E[K]): void {
    const set = this.#listeners[name]
    if (!set) return
    for (const fn of [...set]) {
      fn(payload)
    }
  }

  clear(): void {
    this.#listeners = {}
  }
}
