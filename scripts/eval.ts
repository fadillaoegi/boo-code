#!/usr/bin/env node
/** Menjalankan benchmark Boo pada salinan fixture, tanpa menyentuh proyek sumber. */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  Agent,
  compareEvalBaseline,
  createDefaultRegistry,
  createEvalBaseline,
  createEvalRunReport,
  evaluateAgentRun,
  loadInstructions,
  loadAutoPerformanceProfile,
  NineRouterProvider,
  parseEvalBaseline,
  parseEvalSuite,
  resolveEvalFixture,
  resolveSandboxPolicy,
  saveAutoPerformanceProfile,
  selectEvalCases,
  validateEvalFixtures,
  updateAutoPerformanceProfile,
  type AgentEvent,
  type EvalCaseReport,
  type ModelMode,
} from '../packages/core/src/index.ts'
import { loadConfig } from '../packages/core/src/config/config.ts'

interface CliOptions {
  suitePath: string
  keep: boolean
  validate: boolean
  cases: string[]
  tags: string[]
  report?: string
  baseline?: string
  writeBaseline?: string
  tolerance: number
  model?: string
  effort?: string
  updateAutoProfile: boolean
}

const HELP = `Pakai: pnpm eval <suite.json> [opsi]

Opsi:
  --validate               validasi schema dan fixture tanpa API key
  --case <id>              jalankan satu kasus; dapat diulang
  --tag <tag>              jalankan kategori; dapat diulang
  --model <id|auto>        timpa model dari suite
  --effort <level>         tingkat penalaran untuk model manual
  --report <path.json>     tulis laporan mesin yang lengkap
  --baseline <path.json>   gagal bila hasil turun dari baseline
  --write-baseline <path>  simpan hasil saat ini sebagai baseline baru
  --update-auto-profile    gabungkan hasil ke profil Auto privat di ~/.boo
  --tolerance <0-100>      penurunan skor yang diizinkan (default 0)
  --keep                   pertahankan workspace temporer
  --help                   tampilkan bantuan`

