import type { Tool } from '../domain/tool.ts'
import { callRemoteNode, loadRemoteNodes } from '../remote/nodes.ts'
import type { ComputerKey, ComputerResponse } from './computer.ts'
import { redactSensitiveText } from '../security/redaction.ts'

function render(response: ComputerResponse): string {
  const lines = [`${response.ok ? 'OK' : 'Gagal'}: ${response.message}`]
  if (response.app) lines.push(`Aplikasi aktif: ${response.app}`)
  for (const element of response.elements ?? []) lines.push(`- ${element.ref} · ${element.role} · ${element.name}${element.enabled === false ? ' · disabled' : ''}`)
  return lines.join('\n')
}

async function call(node: string, request: Parameters<typeof callRemoteNode>[1], home?: string, signal?: AbortSignal) {
  try {
    const response = await callRemoteNode(node, request, { home, signal })
    return { content: render(response), isError: !response.ok }
  } catch (error) { return { content: `Remote node gagal: ${error instanceof Error ? error.message : 'kesalahan tidak dikenal'}`, isError: true } }
}

export const remoteNodeListTool: Tool = {
  name: 'remote_node_list', description: 'List paired Boo device nodes without exposing tokens or credentials.', risk: 'safe',
  schema: { type: 'function', function: { name: 'remote_node_list', description: 'List paired remote device nodes.', parameters: { type: 'object', properties: {} } } },
  preview: () => 'lihat remote node',
  async run(_args, context) {
    const nodes = loadRemoteNodes(context.home).nodes
    return { content: nodes.length ? nodes.map((node) => `- ${node.id}: ${node.label} · ${new URL(node.url).host}`).join('\n') : '(Belum ada remote node. Gunakan `boo-code node pair`.)' }
  },
}

export const remoteNodeStatusTool: Tool<{ node: string }> = {
  name: 'remote_node_status', description: 'Check one paired node and its native computer bridge. Network access always requires fresh approval.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'remote_node_status', description: 'Check a paired remote device node.', parameters: { type: 'object', properties: { node: { type: 'string' } }, required: ['node'] } } },
  preview: (args) => `cek remote node ${args.node}`,
  async run(args, context) { return call(args.node, { action: 'status' }, context.home, context.signal) },
}

export const remoteNodeSnapshotTool: Tool<{ node: string; max_elements?: number }> = {
  name: 'remote_node_snapshot', description: 'Read a bounded native accessibility snapshot from a paired device. Always requires fresh approval.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'remote_node_snapshot', description: 'Read the active native UI on a paired device.', parameters: { type: 'object', properties: { node: { type: 'string' }, max_elements: { type: 'integer', minimum: 1, maximum: 500 } }, required: ['node'] } } },
  preview: (args) => `baca UI remote node ${args.node}`,
  async run(args, context) { return call(args.node, { action: 'snapshot', maxElements: args.max_elements ?? 200 }, context.home, context.signal) },
}

interface RemoteRef { node: string; ref: string }
export const remoteNodeClickTool: Tool<RemoteRef> = {
  name: 'remote_node_click', description: 'Activate one opaque UI ref on a paired device. No coordinates or remote shell.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'remote_node_click', description: 'Click an element from the latest remote snapshot.', parameters: { type: 'object', properties: { node: { type: 'string' }, ref: { type: 'string' } }, required: ['node', 'ref'] } } },
  preview: (args) => `klik ${args.ref} di node ${args.node}`,
  async run(args, context) { return call(args.node, { action: 'click', ref: args.ref }, context.home, context.signal) },
}

export const remoteNodeTypeTool: Tool<RemoteRef & { text: string }> = {
  name: 'remote_node_type', description: 'Type visible non-secret text into one remote native UI ref. Passwords, tokens, payment data, and OTP are forbidden.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'remote_node_type', description: 'Type text into an element from the latest remote snapshot.', parameters: { type: 'object', properties: { node: { type: 'string' }, ref: { type: 'string' }, text: { type: 'string', minLength: 1, maxLength: 4_000 } }, required: ['node', 'ref', 'text'] } } },
  preview: (args) => `ketik ke ${args.ref} di node ${args.node}`,
  async run(args, context) {
    if (redactSensitiveText(args.text, { environment: process.env }).redactions) return { content: 'Remote node menolak mengetik teks yang tampak seperti credential atau secret.', isError: true }
    return call(args.node, { action: 'type', ref: args.ref, text: args.text }, context.home, context.signal)
  },
}

export const remoteNodePressTool: Tool<RemoteRef & { key: ComputerKey }> = {
  name: 'remote_node_press', description: 'Press one allowlisted navigation key on a remote native UI ref.', risk: 'confirm', allowAlways: false,
  schema: { type: 'function', function: { name: 'remote_node_press', description: 'Press a navigation key on a paired device.', parameters: { type: 'object', properties: { node: { type: 'string' }, ref: { type: 'string' }, key: { type: 'string', enum: ['Enter', 'Escape', 'Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete'] } }, required: ['node', 'ref', 'key'] } } },
  preview: (args) => `tekan ${args.key} pada ${args.ref} di node ${args.node}`,
  async run(args, context) { return call(args.node, { action: 'press', ref: args.ref, key: args.key }, context.home, context.signal) },
}
