let buffer = Buffer.alloc(0)
let openedUri = ''

function send(message) {
  const body = JSON.stringify({ jsonrpc: '2.0', ...message })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
}

function handle(message) {
  if (message.method === 'initialize') {
    send({ id: message.id, result: { capabilities: { documentSymbolProvider: true, definitionProvider: true, referencesProvider: true, hoverProvider: true, diagnosticProvider: {} } } })
    return
  }
  if (message.method === 'textDocument/didOpen') {
    openedUri = message.params.textDocument.uri
    send({ method: 'textDocument/publishDiagnostics', params: {
      uri: openedUri,
      diagnostics: [{ range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, severity: 1, code: 'FAKE1', source: 'fake-lsp', message: 'Contoh error semantic.' }],
    } })
    return
  }
  if (message.method === 'textDocument/documentSymbol') {
    send({ id: message.id, result: [{ name: 'Worker', kind: 5, range: { start: { line: 0, character: 0 } }, selectionRange: { start: { line: 0, character: 6 } }, children: [{ name: 'run', kind: 6, range: { start: { line: 1, character: 2 } }, selectionRange: { start: { line: 1, character: 2 } } }] }] })
    return
  }
  if (message.method === 'textDocument/definition') {
    send({ id: message.id, result: { uri: openedUri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } } })
    return
  }
  if (message.method === 'textDocument/references') {
    send({ id: message.id, result: [
      { uri: openedUri, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } },
      { uri: openedUri, range: { start: { line: 3, character: 7 }, end: { line: 3, character: 10 } } },
    ] })
    return
  }
  if (message.method === 'textDocument/hover') {
    send({ id: message.id, result: { contents: { kind: 'markdown', value: '```ts\n(method) Worker.run(): void\n```' } } })
    return
  }
  if (message.method === 'textDocument/diagnostic') {
    send({ id: message.id, result: { kind: 'full', items: [{ range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } }, severity: 1, code: 'FAKE1', source: 'fake-lsp', message: 'Contoh error semantic.' }] } })
    return
  }
  if (message.method === 'shutdown') {
    send({ id: message.id, result: null })
    return
  }
  if (message.method === 'exit') process.exit(0)
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1])
    const start = headerEnd + 4
    if (!Number.isFinite(length) || buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString('utf8')
    buffer = buffer.subarray(start + length)
    handle(JSON.parse(body))
  }
})
