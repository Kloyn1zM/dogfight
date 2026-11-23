type ElementCtor<T extends Element> = abstract new () => T

/**
 * Повертає DOM-елемент із точним типом T через перевірку instanceof (без `as`).
 */
export function requireEl<T extends Element>(
  root: ParentNode,
  selector: string,
  ctor: ElementCtor<T>,
): T {
  const el = root.querySelector(selector)
  if (!(el instanceof ctor)) {
    throw new Error(`Required element "${selector}" not found`)
  }
  return el
}
