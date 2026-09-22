import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractReadableWebText,
  isPublicWebAddress,
  parseBingSearchResults,
  parseWebSearchResults,
  validatePublicWebUrl,
  webFetchTool,
  webSearchTool,
} from '../src/tools/web.ts'

test('URL web hanya menerima HTTPS publik tanpa credential atau port khusus', () => {
  assert.equal(validatePublicWebUrl('https://example.com/docs#bagian').href, 'https://example.com/docs')
  for (const value of [
    'http://example.com',
    'https://localhost/admin',
    'https://service.internal/data',
    'https://user:secret@example.com',
    'https://example.com:8443',
    'https://127.0.0.1',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
  ]) assert.throws(() => validatePublicWebUrl(value))
})

test('klasifikasi alamat menolak LAN, loopback, metadata, dan rentang nonpublik', () => {
  for (const address of ['0.0.0.0', '10.2.3.4', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.20.1.2', '192.168.1.2', '::', '::1', 'fc00::1', 'fe80::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    assert.equal(isPublicWebAddress(address), false, address)
  }
  assert.equal(isPublicWebAddress('1.1.1.1'), true)
  assert.equal(isPublicWebAddress('198.51.44.1'), true)
  assert.equal(isPublicWebAddress('2606:4700:4700::1111'), true)
})

test('hasil pencarian memulihkan URL tujuan, entity, snippet, dan membuang duplikat', () => {
  const target = encodeURIComponent('https://docs.example.com/guide?a=1&b=2')
  const html = `
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${target}"><b>Panduan</b> &amp; API</a>
      <a class="result__snippet">Dokumentasi <b>resmi</b> untuk API.</a>
    </div>
    <div class="result">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=${target}">Duplikat</a>
    </div>
    <div class="result">
      <a class="result__a" href="javascript:alert(1)">Bahaya</a>
    </div>`
  assert.deepEqual(parseWebSearchResults(html), [{
    title: 'Panduan & API',
    url: 'https://docs.example.com/guide?a=1&b=2',
    snippet: 'Dokumentasi resmi untuk API.',
  }])
})

test('fallback Bing memulihkan redirect base64 dan cuplikan hasil', () => {
  const target = 'https://nodejs.org/en/docs'
  const encoded = `a1${Buffer.from(target).toString('base64url')}`
  const html = `<ol><li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=${encoded}">Node.js &amp; Docs</a></h2><div><p>Dokumentasi <b>runtime</b> resmi.</p></div></li></ol>`
  assert.deepEqual(parseBingSearchResults(html), [{
    title: 'Node.js & Docs',
    url: target,
    snippet: 'Dokumentasi runtime resmi.',
  }])
})

test('HTML diubah menjadi teks, script dibuang, dan link sumber dipertahankan', () => {
  const result = extractReadableWebText(`<!doctype html><html><head><title>Docs &amp; API</title><style>.x{}</style></head><body>
    <script>stealSecrets()</script><h1>Mulai</h1><p>Baca <a href="/reference">referensi resmi</a>.</p>
    <ul><li>Satu</li><li>Dua</li></ul></body></html>`, 'https://example.com/docs')
  assert.equal(result.title, 'Docs & API')
  assert.doesNotMatch(result.text, /stealSecrets|\.x/)
  assert.match(result.text, /Mulai/)
  assert.match(result.text, /referensi resmi \[https:\/\/example\.com\/reference\]/)
  assert.match(result.text, /- Satu/)
})

test('tool web menandai input invalid sebagai error tanpa mencoba jaringan', async () => {
  const context = { workspace: process.cwd() }
  const fetched = await webFetchTool.run({ url: 'http://127.0.0.1/private' }, context)
  const searched = await webSearchTool.run({ query: '\n' }, context)
  assert.equal(fetched.isError, true)
  assert.match(fetched.content, /HTTPS publik/)
  assert.equal(searched.isError, true)
  assert.match(searched.content, /Query pencarian/)
})
