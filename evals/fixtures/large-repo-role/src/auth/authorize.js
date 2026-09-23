import { normalizeRole } from '../users/roles.js'

const permissions = {
  admin: new Set(['read', 'write', 'delete']),
  editor: new Set(['read', 'write']),
  viewer: new Set(['read']),
}

export function can(user, action) {
  return permissions[normalizeRole(user.role)]?.has(action) ?? false
}
