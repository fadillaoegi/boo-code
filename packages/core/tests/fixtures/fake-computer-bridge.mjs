let input = ''
for await (const chunk of process.stdin) input += chunk
const request = JSON.parse(input)
if (request.action === 'snapshot') {
  process.stdout.write(JSON.stringify({ ok: true, message: 'snapshot siap', app: 'Editor', elements: [
    { ref: 'e1', role: 'button', name: 'Save', enabled: true },
    { ref: '../buruk', role: 'button', name: 'Bad' },
  ] }))
} else if (request.action === 'status') {
  process.stdout.write(JSON.stringify({ ok: true, message: 'ready' }))
} else {
  process.stdout.write(JSON.stringify({ ok: true, message: `${request.action}:${request.ref ?? ''}:${request.key ?? request.text ?? ''}` }))
}
