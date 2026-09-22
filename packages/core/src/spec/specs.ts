/**
 * Mode spec: fitur dirancang dulu, baru dikerjakan — seperti Kiro.
 *
 * Permintaan besar yang langsung dikerjakan cenderung melenceng: asumsi model
 * tidak pernah diperiksa, dan pengguna baru melihat arahnya setelah kodenya jadi.
 * Mode spec memecahnya menjadi tiga dokumen yang ditinjau pengguna satu per satu:
 *
 *   .boo/specs/<nama>/requirements.md  — user story dan acceptance criteria
 *   .boo/specs/<nama>/design.md        — rancangan teknis berdasarkan requirements
 *   .boo/specs/<nama>/tasks.md         — checklist implementasi bertahap
 *
 * lalu tugas dikerjakan satu per satu, dan checkbox di tasks.md dicentang.
 * Semua keadaan ada di berkas itu sendiri: dapat di-commit, diedit tangan, dan
 * dilanjutkan di sesi mana pun.
 *
 * Modul ini hanya membaca berkas dan menyusun permintaan; penulisan dilakukan
 * model lewat tool biasa, dengan izin pengguna seperti perubahan lainnya.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { referencedPromptTitle } from '../agent/references.ts'

export const SPECS_DIRECTORY = '.boo/specs'

/** Penanda permintaan mode spec, agar tampilan dapat meringkasnya ke baris pertama. */
export const SPEC_PROMPT_MARK = '[spec] '

export type SpecStage = 'requirements' | 'design' | 'tasks' | 'implementing' | 'done'

export interface SpecTask {
  /** Nomor seperti tertulis, misalnya "2" atau "2.1". */
  number: string
  title: string
  done: boolean
  /** Baris di tasks.md, dimulai dari 1. */
  line: number
}

export interface SpecSummary {
  name: string
  directory: string
  hasRequirements: boolean
  hasDesign: boolean
  hasTasks: boolean
  tasks: SpecTask[]
  stage: SpecStage
  updatedAt: number
}

const TASK_PATTERN = /^\s*[-*]\s+\[([ xX])\]\s+(?:(\d+(?:\.\d+)*)\.?\s+)?(.+?)\s*$/

/** Checkbox di tasks.md, termasuk sub-tugas yang bernomor seperti 2.1. */
export function parseTasks(markdown: string): SpecTask[] {
  const tasks: SpecTask[] = []
  markdown.split('\n').forEach((text, index) => {
    const match = TASK_PATTERN.exec(text)
    if (!match) return
    tasks.push({
      number: match[2] ?? String(tasks.length + 1),
      title: match[3].replace(/\*\*/g, ''),
      done: match[1] !== ' ',
      line: index + 1,
    })
  })
  return tasks
}

/** Nama folder yang aman dari ide fitur: huruf kecil, angka, dan tanda hubung. */
export function slugify(text: string): string {
  const slug = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, 48)
    .replace(/-+$/, '')
  return slug || 'fitur'
}

/** Nama yang belum dipakai di folder spec. */
export function uniqueSpecName(workspace: string, idea: string): string {
  const base = slugify(idea)
  let name = base
  for (let suffix = 2; existsSync(join(workspace, SPECS_DIRECTORY, name)); suffix += 1) name = `${base}-${suffix}`
  return name
}

function stageOf(summary: Omit<SpecSummary, 'stage'>): SpecStage {
  if (!summary.hasRequirements) return 'requirements'
  if (!summary.hasDesign) return 'design'
  if (!summary.hasTasks || !summary.tasks.length) return 'tasks'
  return summary.tasks.every((task) => task.done) ? 'done' : 'implementing'
}

export function readSpec(workspace: string, name: string): SpecSummary | null {
  const directory = join(workspace, SPECS_DIRECTORY, name)
  let updatedAt: number
  try {
    const info = statSync(directory)
    if (!info.isDirectory()) return null
    updatedAt = info.mtimeMs
  } catch {
    return null
  }
  const file = (fileName: string) => join(directory, fileName)
  const hasTasks = existsSync(file('tasks.md'))
  const tasks = hasTasks ? parseTasks(readFileSync(file('tasks.md'), 'utf8')) : []
  for (const fileName of ['requirements.md', 'design.md', 'tasks.md']) {
    try {
      updatedAt = Math.max(updatedAt, statSync(file(fileName)).mtimeMs)
    } catch {
      // Berkas tahap ini belum ada.
    }
  }
  const summary = {
    name,
    directory,
    hasRequirements: existsSync(file('requirements.md')),
    hasDesign: existsSync(file('design.md')),
    hasTasks,
    tasks,
    updatedAt,
  }
  return { ...summary, stage: stageOf(summary) }
}

