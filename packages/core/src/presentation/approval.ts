/**
 * Menyebut permintaan izin dengan bahasa manusia, untuk panel CLI dan kartu web.
 */

export type ApprovalKind = 'edit' | 'command' | 'other'

export interface ApprovalRequest {
  kind: ApprovalKind
  /** Judul di bingkai atas, misalnya "Buat berkas". */
  title: string
  /** Berkas atau keterangan yang dikenai tindakan. */
  subject: string
  /** Pertanyaan di atas pilihan, misalnya "Buat catatan.md?". */
  question: string
  /** Pilihan kedua: menyetujui dan tidak bertanya lagi untuk tindakan sejenis. */
  allowAlways: string
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'cs', php: 'php', dart: 'dart', scala: 'scala',
  sh: 'sh', bash: 'sh', zsh: 'sh', sql: 'sql', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
}

export function languageOf(path: string): string {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
  return LANGUAGE_BY_EXTENSION[extension] ?? ''
}

/** Menyebut tindakan tool dengan bahasa manusia. */
export function describeRequest(tool: string, args: Record<string, unknown>, fileExists: boolean): ApprovalRequest {
  const path = typeof args.path === 'string' ? args.path : ''
  switch (tool) {
    case 'write_file':
      return fileExists
        ? { kind: 'edit', title: 'Tulis ulang berkas', subject: path, question: `Tulis ulang ${path}?`, allowAlways: 'Ya, izinkan semua perubahan berkas di sesi ini' }
        : { kind: 'edit', title: 'Buat berkas', subject: path, question: `Buat ${path}?`, allowAlways: 'Ya, izinkan semua perubahan berkas di sesi ini' }
    case 'edit_file':
      return { kind: 'edit', title: 'Ubah berkas', subject: path, question: `Terapkan perubahan ke ${path}?`, allowAlways: 'Ya, izinkan semua perubahan berkas di sesi ini' }
    case 'apply_patch':
      return { kind: 'edit', title: 'Terapkan patch', subject: '', question: 'Terapkan seluruh perubahan patch ini?', allowAlways: 'Ya, izinkan semua perubahan berkas di sesi ini' }
    case 'delegate_write': {
      const tasks = Array.isArray(args.tasks) ? args.tasks : []
      const descriptions = tasks.map((entry) => {
        const task = entry as { id?: unknown; task?: unknown }
        return `- ${typeof task.id === 'string' ? task.id : 'task'}: ${typeof task.task === 'string' ? task.task : ''}`
      }).join('\n')
      return {
        kind: 'edit',
        title: 'Jalankan sub-agent penulis',
        subject: `${tasks.length} worktree terisolasi`,
        question: `Izinkan sub-agent mengerjakan task berikut di Git worktree terisolasi lalu menggabungkan hasil bebas konflik?${descriptions ? `\n\n${descriptions}` : ''}`,
        allowAlways: 'Tidak tersedia: setiap delegasi penulisan harus dikonfirmasi.',
      }
    }
    case 'bash':
      return { kind: 'command', title: args.run_in_background ? 'Jalankan perintah di latar belakang' : 'Jalankan perintah', subject: typeof args.description === 'string' ? args.description : '', question: 'Jalankan perintah ini?', allowAlways: 'Ya, jangan tanya lagi untuk perintah ini di sesi ini' }
    case 'git_commit': {
      const message = typeof args.message === 'string' ? args.message : ''
      const paths = Array.isArray(args.paths) ? args.paths.filter((path): path is string => typeof path === 'string') : []
      return {
        kind: 'other',
        title: 'Buat commit Git',
        subject: `${paths.length} file`,
        question: `Buat commit lokal berikut?\n\nPesan:\n${message}\n\nFile (seluruh isi saat ini):\n${paths.map((path) => `- ${path}`).join('\n')}\n\nPerubahan staged lain tidak ikut. Git hooks dan signing tidak dijalankan.`,
        allowAlways: 'Tidak tersedia: setiap commit harus dikonfirmasi.',
      }
    }
    case 'bash_input': {
      const id = typeof args.id === 'string' ? args.id : 'proses'
      const input = typeof args.input === 'string' ? args.input : ''
      const exact = `${input}${args.append_newline === false ? '' : '\n'}`
      return {
        kind: 'other',
        title: 'Kirim input ke proses',
        subject: id,
        question: `Kirim input berikut ke ${id}?\n\n${JSON.stringify(exact)}${args.close_stdin === true ? '\n\nstdin akan ditutup setelahnya.' : ''}`,
        allowAlways: 'Tidak tersedia: setiap input proses harus dikonfirmasi.',
      }
    }
    case 'diagnostics': {
      const kind = typeof args.kind === 'string' ? args.kind : 'types + lint'
      return { kind: 'command', title: 'Jalankan diagnostics', subject: kind, question: `Jalankan diagnostics proyek (${kind})?`, allowAlways: 'Ya, jangan tanya lagi untuk diagnostics di sesi ini' }
    }
    case 'lsp': {
      const action = typeof args.action === 'string' ? args.action : 'query'
      return { kind: 'command', title: 'Jalankan language server', subject: path, question: `Jalankan LSP ${action} untuk ${path}?`, allowAlways: 'Ya, izinkan query LSP lain di sesi ini' }
    }
    case 'mcp_list_tools': {
      const server = typeof args.server === 'string' ? args.server : 'server'
      return { kind: 'command', title: 'Jalankan MCP server', subject: server, question: `Jalankan ${server} untuk melihat tools MCP?`, allowAlways: `Ya, izinkan discovery ${server} di sesi ini` }
    }
    case 'mcp_call': {
      const server = typeof args.server === 'string' ? args.server : 'server'
      const mcpTool = typeof args.tool === 'string' ? args.tool : 'tool'
      return { kind: 'other', title: 'Panggil MCP tool', subject: `${server}/${mcpTool}`, question: `Panggil MCP ${server}/${mcpTool}?\n\nArguments:\n${JSON.stringify(args.arguments ?? {}, null, 2)}`, allowAlways: 'Tidak tersedia: setiap MCP call harus dikonfirmasi.' }
    }
    case 'open_app': {
      const app = typeof args.id === 'string' ? args.id : 'aplikasi ini'
      return { kind: 'other', title: 'Buka aplikasi', subject: app, question: `Buka aplikasi ${app}?`, allowAlways: `Ya, jangan tanya lagi untuk aplikasi ${app} di sesi ini` }
    }
    case 'browser_tabs':
      return { kind: 'other', title: 'Lihat tab browser', subject: 'Chrome/Edge lokal', question: 'Izinkan Boo melihat judul dan URL tab browser lokal? Nilai query URL akan disembunyikan.', allowAlways: 'Tidak tersedia: metadata browser selalu memerlukan persetujuan baru.' }
    case 'browser_open': {
      const url = typeof args.url === 'string' ? args.url : ''
      return { kind: 'other', title: 'Buka tab browser', subject: url, question: `Buka URL ini di tab baru?\n\n${url}`, allowAlways: 'Tidak tersedia: setiap navigasi browser harus dikonfirmasi.' }
    }
    case 'browser_navigate': {
      const tab = typeof args.tab_id === 'string' ? args.tab_id : 'tab ini'
      const url = typeof args.url === 'string' ? args.url : ''
      return { kind: 'other', title: 'Navigasi tab browser', subject: tab, question: `Navigasikan tab ${tab} ke URL ini?\n\n${url}`, allowAlways: 'Tidak tersedia: setiap navigasi browser harus dikonfirmasi.' }
    }
    case 'browser_snapshot': {
      const tab = typeof args.tab_id === 'string' ? args.tab_id : 'tab ini'
      return { kind: 'other', title: 'Baca halaman browser', subject: tab, question: `Izinkan Boo membaca teks terlihat dan elemen interaktif dari tab ${tab}?`, allowAlways: 'Tidak tersedia: setiap pembacaan halaman harus dikonfirmasi.' }
    }
    case 'browser_diagnostics': {
      const tab = typeof args.tab_id === 'string' ? args.tab_id : 'tab ini'
      const reload = args.reload === true
      const wait = typeof args.wait_ms === 'number' ? args.wait_ms : 2000
      return { kind: 'other', title: 'Diagnostik browser', subject: tab, question: `Pantau error console dan jaringan tab ${tab} selama ${wait} ms${reload ? ' setelah memuat ulang halaman' : ''}? Header, cookie, dan body respons tidak dibaca.`, allowAlways: 'Tidak tersedia: setiap diagnostik browser harus dikonfirmasi.' }
    }
    case 'browser_click': {
      const tab = typeof args.tab_id === 'string' ? args.tab_id : 'tab'
      const ref = typeof args.ref === 'string' ? args.ref : 'elemen'
      const description = typeof args.description === 'string' ? args.description : ''
      return { kind: 'other', title: 'Klik di browser', subject: description || ref, question: `Klik ${description || ref} (${ref}) pada tab ${tab}? Klik dapat menjalankan aksi pada situs.`, allowAlways: 'Tidak tersedia: setiap klik browser harus dikonfirmasi.' }
    }
    case 'browser_type': {
      const tab = typeof args.tab_id === 'string' ? args.tab_id : 'tab'
      const ref = typeof args.ref === 'string' ? args.ref : 'kolom'
      const description = typeof args.description === 'string' ? args.description : ''
      const value = typeof args.text === 'string' ? args.text : ''
      return { kind: 'other', title: 'Ketik di browser', subject: description || ref, question: `Ketik teks berikut ke ${description || ref} (${ref}) pada tab ${tab}?\n\n${value}`, allowAlways: 'Tidak tersedia: setiap input browser harus dikonfirmasi.' }
    }
    case 'browser_select': {
      const tab = typeof args.tab_id === 'string' ? args.tab_id : 'tab'
      const ref = typeof args.ref === 'string' ? args.ref : 'dropdown'
      const description = typeof args.description === 'string' ? args.description : ''
      const option = typeof args.option === 'string' ? args.option : ''
      return { kind: 'other', title: 'Pilih dropdown browser', subject: description || ref, question: `Pilih “${option}” pada ${description || ref} (${ref}) di tab ${tab}?`, allowAlways: 'Tidak tersedia: setiap perubahan dropdown harus dikonfirmasi.' }
    }
    case 'browser_press': {
      const tab = typeof args.tab_id === 'string' ? args.tab_id : 'tab'
      const ref = typeof args.ref === 'string' ? args.ref : 'elemen'
      const description = typeof args.description === 'string' ? args.description : ''
      const key = typeof args.key === 'string' ? args.key : 'tombol'
      return { kind: 'other', title: 'Tekan tombol browser', subject: description || ref, question: `Tekan ${key} pada ${description || ref} (${ref}) di tab ${tab}? Tindakan ini dapat memicu aksi pada situs.`, allowAlways: 'Tidak tersedia: setiap tombol browser harus dikonfirmasi.' }
    }
    case 'whatsapp_send_message': {
      const recipient = typeof args.recipient === 'string' ? args.recipient : 'penerima ini'
      const message = typeof args.message === 'string' ? args.message : ''
      return {
        kind: 'other',
        title: 'Kirim pesan WhatsApp',
        subject: recipient,
        question: `Kirim pesan WhatsApp ke ${recipient}?\n\nIsi pesan:\n${message}`,
        allowAlways: 'Tidak tersedia: setiap pesan WhatsApp harus dikonfirmasi.',
      }
    }
    case 'memory_add': {
      const text = typeof args.text === 'string' ? args.text : ''
      return {
        kind: 'other',
        title: 'Simpan memori proyek',
        subject: typeof args.category === 'string' ? args.category : 'other',
        question: `Ingat catatan ini untuk sesi berikutnya?\n\n${text}`,
        allowAlways: 'Tidak tersedia: setiap catatan memori harus dikonfirmasi.',
      }
    }
    case 'memory_remove': {
      const id = typeof args.id === 'string' ? args.id : ''
      return {
        kind: 'other',
        title: 'Hapus memori proyek',
        subject: id,
        question: `Hapus memori proyek ${id}?`,
        allowAlways: 'Tidak tersedia: setiap penghapusan memori harus dikonfirmasi.',
      }
    }
    default:
      return { kind: 'other', title: `Izin ${tool}`, subject: path, question: `Izinkan ${tool}?`, allowAlways: `Ya, jangan tanya lagi untuk ${tool} di sesi ini` }
  }
}
