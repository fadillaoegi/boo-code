export function isValidRange(start, end) {
  return new Date(start).getTime() <= new Date(end).getTime()
}
