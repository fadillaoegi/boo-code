/** Membaca bagian lain dari hasil tool besar yang disimpan selama task aktif. */

import type { Tool } from '../domain/tool.ts'
import { MAX_TOOL_RESULT_PAGE_CHARACTERS } from '../agent/toolResults.ts'

interface Args extends Record<string, unknown> { ref: string; offset?: number; limit?: number }

export const readToolOutputTool: Tool<Args> = {
  name: 'read_tool_output',
  description: 'Read another character range from a large tool result that Boo truncated earlier in the current task. Use only the opaque reference shown in that result.',
  risk: 'safe',
  parallelSafe: true,
  schema: {
    type: 'function',
    function: {
      name: 'read_tool_output',
      description: 'Page through a large tool result retained in memory for the current task.',
      parameters: {
        type: 'object',
        properties: {
          ref: { type: 'string', pattern: '^[a-f0-9]{16}$', description: 'Opaque reference printed in a truncated tool result' },
          offset: { type: 'integer', minimum: 1, description: 'First character to read, 1-based; defaults to 1' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_TOOL_RESULT_PAGE_CHARACTERS, description: `Maximum characters; defaults to ${MAX_TOOL_RESULT_PAGE_CHARACTERS}` },
        },
        required: ['ref'],
      },
    },
  },
  preview: (args) => `baca hasil tool ${args.ref}${args.offset ? ` dari karakter ${args.offset}` : ''}`,
  async run(args, context) {
    if (!context.toolResults) return { content: 'Gagal: penyimpanan hasil tool tidak tersedia.', isError: true }
    return context.toolResults.read(args.ref, args.offset, args.limit)
  },
}
