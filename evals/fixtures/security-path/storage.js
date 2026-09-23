import path from 'node:path'

export function resolveUpload(root, userPath) {
  const resolved = path.resolve(root, userPath)
  if (!resolved.startsWith(root)) throw new Error('Path escapes upload root')
  return resolved
}
