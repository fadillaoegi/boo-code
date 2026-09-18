/**
 * Titik masuk `boo-code web`: menyiapkan pengendali, server, dan membuka browser.
 */

import { spawn } from 'node:child_process'
import type { BooKey } from '@boo/core/config/config.ts'
import { loadAssets } from './assets.ts'
import { WebController } from './controller.ts'
import { startWebServer, type WebServer } from './http.ts'

export { buildAssets, tokenCss, type EmbeddedAssets } from './assets.ts'
export { WebController } from './controller.ts'
export { startWebServer } from './http.ts'

export interface StartWebOptions {
  workspace: string
  config: Partial<Record<BooKey, string | undefined>>
  version: string
  port?: number
}

export interface RunningWeb {
  server: WebServer
  controller: WebController
  close(): Promise<void>
}

export async function startWeb({ workspace, config, version, port }: StartWebOptions): Promise<RunningWeb> {
  const controller = new WebController({ workspace, config, version })
  const assets = await loadAssets()
  let server: WebServer
  try {
    server = await startWebServer({ controller, assets, port: port ?? 0 })
  } catch (error) {
    controller.close()
    throw error
  }
  return {
    server,
    controller,
    close: async () => {
      controller.close()
      await server.close()
    },
  }
}

/** Membuka alamat di browser bawaan sistem; gagal diam-diam karena alamatnya juga tercetak. */
export function openBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Browser tidak dapat dibuka otomatis; pengguna membuka alamat yang tercetak.
  }
}