function nextValue(args: string[], index: number, flag: string): string {
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} memerlukan nilai.`)
  return value
}

function parseArguments(args: string[]): CliOptions | null {
  if (args.includes('--help')) return null
  let suitePath: string | undefined
  let keep = false
  let validate = false
  let report: string | undefined
  let baseline: string | undefined
  let writeBaseline: string | undefined
  let tolerance = 0
  let model: string | undefined
  let effort: string | undefined
  let updateAutoProfile = false
  const cases: string[] = []
  const tags: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!argument.startsWith('--')) {
      if (suitePath) throw new Error(`Argumen posisi berlebih: ${argument}`)
      suitePath = argument
      continue
    }
    if (argument === '--keep') keep = true
    else if (argument === '--validate') validate = true
    else if (argument === '--update-auto-profile') updateAutoProfile = true
    else if (argument === '--case') cases.push(nextValue(args, index++, argument))
    else if (argument === '--tag') tags.push(nextValue(args, index++, argument))
    else if (argument === '--model') model = nextValue(args, index++, argument)
    else if (argument === '--effort') effort = nextValue(args, index++, argument)
    else if (argument === '--report') report = nextValue(args, index++, argument)
    else if (argument === '--baseline') baseline = nextValue(args, index++, argument)
    else if (argument === '--write-baseline') writeBaseline = nextValue(args, index++, argument)
    else if (argument === '--tolerance') {
      const raw = nextValue(args, index++, argument)
      tolerance = Number(raw)
      if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) throw new Error('--tolerance harus berupa angka 0-100.')
    } else throw new Error(`Opsi tidak dikenal: ${argument}`)
  }
  if (!suitePath) throw new Error('Path suite belum diberikan.')
  return { suitePath: resolve(suitePath), keep, validate, cases, tags, tolerance, updateAutoProfile, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(report ? { report: resolve(report) } : {}), ...(baseline ? { baseline: resolve(baseline) } : {}), ...(writeBaseline ? { writeBaseline: resolve(writeBaseline) } : {}) }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

async function main(): Promise<void> {
  let options: CliOptions | null
  try {
    options = parseArguments(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Argumen tidak valid.')
    console.error(`\n${HELP}`)
    process.exitCode = 2
    return
  }
  if (!options) {
    console.log(HELP)
    return
  }

  let suite
  try {
    suite = parseEvalSuite(JSON.parse(readFileSync(options.suitePath, 'utf8')))
  } catch (error) {
    console.error(`Suite tidak valid: ${error instanceof Error ? error.message : 'error tidak dikenal'}`)
    process.exitCode = 2
    return
  }
  const fixtureIssues = validateEvalFixtures(suite, options.suitePath)
  if (fixtureIssues.length) {
    console.error('Fixture tidak valid:')
    for (const issue of fixtureIssues) console.error(`  - ${issue}`)
    process.exitCode = 2
    return
  }
  const selected = selectEvalCases(suite, options.cases, options.tags)
  if (!selected.length) {
    console.error('Tidak ada kasus yang cocok dengan filter.')
    process.exitCode = 2
    return
  }
  const knownIds = new Set(suite.cases.map((item) => item.id))
  const unknownIds = options.cases.filter((id) => !knownIds.has(id))
  if (unknownIds.length) {
    console.error(`Kasus tidak dikenal: ${unknownIds.join(', ')}`)
    process.exitCode = 2
    return
  }
  if (options.validate) {
    const tags = new Set(suite.cases.flatMap((item) => item.tags))
    console.log(`VALID ${suite.name} · ${suite.cases.length} kasus · ${tags.size} kategori · ${selected.length} terpilih`)
    return
  }

  const config = loadConfig(process.cwd())
  const apiKey = config.NINEROUTER_KEY
  if (!apiKey) throw new Error('NINEROUTER_KEY belum dikonfigurasi. Jalankan boo-code setup.')
  const requestedModel = options.model ?? suite.model ?? config.BOO_MODEL ?? 'auto'
  const requestedEffort = options.effort ?? suite.effort
  const modelMode: ModelMode = requestedModel === 'auto' ? 'auto' : 'manual'
  const initialModel = requestedModel === 'auto' ? 'ag/gemini-3.1-pro' : requestedModel

  console.log(`\nEval: ${suite.name} · ${selected.length}/${suite.cases.length} kasus · ${requestedModel}`)
  console.log('Perintah shell ditolak kecuali sama persis dengan allowedCommands pada kasus.\n')
  const startedAt = new Date()
  const started = Date.now()
  const reports: EvalCaseReport[] = []
  for (const item of selected) {
    const fixture = resolveEvalFixture(options.suitePath, item.fixture)
    const workspace = mkdtempSync(join(tmpdir(), `boo-eval-${item.id.replace(/[^a-z0-9_-]/gi, '-')}-`))
    cpSync(fixture, workspace, { recursive: true })
    const caseStarted = Date.now()
    const provider = new NineRouterProvider({
      baseUrl: config.NINEROUTER_URL || 'http://localhost:20128',
      apiKey,
      model: initialModel,
      ...(requestedEffort ? { reasoningEffort: requestedEffort } : {}),
    })
    const allowed = new Set(item.allowedCommands)
    const agent = new Agent({
      provider,
      modelMode,
      registry: createDefaultRegistry(),
      workspace,
      sandbox: resolveSandboxPolicy('workspace-write', false),
      instructions: () => loadInstructions({ workspace }),
      askPermission: async ({ name, args }) => {
        if (name === 'write_file' || name === 'edit_file' || name === 'apply_patch') return true
        if (name === 'bash' && typeof args.command === 'string' && allowed.has(args.command)) return true
        return { allowed: false, feedback: 'Eval hanya mengizinkan perubahan file dan command yang tercantum persis di allowedCommands.' }
      },
      onTurnLimit: async () => false,
    })
    const events: AgentEvent[] = []
    try {
      for await (const event of agent.send(item.prompt)) events.push(event)
      const result = evaluateAgentRun(workspace, events, item.expect)
      const metrics = {
        ...result.metrics,
        model: result.metrics.model ?? initialModel,
        ...(result.metrics.reasoningEffort ?? requestedEffort ? { reasoningEffort: result.metrics.reasoningEffort ?? requestedEffort } : {}),
        ...(result.metrics.difficulty ?? item.difficulty ? { difficulty: result.metrics.difficulty ?? item.difficulty } : {}),
      }
      console.log(`${result.passed ? 'PASS' : 'FAIL'} ${item.id} · ${result.score}% · ${result.metrics.turns} turn · ${result.metrics.toolCalls} tool · ${Date.now() - caseStarted}ms`)
      for (const check of result.checks.filter((check) => !check.passed)) console.log(`  - ${check.name}: ${check.detail}`)
      reports.push({ id: item.id, tags: item.tags, score: result.score, passed: result.passed, durationMs: Date.now() - caseStarted, metrics, ...(options.keep ? { workspace } : {}) })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'error tidak dikenal'
      console.log(`FAIL ${item.id} · ${message}`)
      reports.push({ id: item.id, tags: item.tags, score: 0, passed: false, durationMs: Date.now() - caseStarted, error: message, ...(options.keep ? { workspace } : {}) })
    } finally {
      if (!options.keep) rmSync(workspace, { recursive: true, force: true })
    }
  }

  const report = createEvalRunReport({ suite: suite.name, model: requestedModel, ...(requestedEffort ? { effort: requestedEffort } : {}), startedAt, durationMs: Date.now() - started, cases: reports })
  console.log(`\nHasil: ${report.passed}/${report.total} lulus (${report.passRate}%) · skor rata-rata ${report.averageScore}%`)
  if (options.keep) for (const item of reports) console.log(`  ${item.id}: ${item.workspace}`)
  if (options.report) {
    writeJson(options.report, report)
    console.log(`Laporan: ${options.report}`)
  }
  if (options.writeBaseline) {
    writeJson(options.writeBaseline, createEvalBaseline(report))
    console.log(`Baseline: ${options.writeBaseline}`)
  }
  if (options.updateAutoProfile) {
    const home = homedir()
    const profile = updateAutoPerformanceProfile(loadAutoPerformanceProfile(home), report)
    const path = saveAutoPerformanceProfile(home, profile)
    console.log(`Profil Auto: ${path}`)
  }
  if (options.baseline) {
    const baseline = parseEvalBaseline(JSON.parse(readFileSync(options.baseline, 'utf8')))
    const comparison = compareEvalBaseline(report, baseline, options.tolerance)
    for (const regression of comparison.regressions) console.log(`REGRESSION ${regression.id} · ${regression.baselineScore}% → ${regression.currentScore}% · ${regression.reason}`)
    if (comparison.improvements.length) console.log(`Peningkatan: ${comparison.improvements.join(', ')}`)
    if (comparison.newCases.length) console.log(`Kasus baru: ${comparison.newCases.join(', ')}`)
    if (!comparison.passed) process.exitCode = 1
  }
  if (report.failed) process.exitCode = 1
}

await main()
