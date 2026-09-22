/**
 * Halaman Boo Code web.
 *
 * Halaman tidak menyimpan keadaan agent sendiri: semuanya datang dari server lewat
 * event, dan setiap aksi dikirim balik ke server. Yang disimpan di sini hanya
 * keadaan tampilan — elemen per unsur, isian kotak ketik, dan tema.
 */

import type { ViewItem } from '@boo/core/presentation/view.ts'
import type { ImageAttachment, ModelFamilyView, ProviderStatusView, QuotaReportView, QuestionOption, ServerEvent, SessionView, Snapshot, SpecView } from '../protocol.ts'
import { Api, ApiError, takeToken } from './api.ts'
import { append, clear, h, renderMarkdown } from './dom.ts'
import { renderItem, renderQuestion, renderStatus } from './items.ts'

const THEME_KEY = 'boo-code-theme'
const BUILTIN_COMMANDS = [
  { name: '/plan', hint: 'selidiki dan buat rencana tanpa mengubah file' },
  { name: '/implement', hint: 'kerjakan rencana terbaru dari /plan' },
  { name: '/spec', hint: 'rancang fitur: requirements, design, tasks' },
  { name: '/undo', hint: 'batalkan perubahan berkas dari permintaan terakhir' },
  { name: '/restore', hint: 'pulihkan file ke checkpoint lama' },
  { name: '/compact', hint: 'ringkas percakapan agar konteks lega' },
  { name: '/context', hint: 'lihat pemakaian konteks model' },
  { name: '/fork', hint: 'cabangkan percakapan ke sesi eksperimen baru' },
  { name: '/rewind', hint: 'buat cabang dari sebelum prompt lama' },
  { name: '/stats', hint: 'lihat metrik lokal agent' },
  { name: '/review', hint: 'review perubahan tanpa mengedit' },
  { name: '/apps', hint: 'lihat aplikasi lokal yang terdaftar' },
  { name: '/open', hint: 'buka aplikasi terdaftar' },
  { name: '/run', hint: 'jalankan perintah dengan persetujuan' },
  { name: '/init', hint: 'tulis BOO.md berisi aturan proyek' },
  { name: '/commands', hint: 'lihat custom command proyek dan global' },
  { name: '/hooks', hint: 'lihat lifecycle hooks yang aktif' },
  { name: '/permissions', hint: 'lihat aturan izin persisten yang aktif' },
  { name: '/help', hint: 'daftar perintah' },
]

interface State {
  snapshot: Snapshot | null
  items: ViewItem[]
  elements: Map<string, HTMLElement>
  question: ReturnType<typeof renderQuestion> | null
  sessions: SessionView[]
  specs: SpecView[]
  providers: ProviderStatusView[]
}

const state: State = { snapshot: null, items: [], elements: new Map(), question: null, sessions: [], specs: [], providers: [] }

/* ------------------------------------------------------------------ tema */

function storedTheme(): string | null {
  try {
    return localStorage.getItem(THEME_KEY)
  } catch {
    return null
  }
}

