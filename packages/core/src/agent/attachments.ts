/** Penyimpanan privat attachment gambar untuk input multimodal dan /resume. */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { ImageAttachment } from '../domain/message.ts'
import { isSensitivePath } from '../tools/secrets.ts'

export const ATTACHMENT_DIRECTORY = 'attachments'
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const MAX_IMAGES_PER_MESSAGE = 5
export const MAX_IMAGE_TOTAL_BYTES = 25 * 1024 * 1024

const MEDIA_EXTENSION: Record<ImageAttachment['mediaType'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

export class AttachmentError extends Error {}

function detectedMediaType(data: Buffer): ImageAttachment['mediaType'] | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii'))) return 'image/gif'
  return null
}

function safeName(name: string, mediaType: ImageAttachment['mediaType']): string {
  const raw = basename(name).replace(/\p{Cc}/gu, '').trim().slice(0, 120)
  return raw || `gambar${MEDIA_EXTENSION[mediaType]}`
}

function root(home: string): string {
  return join(home, '.boo', ATTACHMENT_DIRECTORY)
}

function inside(path: string, parent: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function validSessionId(value: string): boolean {
  return /^[a-z0-9-]{8,80}$/i.test(value)
}

export function storeImageData(
  data: Buffer,
  options: { sessionId: string; name: string; home?: string; declaredMediaType?: string },
): ImageAttachment {
  if (!validSessionId(options.sessionId)) throw new AttachmentError('Session ID attachment tidak sah.')
  if (!data.length) throw new AttachmentError('Berkas gambar kosong.')
  if (data.length > MAX_IMAGE_BYTES) throw new AttachmentError(`Gambar melebihi batas ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`)
  const mediaType = detectedMediaType(data)
  if (!mediaType) throw new AttachmentError('Format gambar tidak didukung. Gunakan PNG, JPEG, WebP, atau GIF.')
  const declaredMediaType = options.declaredMediaType?.split(';', 1)[0].trim().toLowerCase()
  if (declaredMediaType && declaredMediaType !== 'application/octet-stream' && declaredMediaType !== mediaType) {
    throw new AttachmentError(`Isi gambar tidak cocok dengan Content-Type ${options.declaredMediaType}.`)
  }
  const digest = createHash('sha256').update(data).digest('hex')
  const id = digest.slice(0, 20)
  const directory = join(root(options.home ?? homedir()), options.sessionId)
  const filename = `${digest}${MEDIA_EXTENSION[mediaType]}`
  const target = join(directory, filename)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  if (!existsSync(target)) {
    const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`)
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, target)
      chmodSync(target, 0o600)
    } finally {
      try { unlinkSync(temporary) } catch { /* Sudah dipindahkan atau tidak pernah dibuat. */ }
    }
  }
  chmodSync(target, 0o600)
  return {
    id,
    name: safeName(options.name, mediaType),
    mediaType,
    ref: `${options.sessionId}/${filename}`,
    bytes: data.length,
  }
}

/** Path diberikan langsung oleh pengguna; symlink diikuti lalu salinannya dibekukan. */
export function storeImageFile(path: string, options: { sessionId: string; home?: string }): ImageAttachment {
  const storageHome = options.home ?? homedir()
  const expanded = path === '~' ? storageHome : /^~[\\/]/.test(path) ? join(storageHome, path.slice(2)) : path
  let real: string
  try { real = realpathSync(expanded) } catch { throw new AttachmentError(`Gambar tidak ditemukan: ${path}`) }
  if (isSensitivePath(real)) throw new AttachmentError('Berkas sensitif tidak dapat dilampirkan sebagai gambar.')
  const info = statSync(real)
  if (!info.isFile()) throw new AttachmentError('Attachment harus berupa berkas gambar.')
  if (info.size > MAX_IMAGE_BYTES) throw new AttachmentError(`Gambar melebihi batas ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`)
  return storeImageData(readFileSync(real), { ...options, home: storageHome, name: basename(real) })
}

/** Memastikan referensi sesi tidak dapat dipalsukan untuk membaca file lain. */
export function imageDataUrl(image: ImageAttachment, home = homedir()): string {
  const refMatch = /^([a-z0-9-]{8,80})\/([a-f0-9]{64}\.(?:png|jpg|webp|gif))$/i.exec(image.ref)
  if (!refMatch || !validSessionId(refMatch[1])) {
    throw new AttachmentError('Referensi attachment tidak sah.')
  }
  const storage = root(home)
  const candidate = join(storage, image.ref)
  let real: string
  try { real = realpathSync(candidate) } catch { throw new AttachmentError(`Attachment "${image.name}" tidak lagi tersedia.`) }
  let storageReal: string
  try { storageReal = realpathSync(storage) } catch { throw new AttachmentError('Penyimpanan attachment tidak tersedia.') }
  if (!inside(real, storageReal)) throw new AttachmentError('Referensi attachment keluar dari penyimpanan Boo.')
  const info = statSync(real)
  if (!info.isFile() || info.size > MAX_IMAGE_BYTES) throw new AttachmentError(`Attachment "${image.name}" tidak sah.`)
  const data = readFileSync(real)
  const mediaType = detectedMediaType(data)
  const digest = createHash('sha256').update(data).digest('hex')
  const expectedDigest = basename(image.ref).split('.')[0]
  if (!mediaType || mediaType !== image.mediaType || data.length !== image.bytes || digest !== expectedDigest || image.id !== digest.slice(0, 20)) {
    throw new AttachmentError(`Attachment "${image.name}" berubah atau rusak.`)
  }
  return `data:${mediaType};base64,${data.toString('base64')}`
}

export function validateImages(images: readonly ImageAttachment[]): void {
  if (images.length > MAX_IMAGES_PER_MESSAGE) throw new AttachmentError(`Maksimal ${MAX_IMAGES_PER_MESSAGE} gambar per pesan.`)
  if (images.reduce((total, image) => total + image.bytes, 0) > MAX_IMAGE_TOTAL_BYTES) {
    throw new AttachmentError(`Total gambar melebihi batas ${MAX_IMAGE_TOTAL_BYTES / 1024 / 1024} MiB.`)
  }
}
