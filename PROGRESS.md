# Catatan serah-terima Boo Code

Berkas ini diperbarui setiap kali satu pekerjaan selesai, dan **wajib diperbarui
sebelum berhenti karena batas pemakaian**, supaya agent berikutnya — Codex CLI
maupun Claude Code — bisa menyambung tanpa menebak-nebak.

Cara mengisinya: perbarui bagian "Status terakhir", pindahkan yang sudah rampung
ke "Sudah selesai", dan tulis langkah berikutnya sekonkret mungkin (nama berkas,
fungsi, perintah verifikasi).

---

## Status terakhir

- **Tanggal:** 2026-09-23
- **Dikerjakan oleh:** Codex, setelah menelusuri hasil lanjutan Claude Code.
- **Verifikasi:** `pnpm eval:validate` (12 kasus, 20 kategori), `pnpm typecheck`,
  `pnpm -s lint`, `git diff --check`, workflow YAML, qualification live 9Router,
  serta `pnpm test`/suite serial penuh (580 lolos, 2 test
  live Windows dilewati di macOS) — semuanya bersih. Artefak rilis dibangun ulang
  menjadi 379,1 KB; SHA-256
  `2cd5e63359db5f57f2127c27f70c651b22af6924ccc7edfd9791d962d9c7bff4`.
- **Git:** implementasi #74–#85, #87, #88, dan #90 belum di-commit agar dapat
  ditinjau pengguna.
- **Dokumentasi GitHub:** bagian awal `README.md` kini menjadi landing page yang
  memuat badge CI/platform, ringkasan fitur, persyaratan, tiga jalur instalasi,
  wizard dan konfigurasi manual seluruh provider, prioritas file konfigurasi,
  opsi sandbox/Auto, quick start, web UI, serta uninstall. URL clone memakai remote
  resmi `https://github.com/fadillaoegi/boo-code.git`; README juga menegaskan paket
  belum dipublikasikan ke npm registry.

## Sudah selesai

- **#69 Safe Parallel Discovery Scheduler** — tool penelusuran yang sudah diaudit
  berjalan paralel maksimal 4; jaringan, interaksi, dan mutasi tetap berurutan.
- **#70 Bounded Tool Result Store** — keluaran tool besar dipadatkan head/tail,
  isi penuh ditahan di memori task, sisanya diambil lewat `read_tool_output`.
- **#71 AST-aware Repository Intelligence** — `repo_map` memakai compiler
  TypeScript untuk simbol, pemanggilan, import, dan pewarisan; tool baru
  `code_graph`. Compiler dimuat malas (`loadTypeScriptCompiler` di
  `packages/core/src/tools/repoMap.ts`), tidak ikut dibundel, dan dipasang sebagai
  dependency paket rilis. Bundel kembali dari 10,8 MB ke sekitar 1,0 MB, dan
  bahasa tanpa parser tetap dilayani mode `fallback`. Didokumentasikan di README
  bagian "Graf simbol dari AST".
- **#72 Banyak penyedia model** — `packages/core/src/provider/profiles.ts`
  mendaftarkan 9Router, OpenAI, Anthropic, OpenRouter, Ollama, dan alamat
  OpenAI-compatible lain. `NineRouterProvider` menjadi gerbang: id model berawalan
  penyedia (`anthropic:claude-sonnet-4-6`) menentukan tujuan, model tanpa awalan
  tetap ke penyedia utama sehingga sesi lama tidak berubah. Adapter Anthropic di
  `provider/anthropic.ts`, error bersama di `provider/errors.ts`. `boo-code setup`
  memasang beberapa penyedia sekaligus, `doctor` melaporkannya, dan `/model`
  menampilkan semuanya dalam satu daftar. Di web, tombol ⚙ membuka pengaturan
  penyedia (`GET`/`POST /api/providers`); kunci hanya masuk, tidak pernah dikirim
  balik ke halaman. `boo-code web --no-open` menahan browser agar tidak dibuka.

