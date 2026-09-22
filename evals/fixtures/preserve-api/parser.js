export function parseLimit(input) {
  const value = Number.parseInt(input, 10)
  return value || 10
}

export function publicVersion() {
  return 'v1'
}
