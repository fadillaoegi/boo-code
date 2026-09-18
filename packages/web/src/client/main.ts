/**
 * Halaman Boo Code web.
 *
 * Halaman tidak menyimpan keadaan agent sendiri: semuanya datang dari server lewat
 * event, dan setiap aksi dikirim balik ke server. Yang disimpan di sini hanya
 * keadaan tampilan — elemen per unsur, isian kotak ketik, dan tema.
 */

import type { ViewItem } from '@boo/core/presentation/view.ts'
import type { ModelFamilyView, QuestionOption, ServerEvent, SessionView, Snapshot, SpecView } from '../protocol.ts'
import { Api, ApiError, takeToken } from './api.ts'
import { append, clear, h, renderMarkdown } from './dom.ts'
import { renderItem, renderQuestion, renderStatus } from './items.ts'

const THEME_KEY = 'boo-code-theme'
const COMMANDS = [
  { name: '/spec', hint: 'rancang fitur: requirements, design, tasks' },
  { name: '/undo', hint: 'batalkan perubahan berkas dari permintaan terakhir' },
  { name: '/compact', hint: 'ringkas percakapan agar konteks lega' },
  { name: '/init', hint: 'tulis BOO.md berisi aturan proyek' },
  { name: '/help', hint: 'daftar perintah' },
]

interface State {
  snapshot: Snapshot | null
  items: ViewItem[]
  elements: Map<string, HTMLElement>
  question: ReturnType<typeof renderQuestion> | null
  sessions: SessionView[]
  specs: SpecView[]
}

const state: State = { snapshot: null, items: [], elements: new Map(), question: null, sessions: [], specs: [] }

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
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'icon-button menu', type: 'button', title: 'Menu', onClick: () => document.body.classList.toggle('nav-open') }, '☰'),
    modelButton,
    instructionsChip,
    h('span', { class: 'spacer' }),
    connection,
  )

  const log = h('div', { class: 'log-inner' })
  const scroller = h('section', { class: 'log' }, log)
  const empty = h('div', { class: 'empty-state' })

  const statusSlot = h('div', { class: 'status-slot' })
  const questionSlot = h('div', { class: 'question-slot' })
  const queueSlot = h('div', { class: 'queue-slot' })
  const commandMenu = h('ul', { class: 'command-menu', hidden: true })
  const textarea = h('textarea', { class: 'composer-input', rows: '1', placeholder: 'Minta Boo mengerjakan sesuatu…  (/ untuk perintah)' })
  const sendButton = h('button', { class: 'button primary', type: 'submit' }, 'Kirim')
  const stopButton = h('button', { class: 'button danger', type: 'button', hidden: true, onClick: () => void guard(() => api.post('/api/cancel')) }, 'Stop')
  const composer = h('form', { class: 'composer' }, commandMenu, textarea, h('div', { class: 'composer-actions' }, stopButton, sendButton))
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
    state.snapshot = snapshot
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
    sendButton.textContent = value ? 'Antre' : 'Kirim'
    document.body.classList.toggle('busy', value)
    if (!value) refreshLists()
  }

  const setModel = (label: string) => {
    clear(modelButton)
    append(modelButton, [h('span', { class: 'model-dot' }), label, h('span', { class: 'caret' }, '▾')])
  }

  /* ---------------------------------------------------------- kotak ketik */

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
    const matches = value.startsWith('/') && !value.includes(' ') ? COMMANDS.filter((command) => command.name.startsWith(value)) : []
    commandMenu.hidden = !matches.length
    clear(commandMenu)
    for (const command of matches) {
      commandMenu.append(h('li', {}, h('button', {
        type: 'button',
        onClick: () => insertCommand(command.name === '/spec' ? '/spec ' : command.name),
      }, h('strong', {}, command.name), h('span', {}, command.hint))))
    }
  }

  const submit = () => {
    const text = textarea.value.trim()
    if (!text) return
    textarea.value = ''
    resize()
    updateCommandMenu()
    stick = true
    void guard(() => api.post('/api/submit', { text }))
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
    const body = h('div', { class: 'dialog-body' }, h('p', { class: 'muted' }, 'Memuat daftar model dari 9Router…'))
    dialog.append(body)
    dialog.showModal()
    let families: ModelFamilyView[]
    try {
      families = (await api.get<{ families: ModelFamilyView[] }>('/api/models')).families
    } catch (error) {
      clear(body)
      body.append(h('p', { class: 'error-text' }, error instanceof Error ? error.message : 'Gagal memuat model.'))
      return
    }
    clear(body)
    const choose = (modelId: string, effort: string | null) => {
      dialog.close()
      void guard(() => api.post('/api/model', { modelId, effort }))
    }
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
    body.append(h('div', { class: 'model-list' }, featured.map(familyRow)))
    if (others.length) {
      body.append(h('details', { class: 'more-models' }, h('summary', {}, `Model lain (${others.length})`), h('div', { class: 'model-list' }, others.map(familyRow))))
    }
  }
  modelButton.addEventListener('click', () => void openModels())
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  /* ---------------------------------------------------------- keyboard */

  document.addEventListener('keydown', (event) => {
    if (dialog.open) return
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
      case 'model':
        setModel(event.model.label)
        break
      case 'session':
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