- **#73 Sisa limit model** — `/limit` di CLI dan panel di tombol ⚙ web. Sumbernya
  digabung di `packages/core/src/provider/quotaReport.ts`: kuota dashboard 9Router
  (`nineRouterDashboard.ts`, login `POST /api/auth/login` lalu cookie sesi), saldo
  kunci OpenRouter, header rate-limit OpenAI/Anthropic, serta cooldown dan
  pemakaian yang diamati sendiri (`quota.ts`). Password dashboard diverifikasi
  sekali lalu disimpan sebagai `NINEROUTER_DASHBOARD_PASSWORD`; tidak pernah dicoba
  ulang otomatis karena dashboard mengunci akun setelah beberapa kegagalan. Dari
  jawaban dashboard hanya nama dan angka yang dibaca — token akun diabaikan.

- **#74 Expanded Agent Evals** — suite bawaan tumbuh dari 7 menjadi 11 kasus dan
  sekarang mencakup path traversal, deduplikasi cache konkuren, refactor lintas
  modul, serta pencarian akar bug di repository besar. Evaluator membuat snapshot
  SHA-256 sebelum agent bekerja lalu memeriksa `requiredChangedFiles`,
  `allowedChangedFiles`, `forbiddenChangedFiles`, dan `maxChangedFiles`, sehingga
  agent tidak bisa lulus dengan mengubah test atau file di luar scope. Schema juga
  mendukung `answerNotContains` dan gate coverage untuk jumlah kasus, tag, serta
  difficulty. Path kontrak harus relatif dan aman. File screenshot root bernama
  `y` yang masuk tanpa sengaja telah dihapus. README dan smoke suite diperbarui,
  serta artefak release yang sebelumnya tertinggal telah dibangun ulang.

- **#75 Adaptive Tool Timeout & Recovery** — `bash` dan `diagnostics` kini
  mengklasifikasikan command sebagai quick, test, build, install, network,
  long-running, atau general. Tanpa argumen `timeout`, keluaran baru mereset idle
  deadline tetapi hard cap tetap menghentikan proses; `timeout` eksplisit tetap
  menjadi batas total persis. Durasi agregat dan kejadian timeout dipelajari dari
  `~/.boo/tool-timeouts.json`, menua setelah 90 hari, dan meluruh saat command
  kembali cepat. Profil privat tidak memuat command, argumen, output, prompt, atau
  source. Timeout menghasilkan `tool-recovery` terstruktur di CLI JSON, fase
  Recovering di CLI/web, metrik trace lokal, output parsial, serta instruksi untuk
  memeriksa state sebelum mengulang side effect. Server/watcher tetap diarahkan
  ke proses latar belakang. Shell juga sekarang melaporkan durasi dan membedakan
  idle timeout dari hard cap.

- **#76 Verification Repair Loop** — setelah mutasi dan pemeriksaan yang dikenali
  gagal, Boo sekarang memasuki loop diagnosis → perbaikan source minimal →
  verifikasi ulang, alih-alih langsung menerima kesimpulan model. Kesimpulan
  prematur diberi feedback internal dan budget bersama dibatasi tiga putaran;
  hasil akhirnya dibedakan menjadi `repaired` atau `exhausted`. Test yang sudah
  gagal sebelum Boo mengubah workspace tidak mengaktifkan loop. State repair tidak
  menyimpan output tool, hanya command yang disanitasi/dibatasi dan nomor revisi.
  CLI, web, `exec --json`, `/status`, `/stats`, trace lokal, dan eval menerima event
  serta metrik repair yang sama. Dokumentasi dan test integrasi mencakup jalur
  pulih maupun batas habis.

