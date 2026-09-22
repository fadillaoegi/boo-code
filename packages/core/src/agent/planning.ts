/** Plan Mode ringan: investigasi read-only lalu implementasi dari riwayat sesi. */

import type { Message } from '../domain/message.ts'
import { splitUndoNote } from './checkpoints.ts'
import { referencedPromptTitle } from './references.ts'

export const PLAN_PROMPT_MARK = '[Boo plan mode request]'
export const IMPLEMENT_PLAN_PROMPT_MARK = '[Boo implement plan request]'

export const PLAN_SYSTEM_PROMPT = `You are planning an implementation in read-only mode.

Investigate the actual repository before deciding what should change. You may read
files, search code, inspect git state, query language servers, run diagnostics, and
delegate read-only research. Do not edit files, run commands with side effects, or
claim that implementation is complete.

Resolve uncertainty from repository evidence whenever possible. Call out only the
decisions that genuinely require the user. Your final answer must be a concrete,
actionable implementation plan: summarize the intended outcome, name the relevant
files and symbols, give ordered implementation steps, include validation/tests, and
note material risks or edge cases. Keep the plan proportional to the task.`

export interface SavedPlan {
  task: string
  plan: string
}

/** Prompt bertanda agar rencana dapat ditemukan lagi setelah sesi dilanjutkan. */
export function planRequest(task: string): string {
  const value = task.trim()
  if (!value) throw new Error('Tulis tugas setelah /plan.')
  return `${PLAN_PROMPT_MARK}\n${value}`
}

/** Mengembalikan tugas asli dari prompt Plan Mode, atau null untuk prompt biasa. */
export function planPromptTitle(content: string): string | null {
  const raw = splitUndoNote(content).text
  const text = referencedPromptTitle(raw) ?? raw
  if (!text.startsWith(`${PLAN_PROMPT_MARK}\n`)) return null
  const task = text.slice(PLAN_PROMPT_MARK.length + 1).trim()
  return task || null
}

export function isImplementPlanRequest(content: string): boolean {
  const raw = splitUndoNote(content).text
  return (referencedPromptTitle(raw) ?? raw).startsWith(`${IMPLEMENT_PLAN_PROMPT_MARK}\n`)
}

/**
 * Menemukan jawaban final dari permintaan /plan terbaru. Tool-call antara pertanyaan
 * dan jawaban final sengaja dilewati; rencana yang terputus tidak dianggap siap.
 */
export function latestPlan(messages: readonly Message[]): SavedPlan | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' || !message.content) continue
    const task = planPromptTitle(message.content)
    if (task === null) continue

    let end = messages.length
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      if (messages[cursor].role === 'user') {
        end = cursor
        break
      }
    }
    for (let cursor = end - 1; cursor > index; cursor -= 1) {
      const candidate = messages[cursor]
      if (candidate.role === 'assistant' && candidate.content?.trim() && !candidate.tool_calls?.length) {
        return { task, plan: candidate.content.trim() }
      }
    }
    return null
  }
  return null
}

/** Menjalankan rencana sebagai permintaan normal, setelah keadaan repo diperiksa ulang. */
export function implementPlanRequest(saved: SavedPlan): string {
  return `${IMPLEMENT_PLAN_PROMPT_MARK}
Implement the latest plan below. Reinspect the current repository state first because
it may have changed since planning. Treat the plan as a strategy, adjust details when
repository evidence requires it, then implement the task fully and run proportional
validation. Do not merely repeat or discuss the plan.

Original task:
${saved.task}

Plan:
${saved.plan}`
}
