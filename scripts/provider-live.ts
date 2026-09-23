/** Opt-in live provider qualification. Never runs from the normal test suite. */

import { homedir } from 'node:os'
import { loadConfig } from '../packages/core/src/config/config.ts'
import type { ToolSchema } from '../packages/core/src/domain/message.ts'
import { NineRouterProvider } from '../packages/core/src/provider/nineRouter.ts'
import { profilesFromConfig, type ProviderProfile } from '../packages/core/src/provider/profiles.ts'

interface Options { provider?: string; model?: string; tools: boolean; json: boolean }
interface Result { provider: string; model: string; models: number; text: boolean; toolCall: boolean | null; durationMs: number; error?: string }

function parse(args: readonly string[]): Options {
  const options: Options = { tools: false, json: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--tools') { options.tools = true; continue }
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--provider' || arg === '--model') {
      const value = args[++index]
      if (!value) throw new Error(`${arg} membutuhkan nilai.`)
      if (arg === '--provider') options.provider = value
      else options.model = value
      continue
    }
    if (arg === '--help' || arg === '-h') {
      console.log('node scripts/provider-live.ts [--provider id] [--model id] [--tools] [--json]')
      process.exit(0)
    }
    throw new Error(`Opsi tidak dikenal: ${arg}`)
  }
  return options
}

const healthTool: ToolSchema = {
  type: 'function',
  function: {
    name: 'provider_health_check',
    description: 'Return the fixed provider qualification marker.',
    parameters: { type: 'object', properties: { marker: { type: 'string', enum: ['BOO_PROVIDER_OK'] } }, required: ['marker'] },
  },
}

async function qualify(profile: ProviderProfile, options: Options): Promise<Result> {
  const startedAt = Date.now()
  let selected = options.model ?? ''
  try {
    const provider = new NineRouterProvider({ baseUrl: profile.baseUrl, apiKey: profile.apiKey, profiles: [profile], model: selected || 'probe', timeoutMs: 45_000, home: homedir() })
    const models = await provider.listModels()
    if (!selected) selected = models[0] ?? ''
    if (!selected) throw new Error('Provider tidak mengembalikan model apa pun; berikan --model secara eksplisit.')
    provider.model = selected
    const prompt = options.tools
      ? 'Panggil tool provider_health_check tepat satu kali dengan marker BOO_PROVIDER_OK. Jangan menjawab dengan teks.'
      : 'Balas tepat dengan teks BOO_PROVIDER_OK dan tanpa kata lain.'
    const stream = provider.stream([{ role: 'user', content: prompt }], options.tools ? [healthTool] : [])
    let next = await stream.next()
    while (!next.done) next = await stream.next()
    const message = next.value.message
    const text = message.content?.includes('BOO_PROVIDER_OK') ?? false
    const toolCall = options.tools ? Boolean(message.tool_calls?.some((call) => call.function.name === 'provider_health_check' && call.function.arguments.includes('BOO_PROVIDER_OK'))) : null
    if (!text && toolCall !== true) throw new Error(options.tools ? 'Model tidak menghasilkan tool call yang diwajibkan.' : 'Model tidak mengembalikan marker teks.')
    return { provider: profile.id, model: selected, models: models.length, text, toolCall, durationMs: Date.now() - startedAt }
  } catch (error) {
    return { provider: profile.id, model: selected || options.model || '(belum dipilih)', models: 0, text: false, toolCall: options.tools ? false : null, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message.split('\n')[0].slice(0, 500) : 'Kualifikasi gagal.' }
  }
}

async function main(): Promise<void> {
  const options = parse(process.argv.slice(2))
  const profiles = profilesFromConfig(loadConfig(process.cwd())).filter((profile) => !options.provider || profile.id === options.provider)
  if (!profiles.length) throw new Error(options.provider ? `Provider ${options.provider} belum dikonfigurasi.` : 'Belum ada provider yang dikonfigurasi.')
  if (options.model && profiles.length > 1) throw new Error('--model harus dipakai bersama --provider agar tidak ambigu.')
  const results: Result[] = []
  for (const profile of profiles) results.push(await qualify(profile, options))
  if (options.json) for (const result of results) console.log(JSON.stringify(result))
  else for (const result of results) console.log(`${result.error ? 'FAIL' : 'PASS'} ${result.provider} · ${result.model} · list=${result.models} · text=${result.text} · tool=${result.toolCall ?? 'n/a'} · ${result.durationMs}ms${result.error ? ` · ${result.error}` : ''}`)
  if (results.some((result) => result.error)) process.exitCode = 1
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Live provider test gagal.')
  process.exitCode = 2
})
