export function tokenize(query) {
  return query.trim().toLowerCase().split(/\s+/)
}