/** Spec di workspace, yang terakhir disentuh lebih dulu. */
export function listSpecs(workspace: string): SpecSummary[] {
  let names: string[]
  try {
    names = readdirSync(join(workspace, SPECS_DIRECTORY))
  } catch {
    return []
  }
  return names
    .map((name) => readSpec(workspace, name))
    .filter((spec): spec is SpecSummary => Boolean(spec))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function nextTask(spec: SpecSummary): SpecTask | undefined {
  return spec.tasks.find((task) => !task.done)
}

/* ---------------------------------------------------------------- permintaan */

function path(name: string, fileName: string): string {
  return `${SPECS_DIRECTORY}/${name}/${fileName}`
}

const WRITE_ONLY_SPEC = 'Jangan mengubah berkas selain berkas spec ini, dan jangan menulis kode implementasi.'

export function requirementsPrompt(name: string, idea: string): string {
  return `${SPEC_PROMPT_MARK}${name} · requirements — ${idea.replace(/\s+/g, ' ')}

Mode spec, tahap 1 dari 3: requirements.

Ide fitur dari pengguna:
${idea}

Selidiki kode yang relevan secukupnya (grep, glob, read_file) agar requirements sesuai dengan proyek yang ada. Lalu tulis ${path(name, 'requirements.md')} dengan format:

# Requirements: <judul fitur>

## Pendahuluan
<ringkasan fitur, masalah yang diselesaikan, dan batas cakupannya>

## Requirements

### Requirement 1: <nama singkat>
**User story:** Sebagai <peran>, saya ingin <kemampuan>, agar <manfaat>.

#### Acceptance criteria
1. WHEN <kejadian> THEN sistem SHALL <perilaku yang dapat diuji>
2. IF <kondisi> THEN sistem SHALL <perilaku>

Cakup juga kasus tepi, error, dan validasi masukan. Setiap kriteria harus dapat diuji. ${WRITE_ONLY_SPEC}

Setelah berkas ditulis, ringkas requirements-nya dalam beberapa poin, lalu sebutkan asumsi yang kamu buat dan pertanyaan terbuka bila ada.`
}

export function designPrompt(name: string): string {
  return `${SPEC_PROMPT_MARK}${name} · design

Mode spec, tahap 2 dari 3: design.

Baca ${path(name, 'requirements.md')}, lalu selidiki kode yang akan tersentuh. Tulis ${path(name, 'design.md')} dengan bagian:

# Design: <judul fitur>
## Ikhtisar — pendekatan yang dipilih dan alasannya
## Arsitektur — bagaimana fitur ini masuk ke struktur yang ada (diagram mermaid bila membantu)
## Komponen dan antarmuka — berkas yang dibuat atau diubah, fungsi, tipe, dan tanggung jawabnya
## Model data — struktur data dan perubahannya, bila ada
## Penanganan error
## Strategi pengujian — apa yang diuji dan di mana

Ikuti konvensi proyek yang sudah ada. Rujuk nomor requirement yang dipenuhi setiap bagian, dan pastikan setiap requirement terpenuhi. ${WRITE_ONLY_SPEC}

Setelah berkas ditulis, ringkas keputusan desain utamanya dan pertukaran (trade-off) yang diambil.`
}

export function tasksPrompt(name: string): string {
  return `${SPEC_PROMPT_MARK}${name} · tasks

Mode spec, tahap 3 dari 3: tasks.

Baca ${path(name, 'requirements.md')} dan ${path(name, 'design.md')}. Tulis ${path(name, 'tasks.md')} berisi checklist implementasi berurutan:

# Tasks: <judul fitur>

- [ ] 1. <tugas coding yang konkret>
  - <rincian: berkas yang dibuat atau diubah, dan apa yang dilakukan>
  - _Requirements: 1.1, 2.3_
- [ ] 2. <tugas berikutnya>

Aturan:
- Setiap tugas kecil: dapat dikerjakan dan diverifikasi dalam satu permintaan.
- Inkremental: setiap tugas dibangun di atas tugas sebelumnya, tanpa kode yang menggantung.
- Test ditulis bersama kode yang diujinya, bukan dikumpulkan di akhir.
- Hanya tugas coding. Tanpa deploy, tanpa pengujian manual oleh pengguna.
- Setiap requirement tercakup oleh setidaknya satu tugas.

${WRITE_ONLY_SPEC} Setelah berkas ditulis, sebutkan jumlah tugasnya dan urutan besarnya.`
}

export function taskPrompt(name: string, task: SpecTask): string {
  return `${SPEC_PROMPT_MARK}${name} · tugas ${task.number} — ${task.title}

Mode spec: kerjakan satu tugas.

Baca ${path(name, 'requirements.md')}, ${path(name, 'design.md')}, dan ${path(name, 'tasks.md')} lebih dulu. Kerjakan HANYA tugas ${task.number} ("${task.title}") beserta rinciannya, mengikuti design.

Verifikasi hasilnya dengan test, typecheck, atau build bila tersedia, dan perbaiki bila gagal. Setelah tugas benar-benar selesai, ubah checkbox tugas ${task.number} di ${path(name, 'tasks.md')} dari [ ] menjadi [x] dengan edit_file. Jangan mengerjakan tugas berikutnya.

Akhiri dengan ringkasan singkat: apa yang diubah dan bagaimana diverifikasi.`
}

export type SpecDocument = 'requirements.md' | 'design.md' | 'tasks.md'

export function revisePrompt(name: string, document: SpecDocument, feedback: string): string {
  const stage = document.replace('.md', '')
  return `${SPEC_PROMPT_MARK}${name} · revisi ${stage} — ${feedback.replace(/\s+/g, ' ')}

Mode spec: revisi ${stage}.

Perbarui ${path(name, document)} sesuai arahan pengguna:
${feedback}

Pertahankan format dan bagian yang tidak terkait arahan. Bila perubahan ini membuat dokumen tahap lain di folder yang sama tidak lagi sesuai, sebutkan bagian mana yang perlu diperbarui, tetapi jangan mengubahnya. ${WRITE_ONLY_SPEC}

Setelah berkas diperbarui, ringkas apa yang berubah.`
}

/** Baris pertama permintaan spec, tanpa penanda — untuk ditampilkan. */
export function specPromptTitle(content: string): string | null {
  const visible = referencedPromptTitle(content) ?? content
  if (!visible.startsWith(SPEC_PROMPT_MARK)) return null
  return visible.slice(SPEC_PROMPT_MARK.length).split('\n')[0]
}
