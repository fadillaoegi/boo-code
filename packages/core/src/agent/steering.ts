/** Arahan pengguna yang masuk ketika satu permintaan masih dikerjakan. */

export const USER_STEERING_MARK = '[USER STEERING]'
export const STEERING_SKIPPED_TOOL_RESULT = 'Dilewati: pengguna mengirim arahan baru sebelum tool dijalankan. Rencanakan ulang berdasarkan arahan terbaru.'
export const MAX_STEERING_MESSAGES = 10
export const MAX_STEERING_CHARACTERS = 8_000
export const MAX_STEERING_TOTAL_CHARACTERS = 32_000

/** Membatasi input live agar antrean tidak dapat membengkakkan konteks tanpa batas. */
export function normalizeSteering(input: string): string {
  const text = input.replace(/\r\n?/g, '\n').trim()
  if (!text) throw new Error('Arahan tidak boleh kosong.')
  if (text.length > MAX_STEERING_CHARACTERS) {
    throw new Error(`Arahan maksimal ${MAX_STEERING_CHARACTERS.toLocaleString('id-ID')} karakter.`)
  }
  return text
}

/** Satu pesan user menjaga urutan provider tetap sah walau beberapa arahan menunggu. */
export function steeringMessage(inputs: readonly string[]): string {
  const body = inputs.length === 1
    ? inputs[0]
    : inputs.map((input, index) => `${index + 1}. ${input}`).join('\n\n')
  return `${USER_STEERING_MARK}\n${body}`
}

/** Menghapus marker internal saat sesi dibangun ulang untuk tampilan. */
export function steeringPromptTitle(content: string): string | null {
  const marker = `${USER_STEERING_MARK}\n`
  const index = content.startsWith(marker) ? 0 : content.indexOf(`\n\n${marker}`) + 2
  if (index < 2 && !content.startsWith(marker)) return null
  return content.slice(index + marker.length).trim()
}
