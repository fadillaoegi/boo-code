let buffer = ''
let roots = []
const queued = []

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function toolsList(id) {
  send({ id, result: { tools: [
    { name: 'echo', description: 'Mengembalikan pesan', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
    { name: 'fail', description: 'Menghasilkan error tool', inputSchema: { type: 'object', properties: {} } },
  ] } })
}

function toolsCall(message) {
  const name = message.params?.name
  if (name === 'fail') {
    send({ id: message.id, result: { isError: true, content: [{ type: 'text', text: 'kegagalan dari server' }] } })
    return
  }
  if (name !== 'echo') {
    send({ id: message.id, error: { code: -32602, message: 'tool tidak dikenal' } })
    return
  }
  const value = String(message.params?.arguments?.message ?? '')
  send({ id: message.id, result: {
    content: [{ type: 'text', text: `echo:${value}\nroot:${roots[0]?.uri ?? 'missing'}` }],
    structuredContent: { echoed: value },
  } })
}

function handle(message) {
  if (message.id === 'boo-roots') {
    roots = Array.isArray(message.result?.roots) ? message.result.roots : []
    for (const pending of queued.splice(0)) handle(pending)
    return
  }
  if (message.method === 'initialize') {
    send({ id: message.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.0.0' },
    } })
    return
  }
  if (message.method === 'notifications/initialized') {
    send({ id: 'boo-roots', method: 'roots/list', params: {} })
    return
  }
  if ((message.method === 'tools/list' || message.method === 'tools/call') && roots.length === 0) {
    queued.push(message)
    return
  }
  if (message.method === 'tools/list') toolsList(message.id)
  else if (message.method === 'tools/call') toolsCall(message)
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const newline = buffer.indexOf('\n')
    if (newline === -1) return
    const line = buffer.slice(0, newline).replace(/\r$/, '')
    buffer = buffer.slice(newline + 1)
    if (line.trim()) handle(JSON.parse(line))
  }
})