- **#77 Change Impact Graph** — tool aman `change_impact` menelusuri file berubah
  ke importer, pemanggil simbol, subclass/implementasi, dan test melalui indeks
  repository incremental. Setiap node membawa depth, relasi, confidence, status
  test, simbol awal, dan blast radius small/medium/large. Relasi call/inheritance
  hanya dipakai saat definisi unik atau benar-benar diimpor untuk mengurangi false
  positive. Graph dibatasi 100 input, 80 file terdampak, 180 edge, dan depth 1–6.
  `test_impact` memakai graph yang sama; completion verification dan automatic
  critic mendapat ringkasan dampak. CLI/web/JSON, `/status`, `/stats`, trace, dan
  eval mencatat angka agregat tanpa path/source. Benchmark baru read-only wajib
  menemukan konsumen langsung dan test transitif, menaikkan suite ke 12 kasus dan
  20 kategori.

- **#78 Persistent LSP Session** — language server kini diinisialisasi sekali lalu
  dipakai ulang berdasarkan workspace, command, dan kebijakan sandbox. Isi file
  aktual disinkronkan dengan `didOpen`/`didChange`; 40 dokumen per session dan
  empat server global dibatasi LRU, sedangkan session idle lima menit ditutup lewat
  `shutdown`/`exit`. Crash atau request gagal membuang session dan mencoba restart
  sekali dengan dokumen dibuka ulang. Child process/pipe di-unref agar tidak
  menahan exit Boo. Lifecycle `started`/`reused`/`restarted` tersedia di CLI, web,
  JSON, `/status`, `/stats`, trace, dan eval tanpa menyimpan path atau source.

- **#79 Native Windows Sandbox** — command Windows x64/ARM64 sekarang dijalankan
  lewat Microsoft MXC ProcessContainer, yang memilih AppContainer/BaseContainer
  native dan mengelola seluruh pohon proses dengan Job Object. Boo menemukan
  `wxc-exec.exe` dari dependency `@microsoft/mxc-sdk@0.8.0` yang dikunci lockfile,
  memvalidasi isolation tier melalui `--probe` yang di-cache, lalu mengirim policy
  schema 0.8 dalam config base64. Workspace mengikuti `workspace-write` atau
  `read-only`; sibling tidak diberi akses, metadata `.git/.boo/.codex/.agents`
  ditolak, direktori tool hanya read-only, dan temp diarahkan ke folder khusus.
  Network, UI, clipboard, serta input injection default-deny; network hanya dibuka
  melalui capability saat dikonfigurasi. Environment child memakai sanitizer yang
  sama sehingga API key/token/password tidak masuk config. Binary hilang, probe
  gagal, atau arsitektur asing menghasilkan status non-enforced dan approval,
  bukan fallback yang diam-diam dipercaya. Test kontrak mencakup resolution,
  quoting `cmd.exe`, policy, credential, network, dan probe; dua test kernel live
  untuk write/metadata/sibling/read-only otomatis aktif pada host Windows.

- **#80 Provider Capability Learning** — mode Auto kini mempelajari kemampuan
  model/provider dari sinyal runtime nyata: availability, penerimaan tool schema,
  vision, reasoning effort, context sukses terbesar, context limit, dan kegagalan
  function-call protocol. Error eksplisit memicu fallback aman sebelum ada output
  parsial; task berikutnya menghindari kandidat yang terbukti tidak cocok, tetapi
  model unknown tetap dieksplorasi dan filter tidak boleh menghabiskan semua
  pilihan. Availability memakai cooldown enam jam dan seluruh bukti menua setelah
  90 hari. Profil privat `~/.boo/provider-capabilities.json` hanya menyimpan id,
  counter, token, dan timestamp—tanpa prompt, source, path, argumen, jawaban, atau
  output. `/capabilities` tersedia di CLI/web; alasan routing dan JSONL melaporkan
  sampel serta jumlah model yang dihindari. Parser fail-safe, file permission,
  deduplikasi observasi per task, klasifikasi error, routing, persistence, dan
  fallback runtime tercakup test.

