/** Environment command lokal tidak boleh mewarisi credential proses Boo. */
export function commandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const blocked = /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)/i
  const exact = new Set(['NINEROUTER_KEY', 'DATABASE_URL', 'SSH_AUTH_SOCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'])
  return Object.fromEntries(Object.entries(env).filter(([key]) => !exact.has(key) && !blocked.test(key)))
}
