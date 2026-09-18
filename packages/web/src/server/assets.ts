/**
 * Aset halaman: HTML, JavaScript, CSS, dan logo.
 *
 * Dari sumber, halaman dibundel di memori dengan esbuild saat server dimulai, sehingga
 * perubahan kode langsung terlihat tanpa langkah build. Di paket rilis, hasil bundel
 * sudah disematkan ke dalam berkas CLI lewat `__BOO_WEB_ASSETS__`, dan esbuild tidak
 * dibutuhkan sama sekali.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fixedColor, fontFamily, themedColor } from '@boo/core/design/tokens.ts'

export interface WebAssets {
  html: string
  js: string
  css: string
  logo: Buffer
}

/** Bentuk yang disematkan saat rilis; logo sebagai base64 agar dapat dijadikan JSON. */
export interface EmbeddedAssets {
  html: string
  js: string
  css: string
  logoBase64: string
}

declare const __BOO_WEB_ASSETS__: EmbeddedAssets | undefined

const clientDirectory = join(import.meta.dirname, '..', 'client')

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}

/** Design token sebagai CSS custom property, untuk tema terang dan gelap. */
export function tokenCss(): string {
  const fixed = Object.entries(fixedColor).map(([name, value]) => `  --boo-${kebab(name)}: ${value};`)
  const light = Object.entries(themedColor).map(([name, value]) => `  --boo-${kebab(name)}: ${value.light};`)
  const dark = Object.entries(themedColor).map(([name, value]) => `  --boo-${kebab(name)}: ${value.dark};`)
  return [
    `:root {\n  --boo-font: ${fontFamily};\n${fixed.join('\n')}\n${light.join('\n')}\n  color-scheme: light;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${dark.map((line) => `  ${line}`).join('\n')}\n    color-scheme: dark;\n  }\n}`,
    `:root[data-theme="dark"] {\n${dark.join('\n')}\n  color-scheme: dark;\n}`,
  ].join('\n\n')
}

/** Membundel halaman dari sumber. Membutuhkan esbuild (dependency pengembangan). */
export async function buildAssets(): Promise<EmbeddedAssets> {
  const esbuild = await import('esbuild')
  const result = await esbuild.build({
    entryPoints: [join(clientDirectory, 'main.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    write: false,
    logLevel: 'silent',
  })
  return {
    html: readFileSync(join(clientDirectory, 'index.html'), 'utf8'),
    js: result.outputFiles[0].text,
    css: `${tokenCss()}\n\n${readFileSync(join(clientDirectory, 'styles.css'), 'utf8')}`,
    logoBase64: readFileSync(join(clientDirectory, 'logo.png')).toString('base64'),
  }
}

export async function loadAssets(): Promise<WebAssets> {
  const embedded = typeof __BOO_WEB_ASSETS__ !== 'undefined' ? __BOO_WEB_ASSETS__ : await buildAssets()
  return { html: embedded.html, js: embedded.js, css: embedded.css, logo: Buffer.from(embedded.logoBase64, 'base64') }
}
