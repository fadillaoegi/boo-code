import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeRequest } from '../src/presentation/approval.ts'
import { sendWhatsAppMessage, whatsappCdpUrl, whatsappSendMessageTool } from '../src/tools/whatsapp.ts'

test('alamat CDP WhatsApp hanya menerima loopback lokal', async () => {
  const home = await mkdtemp(join(tmpdir(), 'boo-wa-'))
  await mkdir(join(home, '.boo'))
  await writeFile(join(home, '.boo', 'whatsapp.json'), JSON.stringify({ cdpUrl: 'http://127.0.0.1:9333' }))
  assert.equal(whatsappCdpUrl(home, {}), 'http://127.0.0.1:9333/')
  await writeFile(join(home, '.boo', 'whatsapp.json'), JSON.stringify({ cdpUrl: 'http://example.com:9222' }))
  assert.throws(() => whatsappCdpUrl(home, {}), /localhost\/127\.0\.0\.1/)
})

test('pesan WhatsApp tidak dapat memperoleh izin permanen dan pratinjau memuat isi lengkap', () => {
  assert.equal(whatsappSendMessageTool.allowAlways, false)
  const request = describeRequest('whatsapp_send_message', { recipient: 'Budi', message: 'Rapat pukul 15.00.' }, false)
  assert.equal(request.title, 'Kirim pesan WhatsApp')
  assert.match(request.question, /Budi/)
  assert.match(request.question, /Rapat pukul 15\.00\./)
})

test('argumen pesan invalid ditolak sebelum mencoba membuka browser', async () => {
  await assert.rejects(sendWhatsAppMessage('', 'halo'), /Penerima WhatsApp/)
  await assert.rejects(sendWhatsAppMessage('Budi', ''), /Isi pesan WhatsApp/)
})