- **#81 Failure Postmortem** — task yang berakhir error, stopped, atau incomplete
  kini mendapat diagnosis deterministik dari event runtime tanpa panggilan model
  tambahan. Penyebab dibedakan menjadi auth/rate limit/availability/context/request/
  transport provider, timeout/kegagalan/penolakan/argumen tool, loop, function-call
  protocol, verifikasi, turn limit, atau unknown. Laporan menyertakan model,
  counter turn/retry/tool, nama tool, repair dan fallback terkait, serta tindakan
  lanjutan spesifik. Kegagalan yang pulih dan pembatalan pengguna tidak membuat
  laporan. Metadata privat disimpan maksimal 100 per workspace di
  `~/.boo/postmortems/<hash-workspace>/` (folder `700`, file `600`) tanpa prompt,
  error mentah, reasoning, source, path, args, preview, jawaban, atau output.
  `/postmortem` tersedia di CLI/web, `run.postmortem` di JSONL, dan `/stats`
  mengagregasi kategori. Parser ketat menolak traversal, file rusak/symlink
  dilewati, kegagalan persistence tidak memblokir agent, dan event terminal lama
  tetap menjadi event terakhir untuk kompatibilitas consumer.

- **#82 Context Dependency Graph** — saat history harus dipangkas, Boo kini
  membangun graph ephemeral antarblok untuk menghubungkan keputusan dengan task
  user, rantai pemanggilan/hasil tool, perubahan terakhir yang diverifikasi, dan
  anchor path/simbol/error yang muncul kembali. Seleksi relevan mencoba membawa
  closure bukti tersebut hanya jika masih muat; fallback tetap mempertahankan
  kandidat terpenting dan struktur protokol. Graph dibatasi 512 edge, 8 dependency
  per blok, depth 3, serta closure 12 blok. Pesan terbaru, seluruh system prompt,
  urutan kronologis, dan pasangan function-call/result tidak berubah. `/context`,
  notice CLI/web, `/status`, `/stats`, JSONL, trace, dan eval membawa metrik jumlah
  pesan/edge. Graph, anchor, prompt, source, path, dan bukti tidak dipersistenkan;
  hanya angka agregat trace lokal, sehingga tidak membutuhkan DB.

- **#83 Cross-platform Computer Use** — core agent kini memiliki protokol bridge
  accessibility versi 1 yang sama untuk macOS (`darwin`), Windows (`win32`), dan
  Linux (`linux`). Bridge global dipilih dari `~/.boo/computer.json`, executable
  wajib absolut, dijalankan tanpa shell dan tanpa environment credential, dibatasi
  15 detik/1 MiB/500 elemen, serta hanya menerima `status`, `snapshot`, `click`,
  `type`, dan `press`. Model hanya mendapat ref opaque, bukan koordinat/selector
  bebas. Snapshot dan seluruh aksi UI selalu meminta approval baru; teks yang
  tampak seperti secret ditolak. Implementasi native dapat memakai Accessibility,
  UI Automation, atau AT-SPI tanpa mengubah core Boo.

