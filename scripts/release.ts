/**
 * Menyusun paket boo-code yang dapat dipasang di mesin lain.
 *
 * Di dalam repo, CLI dijalankan langsung dari sumber TypeScript dan bergantung pada
 * @boo/core sebagai paket workspace — keduanya tidak ada di mesin lain. Di sini
 * CLI dan core dibundel menjadi satu berkas JavaScript tanpa dependency, lalu
 * dibungkus `npm pack` menjadi tarball:
 *
 *   release/boo-code/                 isi paket (dapat diperiksa sebelum dibagikan)
 *   release/boo-code-<versi>.tgz      untuk `npm install -g`
 *
 * Tidak ada yang dipublikasikan ke registry; itu keputusan terpisah.
 */

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAssets } from '../packages/web/src/server/assets.ts'

const root = join(import.meta.dirname, '..')
const cliDirectory = join(root, 'packages', 'cli')
const manifest = JSON.parse(readFileSync(join(cliDirectory, 'package.json'), 'utf8')) as {
  name: string
  version: string
  description: string
}
const workspaceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

/**
 * Compiler TypeScript dipakai saat berjalan oleh analisis AST (repo_map dan
 * code_graph), tetapi tidak ikut dibundel: sepuluh megabyte di dalam satu berkas
 * membuat paket berat dan sulit diperbarui. Ia dipasang sebagai dependency biasa
 * dan dimuat saat dibutuhkan; bila hilang, analisis jatuh ke mode fallback.
 */
const RUNTIME_DEPENDENCIES = {
  typescript: workspaceManifest.devDependencies.typescript,
  '@microsoft/mxc-sdk': workspaceManifest.dependencies['@microsoft/mxc-sdk'],
}

/** Versi Node terendah yang diuji: fs.glob dan path.matchesGlob stabil tanpa peringatan. */
const MINIMUM_NODE = '22.12'

const releaseDirectory = join(root, 'release')
const packageDirectory = join(releaseDirectory, 'boo-code')
rmSync(releaseDirectory, { recursive: true, force: true })
mkdirSync(join(packageDirectory, 'dist'), { recursive: true })

const outfile = join(packageDirectory, 'dist', 'boo-code.js')
const webAssets = await buildAssets()
await build({
  entryPoints: [join(cliDirectory, 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: `node${MINIMUM_NODE}`,
  outfile,
  legalComments: 'none',
  logLevel: 'warning',
  external: [...Object.keys(RUNTIME_DEPENDENCIES), 'esbuild'],
  define: {
    __BOO_WEB_ASSETS__: JSON.stringify(webAssets),
  },
})
chmodSync(outfile, 0o755)

writeFileSync(join(packageDirectory, 'package.json'), `${JSON.stringify({
  name: manifest.name,
  version: manifest.version,
  description: manifest.description,
  type: 'module',
  bin: { 'boo-code': './dist/boo-code.js', boo: './dist/boo-code.js' },
  files: ['dist', 'README.md'],
  dependencies: RUNTIME_DEPENDENCIES,
  engines: { node: `>=${MINIMUM_NODE}` },
  author: 'FLdev',
  license: 'UNLICENSED',
}, null, 2)}\n`)
copyFileSync(join(cliDirectory, 'README.md'), join(packageDirectory, 'README.md'))

const tarball = execFileSync('npm', ['pack', '--pack-destination', releaseDirectory], {
  cwd: packageDirectory,
  encoding: 'utf8',
}).trim().split('\n').at(-1)

const size = readFileSync(outfile).length
console.log(`Bundel: ${outfile} (${Math.round(size / 1024)} KB)`)
console.log(`Paket:  ${join(releaseDirectory, tarball ?? '')}`)
console.log(`Pasang: npm install -g ${join(releaseDirectory, tarball ?? '')}`)
