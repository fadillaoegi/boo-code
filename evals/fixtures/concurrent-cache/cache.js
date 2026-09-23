const cache = new Map()

export async function getOrLoad(key, loader) {
  if (cache.has(key)) return cache.get(key)
  const value = await loader()
  cache.set(key, value)
  return value
}

export function clearCache() {
  cache.clear()
}
