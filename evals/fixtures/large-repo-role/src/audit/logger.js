export function audit(event, metadata = {}) {
  return { event, metadata, createdAt: new Date().toISOString() }
}