function applyTheme(theme: string | null): void {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

function currentTheme(): 'light' | 'dark' {
  const explicit = document.documentElement.dataset.theme
  if (explicit === 'light' || explicit === 'dark') return explicit
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

applyTheme(storedTheme())

/* ------------------------------------------------------------------ kerangka */

const root = document.getElementById('app') as HTMLElement

function lockedScreen(message: string): void {
  clear(root)
  root.append(h('div', { class: 'locked' },
    h('img', { src: '/logo.png', alt: 'Boo' }),
    h('h1', {}, 'Boo Code'),
    h('p', {}, message),
    h('code', {}, 'boo-code web'),
  ))
}

const token = takeToken()
if (!token) {
  lockedScreen('Halaman ini perlu dibuka dari tautan yang dicetak di terminal.')
} else {
  start(new Api(token))
}

function start(api: Api): void {
  const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' })
  const toast = (message: string, tone: 'error' | 'info' = 'error') => {
    const element = h('div', { class: `toast ${tone}` }, message)
    toasts.append(element)
    setTimeout(() => element.remove(), 5_000)
  }
  const guard = async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      toast(error instanceof ApiError || error instanceof Error ? error.message : 'Terjadi kesalahan.')
    }
  }

  /* ---------------------------------------------------------- sidebar */

  const workspaceName = h('div', { class: 'workspace-name' })
  const workspacePath = h('div', { class: 'workspace-path' })
  const sessionList = h('ul', { class: 'nav-list' })
  const specList = h('ul', { class: 'nav-list' })
  const versionLabel = h('span', { class: 'version' })
  const themeButton = h('button', { class: 'icon-button', type: 'button', title: 'Ganti tema' })
  const updateThemeButton = () => { themeButton.textContent = currentTheme() === 'dark' ? '☀' : '☾' }
  updateThemeButton()
  themeButton.addEventListener('click', () => {
    const next = currentTheme() === 'dark' ? 'light' : 'dark'
    applyTheme(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // Tema tetap berlaku sampai halaman ditutup.
    }
    updateThemeButton()
  })

  const sidebar = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('img', { src: '/logo.png', alt: '' }), h('div', {}, h('div', { class: 'brand-name' }, 'Boo Code'), workspaceName)),
    workspacePath,
    h('button', { class: 'button primary block', type: 'button', onClick: () => void guard(() => api.post('/api/session/new')) }, '+ Sesi baru'),
    h('button', { class: 'button block', type: 'button', onClick: () => void guard(() => api.post('/api/session/fork')) }, 'Cabangkan sesi'),
    h('button', { class: 'button block', type: 'button', onClick: () => void guard(() => api.post('/api/session/rewind')) }, 'Putar balik'),
    h('div', { class: 'nav-title' }, 'Sesi'),
    sessionList,
    h('div', { class: 'nav-title' }, 'Spec', h('button', { class: 'link-button', type: 'button', onClick: () => insertCommand('/spec ') }, '+ baru')),
    specList,
    h('div', { class: 'sidebar-foot' }, versionLabel, themeButton),
  )

  const relative = (timestamp: number) => {
    const minutes = Math.floor((Date.now() - timestamp) / 60_000)
    if (minutes < 1) return 'baru saja'
    if (minutes < 60) return `${minutes} menit lalu`
    const hours = Math.floor(minutes / 60)
    return hours < 24 ? `${hours} jam lalu` : `${Math.floor(hours / 24)} hari lalu`
  }

  const renderSessions = () => {
    clear(sessionList)
    if (!state.sessions.length) sessionList.append(h('li', { class: 'empty' }, 'Belum ada sesi di direktori ini.'))
    for (const session of state.sessions) {
      sessionList.append(h('li', {}, h('button', {
        class: `nav-item${session.current ? ' active' : ''}`,
        type: 'button',
        title: session.title,
        onClick: () => {
          if (session.current) return
          document.body.classList.remove('nav-open')
          void guard(() => api.post('/api/session/resume', { id: session.id }))
        },
      }, h('span', { class: 'nav-item-title' }, session.title), h('span', { class: 'nav-item-meta' }, relative(session.updatedAt)))))
    }
  }

  const stageLabel = (spec: SpecView) => ({
    requirements: 'belum ada requirements',
    design: 'berikutnya design',
    tasks: 'berikutnya tasks',
    implementing: `tugas ${spec.done}/${spec.total}`,
    done: `selesai · ${spec.total} tugas`,
  })[spec.stage]

  const renderSpecs = () => {
    clear(specList)
    if (!state.specs.length) specList.append(h('li', { class: 'empty' }, 'Ketik /spec <ide> untuk merancang fitur.'))
    for (const spec of state.specs) {
      specList.append(h('li', {}, h('button', {
        class: 'nav-item',
        type: 'button',
        onClick: () => {
          document.body.classList.remove('nav-open')
          void guard(() => api.post('/api/spec/open', { name: spec.name }))
        },
      }, h('span', { class: 'nav-item-title' }, spec.name), h('span', { class: `nav-item-meta${spec.stage === 'done' ? ' done' : ''}` }, stageLabel(spec)))))
    }
  }

  const refreshLists = () => {
    void api.get<{ sessions: SessionView[] }>('/api/sessions').then(({ sessions }) => {
      state.sessions = sessions
      renderSessions()
    }).catch(() => undefined)
    void api.get<{ specs: SpecView[] }>('/api/specs').then(({ specs }) => {
      state.specs = specs
      renderSpecs()
    }).catch(() => undefined)
  }

  /* ---------------------------------------------------------- bagian utama */

  const modelButton = h('button', { class: 'model-button', type: 'button', title: 'Ganti model' })
  const instructionsChip = h('span', { class: 'chip', hidden: true })
  const connection = h('span', { class: 'connection', hidden: true }, 'Menyambung ulang…')
  const providersButton = h('button', { class: 'icon-button', type: 'button', title: 'Penyedia model dan kunci API' }, '⚙')
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'icon-button menu', type: 'button', title: 'Menu', onClick: () => document.body.classList.toggle('nav-open') }, '☰'),
    modelButton,
    instructionsChip,
    h('span', { class: 'spacer' }),
    connection,
    providersButton,
  )

  const log = h('div', { class: 'log-inner' })
  const scroller = h('section', { class: 'log' }, log)
  const empty = h('div', { class: 'empty-state' })

  const statusSlot = h('div', { class: 'status-slot' })
  const questionSlot = h('div', { class: 'question-slot' })
  const queueSlot = h('div', { class: 'queue-slot' })
  const commandMenu = h('ul', { class: 'command-menu', hidden: true })
  const attachmentStrip = h('div', { class: 'attachment-strip', hidden: true })
  const imageInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true })
  const attachButton = h('button', { class: 'button attach', type: 'button', title: 'Lampirkan gambar' }, '＋ Gambar')
  const textarea = h('textarea', { class: 'composer-input', rows: '1', placeholder: 'Minta Boo mengerjakan sesuatu…  (/ untuk perintah)' })
  const sendButton = h('button', { class: 'button primary', type: 'submit' }, 'Kirim')
  const stopButton = h('button', { class: 'button danger', type: 'button', hidden: true, onClick: () => void guard(() => api.post('/api/cancel')) }, 'Stop')
  const composer = h('form', { class: 'composer' }, commandMenu, attachmentStrip, imageInput, textarea, h('div', { class: 'composer-actions' }, attachButton, stopButton, sendButton))
  const dock = h('div', { class: 'dock' }, questionSlot, statusSlot, queueSlot, composer)

  const main = h('main', { class: 'main' }, topbar, scroller, dock)
  clear(root)
  append(root, [sidebar, main, h('div', { class: 'scrim', onClick: () => document.body.classList.remove('nav-open') }), toasts])

  /* ---------------------------------------------------------- gulir */

  let stick = true
  scroller.addEventListener('scroll', () => {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
  })
  const scrollToEnd = () => {
    if (stick) scroller.scrollTop = scroller.scrollHeight
  }

  /* ---------------------------------------------------------- unsur */

  const renderEmpty = () => {
    const snapshot = state.snapshot
    const hasItems = state.items.length > 0
    empty.hidden = hasItems
    if (hasItems || !snapshot) return
    clear(empty)
    append(empty, [
      h('img', { src: '/logo.png', alt: '' }),
      h('h1', {}, `Apa yang dikerjakan di ${workspaceTitle(snapshot.workspace)}?`),
      h('p', {}, 'Boo membaca kode di direktori ini dan meminta izin sebelum mengubah berkas atau menjalankan perintah.'),
      h('div', { class: 'suggestions' },
        [
          ['Jelaskan struktur proyek ini', 'Jelaskan struktur proyek ini secara singkat'],
          ['/init', '/init'],
          ['/spec', '/spec '],
        ].map(([label, text]) => h('button', { class: 'chip-button', type: 'button', onClick: () => insertCommand(text) }, label)),
      ),
    ])
  }

  const putItem = (item: ViewItem, toEnd = false) => {
    const index = state.items.findIndex((existing) => existing.id === item.id)
    const element = renderItem(item)
    const existing = state.elements.get(item.id)
    if (index === -1) {
      state.items.push(item)
      log.append(element)
    } else if (toEnd) {
      state.items.splice(index, 1)
      state.items.push(item)
      existing?.remove()
      log.append(element)
    } else {
      state.items[index] = item
      existing?.replaceWith(element)
    }
    state.elements.set(item.id, element)
    renderEmpty()
    scrollToEnd()
  }

  // Jawaban yang mengalir digambar ulang paling sering sekali per frame.
  const dirtyAnswers = new Set<string>()
  let frame = 0
  const flushAnswers = () => {
    frame = 0
    for (const id of dirtyAnswers) {
      const item = state.items.find((candidate) => candidate.id === id)
      const body = state.elements.get(id)?.querySelector('.markdown')
      if (item?.kind === 'answer' && body) renderMarkdown(body, item.markdown)
    }
    dirtyAnswers.clear()
    scrollToEnd()
  }

  const rebuild = (snapshot: Snapshot) => {
    const previousSession = state.snapshot?.sessionId
    state.snapshot = snapshot
    if (previousSession !== undefined && previousSession !== snapshot.sessionId) clearAttachments()
    state.items = []
    state.elements.clear()
    clear(log)
    log.append(empty)
    if (snapshot.omittedExchanges) {
      log.append(h('div', { class: 'item notice info' }, h('span', { class: 'mark' }, '…'), h('span', { class: 'text' }, `${snapshot.omittedExchanges} tukar-jawab sebelumnya tidak ditampilkan`)))
    }
    for (const item of snapshot.items) putItem(item)
    renderEmpty()
    workspaceName.textContent = workspaceTitle(snapshot.workspace)
    workspacePath.textContent = snapshot.workspace
    workspacePath.title = snapshot.workspace
    versionLabel.textContent = `v${snapshot.version}`
    document.title = `${workspaceTitle(snapshot.workspace)} · Boo Code`
    setModel(snapshot.model.label)
    instructionsChip.hidden = !snapshot.instructions.length
    instructionsChip.textContent = `Aturan: ${snapshot.instructions.join(', ')}`
    setBusy(snapshot.busy)
    setQueue(snapshot.queue)
    setStatus(snapshot.status)
    setQuestion(snapshot.question)
    stick = true
    scrollToEnd()
    refreshLists()
  }

  /* ---------------------------------------------------------- dock */

  let statusTimer = 0
  const setStatus = (status: Snapshot['status']) => {
    clearInterval(statusTimer)
    clear(statusSlot)
    if (!status) return
    statusSlot.append(renderStatus(status))
    statusTimer = window.setInterval(() => {
      clear(statusSlot)
      statusSlot.append(renderStatus(status))
    }, 1_000)
  }

  const setQuestion = (question: Snapshot['question']) => {
    clear(questionSlot)
    state.question = null
    if (!question) return
    const view = renderQuestion(question, (option: QuestionOption, text: string) => {
      void guard(() => api.post('/api/answer', { questionId: question.id, optionId: option.id, text }))
    })
    state.question = view
    questionSlot.append(view.element)
    view.element.scrollIntoView({ block: 'nearest' })
  }

  const setQueue = (queue: string[]) => {
    clear(queueSlot)
    if (!queue.length) return
    queueSlot.append(h('div', { class: 'queue' },
      h('span', { class: 'label' }, `Antre ${queue.length}`),
      h('span', { class: 'items' }, queue.map((text) => h('span', { class: 'queued', title: text }, text))),
      h('button', { class: 'link-button', type: 'button', onClick: () => void guard(() => api.post('/api/queue/clear')) }, 'Kosongkan'),
    ))
  }

  let busy = false
  const setBusy = (value: boolean) => {
    busy = value
    stopButton.hidden = !value
    sendButton.textContent = value ? 'Arahkan' : 'Kirim'
    document.body.classList.toggle('busy', value)
    if (!value) refreshLists()
  }

  const setModel = (label: string) => {
    clear(modelButton)
    append(modelButton, [h('span', { class: 'model-dot' }), label, h('span', { class: 'caret' }, '▾')])
  }

  /* ---------------------------------------------------------- kotak ketik */

  const pendingAttachments: ImageAttachment[] = []

  function clearAttachments(): void {
    pendingAttachments.length = 0
    renderAttachments()
  }

  function renderAttachments(): void {
    clear(attachmentStrip)
    attachmentStrip.hidden = !pendingAttachments.length
    for (const attachment of pendingAttachments) {
      attachmentStrip.append(h('span', { class: 'attachment-chip' },
        `▧ ${attachment.name}`,
        h('button', {
          type: 'button', title: `Lepas ${attachment.name}`,
          onClick: () => {
            const index = pendingAttachments.findIndex((item) => item.id === attachment.id && item.ref === attachment.ref)
            if (index !== -1) pendingAttachments.splice(index, 1)
            renderAttachments()
          },
        }, '×'),
      ))
    }
  }

  attachButton.addEventListener('click', () => imageInput.click())
  imageInput.addEventListener('change', () => {
    const files = [...(imageInput.files ?? [])]
    imageInput.value = ''
    void guard(async () => {
      for (const file of files) {
        if (pendingAttachments.length >= 5) throw new Error('Maksimal lima gambar per prompt.')
        if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} melebihi batas 10 MiB.`)
        attachButton.setAttribute('disabled', '')
        try { pendingAttachments.push(await api.uploadImage(file)) } finally { attachButton.removeAttribute('disabled') }
        renderAttachments()
      }
      textarea.focus()
    })
  })

  const resize = () => {
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`
  }

  function insertCommand(text: string): void {
    textarea.value = text
    textarea.focus()
    resize()
    updateCommandMenu()
  }

  const updateCommandMenu = () => {
    const value = textarea.value
    const custom = (state.snapshot?.commands ?? []).map((command) => ({ name: `/${command.name}`, hint: `${command.description} · ${command.source}` }))
    const commands = [...BUILTIN_COMMANDS, ...custom]
    const matches = value.startsWith('/') && !value.includes(' ') ? commands.filter((command) => command.name.startsWith(value)) : []
    commandMenu.hidden = !matches.length
    clear(commandMenu)
    for (const command of matches) {
      commandMenu.append(h('li', {}, h('button', {
        type: 'button',
        onClick: () => insertCommand(command.name === '/spec' || command.name === '/plan' || custom.includes(command) ? `${command.name} ` : command.name),
      }, h('strong', {}, command.name), h('span', {}, command.hint))))
    }
  }

  const submit = () => {
    const text = textarea.value.trim()
    if (!text && !pendingAttachments.length) return
    const attachments = pendingAttachments.splice(0)
    textarea.value = ''
    renderAttachments()
    resize()
    updateCommandMenu()
    stick = true
    void guard(() => api.post('/api/submit', { text, attachments }))
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })
  textarea.addEventListener('input', () => {
    resize()
    updateCommandMenu()
  })
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      const first = commandMenu.querySelector('button')
      if (!commandMenu.hidden && first && textarea.value !== first.querySelector('strong')?.textContent) {
        first.click()
        return
      }
      submit()
    }
  })

  /* ---------------------------------------------------------- pemilih model */

  const dialog = h('dialog', { class: 'model-dialog' })
  root.append(dialog)
  const openModels = async () => {
    clear(dialog)
    dialog.append(h('div', { class: 'dialog-head' }, h('strong', {}, 'Pilih model'), h('button', { class: 'icon-button', type: 'button', onClick: () => dialog.close() }, '✕')))
    const choose = (modelId: string, effort: string | null) => {
      dialog.close()
      void guard(() => api.post('/api/model', { modelId, effort }))
    }
    const autoActive = state.snapshot?.model.mode === 'auto'
    const manual = h('div', {}, h('p', { class: 'muted' }, 'Memuat daftar model dari 9Router…'))
    const body = h('div', { class: 'dialog-body' },
      h('button', { class: `model-row${autoActive ? ' active' : ''}`, type: 'button', onClick: () => choose('auto', null) },
        h('span', { class: 'model-name' }, 'Auto · sesuai kesulitan tugas'), autoActive ? h('span', { class: 'tag' }, 'aktif') : null),
      h('p', { class: 'muted' }, 'Model dan tingkat penalaran dipilih ulang untuk setiap permintaan.'),
      manual,
    )
    dialog.append(body)
    dialog.showModal()
    let families: ModelFamilyView[]
    try {
      families = (await api.get<{ families: ModelFamilyView[] }>('/api/models')).families
    } catch (error) {
      clear(manual)
      manual.append(h('p', { class: 'error-text' }, error instanceof Error ? error.message : 'Gagal memuat model.'))
      return
    }
    clear(manual)
    const familyRow = (family: ModelFamilyView) => {
      const active = family.options.some((option) => option.current)
      if (family.options.length === 1) {
        const option = family.options[0]
        return h('button', { class: `model-row${active ? ' active' : ''}`, type: 'button', onClick: () => choose(option.modelId, option.effort) }, h('span', { class: 'model-name' }, family.label), active ? h('span', { class: 'tag' }, 'aktif') : null)
      }
      return h('div', { class: `model-row group${active ? ' active' : ''}` },
        h('span', { class: 'model-name' }, family.label),
        h('span', { class: 'efforts' }, family.options.map((option) => h('button', {
          class: `effort${option.current ? ' current' : ''}`,
          type: 'button',
          onClick: () => choose(option.modelId, option.effort),
        }, option.label))),
      )
    }
    const featured = families.filter((family) => family.featured)
    const others = families.filter((family) => !family.featured)
    manual.append(h('div', { class: 'model-list' }, featured.map(familyRow)))
    if (others.length) {
      manual.append(h('details', { class: 'more-models' }, h('summary', {}, `Model lain (${others.length})`), h('div', { class: 'model-list' }, others.map(familyRow))))
    }
  }
  /* ---------------------------------------------------------- penyedia model */

  interface ProviderNotice { id: string; text: string }

  const providerDialog = h('dialog', { class: 'model-dialog' })
  root.append(providerDialog)

  /**
   * Satu baris penyedia: alamat, kunci, dan tombolnya. Kunci yang sudah tersimpan
   * tidak pernah dikirim ke halaman, jadi isiannya selalu kosong dan hanya
   * ditandai bahwa kuncinya sudah ada.
   */
  const providerRow = (provider: ProviderStatusView, refresh: (notice?: ProviderNotice) => Promise<void>, notice = ''): HTMLElement => {
    const url = h('input', { class: 'field', type: 'url', value: provider.baseUrl, placeholder: 'https://…', spellcheck: 'false' })
    const key = h('input', {
      class: 'field',
      type: 'password',
      autocomplete: 'off',
      placeholder: provider.hasKey ? 'tersimpan · isi untuk mengganti' : provider.keyRequired ? `kunci dari ${provider.keySource}` : 'tanpa kunci',
    })
    // Daftar digambar ulang setelah menyimpan, jadi hasilnya diteruskan ke baris baru.
    const status = h('span', { class: `provider-status${notice ? ' ok' : ''}` }, notice)
    // Kuota langganan 9Router hanya terbaca lewat login dashboard.
    const dashboard = provider.id === 'ninerouter'
      ? h('input', {
          class: 'field',
          type: 'password',
          autocomplete: 'off',
          placeholder: provider.hasDashboardPassword ? 'password dashboard tersimpan' : 'password dashboard (opsional, untuk sisa kuota)',
        })
      : null
    const save = h('button', { class: 'button primary small', type: 'button' }, 'Simpan')
    const remove = h('button', { class: 'button small', type: 'button', hidden: !provider.configured }, 'Hapus')

    const send = async (body: Record<string, unknown>, working: string) => {
      save.disabled = true
      remove.disabled = true
      status.textContent = working
      status.className = 'provider-status'
      try {
        const result = await api.post<{ models: number }>('/api/providers', { id: provider.id, ...body })
        key.value = ''
        await refresh({ id: provider.id, text: body.remove ? 'dihapus' : `terhubung · ${result.models} model` })
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'gagal'
        status.className = 'provider-status error'
      } finally {
        save.disabled = false
        remove.disabled = false
      }
    }

    save.addEventListener('click', () => void send({ baseUrl: url.value, apiKey: key.value, ...(dashboard?.value ? { dashboardPassword: dashboard.value } : {}) }, 'memeriksa koneksi…'))
    remove.addEventListener('click', () => void send({ remove: true }, 'menghapus…'))
    key.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') save.click()
    })

    return h('div', { class: `provider-row${provider.configured ? ' active' : ''}` },
      h('div', { class: 'provider-head' },
        h('span', { class: 'model-name' }, provider.label),
        provider.primary ? h('span', { class: 'tag' }, 'utama') : provider.configured ? h('span', { class: 'tag' }, 'terpasang') : null,
        h('span', { class: 'muted' }, provider.hint),
      ),
      h('div', { class: 'provider-fields' }, url, key, save, remove),
      dashboard ? h('div', { class: 'provider-fields' }, dashboard) : null,
      status,
    )
  }

  const openProviders = async () => {
    clear(providerDialog)
    providerDialog.append(h('div', { class: 'dialog-head' }, h('strong', {}, 'Penyedia model'), h('button', { class: 'icon-button', type: 'button', onClick: () => providerDialog.close() }, '✕')))
    const quota = h('div', { class: 'quota-panel' }, h('p', { class: 'muted' }, 'Memeriksa sisa limit…'))
    const list = h('div', { class: 'provider-list' }, h('p', { class: 'muted' }, 'Memuat…'))
    providerDialog.append(h('div', { class: 'dialog-body' },
      h('p', { class: 'muted' }, 'Kunci disimpan di ~/.boo/.env milikmu dan tidak pernah ditampilkan kembali. Model dari penyedia selain yang utama memakai awalan, misalnya anthropic:claude-sonnet-4-6.'),
      h('p', { class: 'muted' }, 'Kunci langganan Codex CLI dan Claude Code tidak dipakai; pakai kunci API resmi atau 9Router.'),
      quota,
      list,
    ))
    providerDialog.showModal()
    void loadQuota(quota)
    const refresh = async (notice?: ProviderNotice) => {
      const { providers } = await api.get<{ providers: ProviderStatusView[] }>('/api/providers')
      state.providers = providers
      clear(list)
      for (const provider of providers) list.append(providerRow(provider, refresh, notice?.id === provider.id ? notice.text : ''))
    }
    try {
      await refresh()
    } catch (error) {
      clear(list)
      list.append(h('p', { class: 'error-text' }, error instanceof Error ? error.message : 'Gagal memuat penyedia.'))
    }
  }
  /** Sisa limit per penyedia, beserta apa yang memang tidak dilaporkan. */
  const loadQuota = async (target: HTMLElement) => {
    let report: QuotaReportView
    try {
      report = await api.get<QuotaReportView>('/api/quota')
    } catch (error) {
      clear(target)
      target.append(h('p', { class: 'error-text' }, error instanceof Error ? error.message : 'Gagal membaca limit.'))
      return
    }
    clear(target)
    target.append(h('div', { class: 'quota-title' }, 'Sisa limit'))
    if (!report.entries.length) target.append(h('p', { class: 'muted' }, 'Belum ada angka limit yang dapat dibaca.'))
    for (const entry of report.entries) {
      const amount = entry.remaining === undefined
        ? entry.state === 'cooldown' ? 'sedang cooldown' : 'tidak dilaporkan'
        : entry.unit === 'usd'
          ? `$${entry.remaining.toFixed(2)}${entry.limit ? ` dari $${entry.limit.toFixed(2)}` : ''}`
          : `${Math.round(entry.remaining)}${entry.limit ? ` dari ${Math.round(entry.limit)}` : ''} ${entry.unit ?? ''}`.trim()
      target.append(h('div', { class: `quota-row ${entry.state}` },
        h('span', { class: 'quota-name' }, `${entry.providerLabel} · ${entry.label}`),
        h('span', { class: 'quota-amount' }, amount),
        h('span', { class: 'quota-source' }, entry.resetAt ? `pulih ${new Date(entry.resetAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}` : entry.source),
      ))
    }
    if (report.usage.length) {
      target.append(h('div', { class: 'quota-title' }, 'Pemakaian di mesin ini'))
      for (const usage of report.usage) {
        const size = usage.tokens < 1_000 ? `${usage.tokens} token` : `${(usage.tokens / 1_000).toFixed(1)}K token`
        target.append(h('div', { class: 'quota-row' },
          h('span', { class: 'quota-name' }, usage.model),
          h('span', { class: 'quota-amount' }, `${usage.requests} permintaan`),
          h('span', { class: 'quota-source' }, `~${size}`),
        ))
      }
    }
    for (const note of report.notes) target.append(h('p', { class: 'muted' }, note))
  }

  providersButton.addEventListener('click', () => void openProviders())
  providerDialog.addEventListener('click', (event) => {
    if (event.target === providerDialog) providerDialog.close()
  })

  modelButton.addEventListener('click', () => void openModels())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  /* ---------------------------------------------------------- keyboard */

  document.addEventListener('keydown', (event) => {
    if (dialog.open || providerDialog.open) return
    if (event.key === 'Escape' && busy) {
      event.preventDefault()
      void guard(() => api.post('/api/cancel'))
      return
    }
    // Angka memilih jawaban pertanyaan, kecuali saat sedang mengetik.
    const target = event.target as HTMLElement
    const typing = target.tagName === 'TEXTAREA' || target.tagName === 'INPUT'
    if (state.question && !typing && /^[1-9]$/.test(event.key) && !event.metaKey && !event.ctrlKey) {
      event.preventDefault()
      state.question.choose(Number(event.key) - 1)
    }
  })

  /* ---------------------------------------------------------- event server */

  const onEvent = (event: ServerEvent) => {
    switch (event.type) {
      case 'snapshot':
        rebuild(event.snapshot)
        break
      case 'item':
        putItem(event.item, event.toEnd)
        break
      case 'append': {
        const item = state.items.find((candidate) => candidate.id === event.id)
        if (item?.kind !== 'answer') break
        item.markdown += event.text
        dirtyAnswers.add(event.id)
        frame ||= requestAnimationFrame(flushAnswers)
        break
      }
      case 'status':
        setStatus(event.status)
        break
      case 'busy':
        setBusy(event.busy)
        break
      case 'queue':
        setQueue(event.queue)
        break
      case 'question':
        setQuestion(event.question)
        break
      case 'providers':
        state.providers = event.providers
        break
      case 'model':
        if (state.snapshot) state.snapshot.model = event.model
        setModel(event.model.label)
        break
      case 'session':
        if (state.snapshot) state.snapshot.sessionId = event.sessionId
        refreshLists()
        break
    }
  }

  api.listen(onEvent, (connectionState) => {
    if (connectionState === 'unauthorized') {
      lockedScreen('Token tidak berlaku lagi — server mungkin dijalankan ulang. Buka tautan terbaru dari terminal.')
      return
    }
    connection.hidden = connectionState === 'open'
  })
  textarea.focus()
}

function workspaceTitle(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}