- **#84 Background Agent & Scheduler** — `boo-code schedule add/list/remove/
  enable/disable` dan `boo-code daemon` menjalankan task interval atau harian dari
  JSON privat lokal tanpa DB. Scheduler dibatasi 100 job, melakukan durable claim
  sebelum run, lock PID tunggal dengan pemulihan lock basi, mencegah tick tumpang
  tindih, dan menyimpan maksimal 200 hasil JSONL. Mode default tidak menyetujui
  tindakan; `--full-auto` hanya membuka file workspace dan command lokal tersandbox,
  bukan computer use/MCP/pesan/aksi eksternal. Tool agent `schedule_*` memakai
  aturan approval yang sama.

- **#85 Event Triggers** — `boo-code trigger add/list/remove/enable/disable/emit`
  dan daemon yang sama mendukung perubahan file, HEAD Git, event CI/custom, serta
  webhook Bearer-token lokal. Polling file portabel memakai fingerprint metadata,
  baseline awal tidak menembak, debounce mencegah burst, dan pola traversal ditolak.
  Antrean JSONL diklaim dengan rename atomik. Webhook hanya bind loopback, body
  maksimal 32 KiB dan tidak pernah menjadi prompt; token 256-bit ditampilkan sekali
  sementara file privat hanya menyimpan hash. Log run tidak memuat prompt/payload/
  token/output. Tool agent `trigger_*` tersedia, tetapi pembuatan webhook CLI-only
  agar secret tidak masuk konteks model.

- **#87 CI lintas sistem operasi** — workflow GitHub Actions menjalankan install,
  typecheck, lint, seluruh test, dan validasi eval pada Ubuntu, macOS, serta Windows
  dengan Node 22.12 dan 24. Job terpisah membangun serta mengunggah tarball rilis.
  Engine package diselaraskan ke Node >=22.12. Workflow sudah tervalidasi secara
  statis/lokal; eksekusi runner hosted pertama baru terjadi setelah branch didorong.

- **#88 Pengujian provider sungguhan** — `scripts/provider-live.ts` dan
  `pnpm test:providers:live` menguji daftar model, streaming, marker respons, dan
  opsional function calling tanpa mencetak credential. Workflow manual
  `provider-live.yml` memakai environment/secrets terlindungi agar test berbiaya
  tidak berjalan pada PR biasa. Qualification nyata 9Router berhasil pada
  2026-09-23: 23 model terdaftar dan `ag/gemini-3.7-flash-high` menghasilkan tool
  call valid dalam sekitar 2,9 detik. Provider lain menunggu kunci sungguhan.

- **#90 Remote Device/Node** — `boo-code node serve/pair/list/remove` memasangkan
  device memakai token acak 256-bit yang disimpan `0600` dan tidak pernah diberikan
  ke model. HTTP hanya boleh loopback; jaringan wajib HTTPS dengan cert/key. Client
  memakai timeout/batas respons dan server membandingkan Bearer token constant-time.
  Protokol remote hanya meneruskan allowlist computer use, tidak menyediakan remote
  shell/filesystem; setiap status, snapshot, klik, input, atau tombol meminta
  approval baru pada controller.

## Sedang dikerjakan

Implementasi core #83–#85/#87/#88/#90 selesai. Validasi eksternal yang masih perlu
dilakukan ketika resource-nya tersedia:

- Mencoba jalur Anthropic dengan kunci API sungguhan. Di mesin ini belum ada
  `ANTHROPIC_API_KEY`, jadi adapter baru diuji lewat server tiruan di
  `packages/core/tests/providers.test.ts`.
- Menguji kuota dashboard 9Router dengan password sungguhan. Password belum
  pernah dimasukkan (agen tidak boleh menebaknya: dashboard mengunci setelah
  beberapa percobaan), jadi parser `extractQuotaEntries` baru diuji dengan bentuk
  tiruan. Begitu pengguna mengisinya lewat `boo-code setup`, jalankan `/limit`
  untuk memastikan nama akun dan angkanya terbaca benar.
- Menjalankan workflow CI hosted pertama setelah perubahan di-push, terutama dua
  test kernel MXC pada runner Windows.
- Menguji bridge native Accessibility/UI Automation/AT-SPI sungguhan yang dipilih
  pengguna serta koneksi node HTTPS pada dua device fisik. Unit/integration test
  saat ini memakai bridge dan server loopback tiruan.

## Berikutnya (peta jalan Codex)

Roadmap rekomendasi #69–#85, #87, #88, dan #90 sudah selesai pada core. Fitur baru
berikutnya sebaiknya dipilih dari hasil CI, bridge native, dan penggunaan nyata.

## Perintah verifikasi

```bash
pnpm install
pnpm typecheck
pnpm test        # seluruh package
pnpm -s lint
pnpm release     # paket rilis; perhatikan ukuran bundel tetap ~1 MB
```
