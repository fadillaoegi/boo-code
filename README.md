# Boo Code

Coding agent buatan FLdev. Satu otak (`@boo/core`), dua antarmuka: CLI `boo` dan web lokal.
Nama produknya Boo Code; CLI dan web hanyalah dua cara menjalankannya. Model diakses lewat [9Router](http://localhost:20128) sebagai satu pintu.

## Antarmuka web lokal

Jalankan dari direktori proyek yang ingin dikerjakan:

```bash
boo-code web
```

Boo membuka browser ke server pada `127.0.0.1` dengan token acak per proses. Bila
port tertentu diperlukan, gunakan `boo-code web --port 3000`. Halaman menyediakan
sesi, model, spec, antrean, streaming jawaban, dan persetujuan perubahan/perintah;
menutup tab tidak menghentikan pekerjaan. Tekan Ctrl-C di terminal untuk menutup
server.

## Memasang di mesin lain

Buat paket sekali dari repo ini:

```bash
pnpm install
pnpm release
```

Hasilnya `release/boo-code-0.1.0.tgz`: CLI dan `@boo/core` dibundel menjadi satu
berkas JavaScript (sekitar 200 KB) tanpa dependency. Salin tarball itu ke mesin
tujuan — yang cukup punya Node.js 22.12 atau lebih baru — lalu:

```bash
npm install -g ./boo-code-0.1.0.tgz
boo-code setup
```

`setup` menanyakan alamat 9Router, kunci API, dan model bawaan:

```
  Setup Boo Code
  Setelan disimpan di ~/.boo/.env dan hanya dapat dibaca akunmu.

  Alamat 9Router [http://localhost:20128]:
  Kunci API (dari Dashboard 9Router): ***********************************
  ✓ Terhubung ke 9Router · 23 model tersedia
  Model bawaan [auto]:

  ✓ Tersimpan. Model dan tingkat penalaran dapat diganti kapan saja dengan /model.
```

- Kunci diketik tanpa tampil di layar, dan koneksinya diperiksa sebelum disimpan.
- Isi `~/.boo/.env` yang lain (misalnya `BOO_EFFORT`) dipertahankan; berkasnya
  dikunci ke izin `600`.
- Menjalankan `boo-code` pertama kali tanpa setelan langsung membuka setup.
- Jalankan `boo-code setup` lagi kapan saja untuk mengganti kunci atau alamat;
  menekan enter memakai nilai yang tersimpan.

Paket ini sudah diuji dipasang ke prefix bersih, dijalankan dengan HOME kosong, dan
dijalankan di Node 22 maupun 24. `release/boo-code/` berisi isi paketnya bila ingin
diperiksa sebelum dibagikan. Paket diberi lisensi `UNLICENSED` dan **tidak**
dipublikasikan ke registry npm; itu keputusan terpisah.

Melepasnya: `npm uninstall -g boo-code`. Sesi dan setelan di `~/.boo` tidak ikut
terhapus.

## Memasang secara global untuk pengembangan

Di mesin tempat repo ini berada, pasang langsung dari sumber agar setiap perubahan
kode langsung berlaku tanpa build:

```bash
pnpm install
cd packages/cli && npm link      # binary `boo` dan `boo-code` tersedia global
boo-code setup
```

Setelah itu `boo-code` dapat dipanggil dari direktori mana pun. Melepasnya:
`npm unlink -g boo-code`.

> `npm link` dipakai karena direktori bin globalnya biasanya sudah ada di PATH.
> `pnpm link --global` juga bisa, tetapi memerlukan `pnpm setup` lebih dulu yang
> mengubah berkas konfigurasi shell. Cara ini membutuhkan Node.js 24, karena
> sumber TypeScript dijalankan langsung.

## Menjalankan dari dalam repo

```bash
pnpm boo                     # tanpa memasang global
```

`boo` memperlakukan direktori kerja saat ini sebagai workspace dan tidak dapat
menyentuh apa pun di luarnya.

### Mode headless dan CI

Jalankan satu tugas tanpa UI interaktif memakai `exec`. Output teks hanya berisi
jawaban akhir, sehingga dapat langsung dipakai oleh script:

```bash
boo-code exec "jelaskan perubahan pada branch ini"
cat task.md | boo-code exec --full-auto
boo-code exec --json "periksa test yang gagal" > run.jsonl
```

Secara bawaan semua tool yang memerlukan approval ditolak; operasi baca tetap
berjalan. `--full-auto` (alias `--approval workspace`) hanya mengizinkan file tool
di workspace serta command lokal bila OS sandbox benar-benar enforced. Membuka
aplikasi, mengirim pesan, mengubah memori global, dan MCP tetap ditolak. Gunakan
`--ephemeral` bila isi percakapan tidak perlu disimpan sebagai sesi.

`--json` menghasilkan JSONL: lifecycle sesi, pemilihan model Auto, turn, tool,
hook, potongan jawaban, lalu record `result` yang berisi status, jawaban, model,
jumlah turn/tool, durasi, dan session ID. Exit code `0` berarti selesai, `1` error,
`2` argumen tidak sah atau pekerjaan belum terverifikasi/terhenti di batas turn,
dan `130` dibatalkan dengan Ctrl-C. Aturan proyek, skills, custom command, hooks,
Auto model, sandbox, trace, dan checkpoint tetap memakai core agent yang sama.

### Input gambar dan screenshot

Boo menerima PNG, JPEG, WebP, dan GIF untuk menganalisis screenshot error, desain
UI, diagram, atau output visual. Pada CLI, lampirkan gambar lalu kirim prompt:

```text
› /attach "/Users/me/Desktop/error layar.png"
› jelaskan penyebab error ini lalu cari implementasinya
```

Gunakan `/attachments` untuk melihat gambar yang menunggu dan `/attachments clear`
untuk melepasnya. Mode headless menerima `--image <path>` berulang, sedangkan web
menyediakan tombol **＋ Gambar**. Satu pesan dibatasi lima gambar, 10 MiB per gambar,
dan 25 MiB total.

Gambar disalin berdasarkan hash ke `~/.boo/attachments/<session>/` dengan izin
privat. Riwayat sesi hanya menyimpan referensi dan nama tampilan sehingga `/resume`
tetap dapat memakai gambar tanpa menyimpan base64 besar atau path sumber. Tepat
sebelum request, Boo memverifikasi hash lalu mengirim pixel sebagai `image_url` data
URI; path lokal tidak dikirim. Hapus folder attachment hanya bila gambar tidak lagi
dibutuhkan oleh sesi lama.

Mode Auto memberi tahu router bahwa task membawa gambar dan mencoba model cadangan
bila provider melaporkan model tidak mendukung vision. Pada model manual, error
tersebut meminta pengguna memilih model vision-capable. Isi gambar tetap dikirim ke
provider model seperti isi prompt, jadi jangan lampirkan screenshot yang memuat
credential atau data yang tidak boleh keluar dari perangkat. Fitur ini tidak memakai
database.

### Referensi file dan folder dengan `@path`

Prompt dapat menyertakan konteks workspace secara langsung tanpa menunggu model
memanggil `read_file`. Syntax yang sama bekerja di CLI interaktif, web, custom
command, mode `/plan`, dan `boo-code exec`:

```text
› jelaskan alur autentikasi di @src/auth/service.ts
› perbaiki fungsi ini berdasarkan @src/parser.ts:120-180 dan @tests/parser.test.ts
› petakan komponen dalam @"folder dengan spasi"
```

`@file:awal-akhir` hanya memasukkan rentang baris tersebut. Referensi folder
menjadi tree ringkas, bukan seluruh isi setiap file. Maksimal lima referensi per
prompt, 64 KiB pertama per file, 120.000 karakter total, 200 entri per folder,
dan kedalaman folder empat tingkat. Dependency/build directory seperti
`node_modules`, `.git`, `dist`, dan `coverage` tidak ditelusuri.

Path wajib berada di workspace. Symlink langsung, file biner, dan file yang tampak
memuat credential seperti `.env`, private key, atau credential store ditolak.
Fenced code di dalam prompt tidak dipindai sehingga contoh `@syntax` tidak berubah
menjadi attachment. Gunakan tanda kutip untuk path yang mengandung spasi.

Isi referensi dibekukan ke pesan sesi pada saat prompt dikirim. Dengan begitu
`/resume` melihat konteks yang sama walaupun file kemudian berubah; transcript,
judul sesi, dan riwayat tombol panah tetap hanya menampilkan prompt asli. Isi file
tersebut dikirim ke provider model dan disimpan dalam berkas sesi privat seperti
percakapan lain, jadi jangan mereferensikan source yang tidak boleh dikirim. Fitur
ini memakai filesystem dan JSONL sesi yang sudah ada, tanpa database.

### Riset web dengan sumber

Boo mempunyai tool `web_search` untuk mencari informasi terbaru dan `web_fetch`
untuk membaca sumber HTTPS yang relevan. Agent memakainya otomatis bila pertanyaan
memerlukan dokumentasi eksternal atau fakta yang dapat berubah, baik dari CLI, web,
maupun mode `exec`:

```text
› cari perubahan terbaru Node.js lalu jelaskan dampaknya pada package ini
› baca https://example.com/docs/api dan cocokkan dengan implementasi kita
```

Hasil pencarian menyertakan judul, cuplikan, dan URL; isi halaman mempertahankan
URL link agar jawaban dapat merujuk sumber. Semua hasil web diberi penanda
**konten eksternal tidak tepercaya**. System prompt melarang agent mengikuti
instruksi yang tertanam di halaman dan melarang query berisi credential, rahasia,
atau source code privat.

Request hanya menerima HTTPS publik pada port 443. Boo memeriksa seluruh jawaban
DNS, menolak loopback/LAN/link-local/metadata cloud/rentang khusus, lalu mem-pin IP
yang sudah diperiksa saat koneksi dibuat untuk mencegah DNS rebinding. Setiap
redirect diperiksa ulang, maksimal lima kali; respons dibatasi 2 MiB, teks yang
dikirim ke model 40.000 karakter, dan timeout 15 detik. Binary tidak dibaca.

`web_search` memakai endpoint HTML DuckDuckGo dan otomatis beralih ke Bing bila
endpoint utama tidak tersedia, sehingga query dikirim ke salah satu layanan
tersebut; `web_fetch` menghubungi situs sumber. Kedua tool bersifat baca-saja dan
tidak membuka network untuk command shell atau MCP yang tetap mengikuti sandbox.
Tidak ada halaman, query, cookie, atau indeks web yang disimpan dalam database.

### Doctor instalasi

Jalankan pemeriksaan mandiri setelah memasang, mengganti konfigurasi, atau saat Boo
tidak dapat memakai sebuah integrasi:

```bash
boo-code doctor
```

Di dalam sesi terminal yang sudah berjalan, perintah yang sama tersedia sebagai `/doctor`.
Doctor memeriksa versi Node.js, akses workspace, alamat dan keberadaan kunci
9Router, koneksi serta daftar model provider, model bawaan, izin berkas konfigurasi,
Git repository, ripgrep, enforcement sandbox, dan koneksi browser CDP opsional.

Nilai kunci API, source code, prompt, cookie, dan isi halaman tidak ditampilkan.
Integrasi opsional yang tidak aktif menjadi peringatan; runtime, workspace, atau
provider wajib yang rusak menjadi kegagalan. Mode satu-kali mengembalikan exit code
`0` bila tidak ada kegagalan dan `1` bila ada, sehingga dapat dipakai dalam script
diagnostik tanpa database atau telemetry tambahan.

### Konfigurasi

Dibaca berlapis; yang belakangan menimpa yang sebelumnya:

| Sumber | Untuk |
|---|---|
| `~/.boo/.env` | setelan tetap milik pengguna |
| `<direktori kerja>/.env` | setelan proyek |
| `<direktori kerja>/.env.local` | setelan proyek yang tidak di-commit |
| environment variable | selalu menang |

Hanya kunci milik Boo yang diambil (`NINEROUTER_URL`, `NINEROUTER_KEY`,
`BOO_MODEL`, `BOO_EFFORT`, `BOO_MAX_CONTEXT_TOKENS`, `BOO_MAX_TURNS`,
`BOO_SANDBOX`, `BOO_NETWORK_ACCESS`, `BOO_TRACE`, `BOO_AUTO_REVIEW`). Berkas `.env` proyek lazim memuat rahasia
aplikasi lain, dan tidak ada alasan memuatnya ke dalam proses ini.

### Sandbox command

Command dari tool `bash`, proses latar belakang, dan `/run` memakai mode
`workspace-write` secara bawaan. Pada macOS Boo memakai Seatbelt
(`sandbox-exec`); pada Linux memakai Bubblewrap (`bwrap`) bila tersedia. Sandbox
mengizinkan write di workspace dan direktori temporer, membuat `.git`, `.boo`,
`.codex`, serta `.agents` read-only, dan memblokir network. Variabel environment
yang tampak seperti API key, token, secret, password, atau credential dibuang
sebelum proses dimulai.

```env
BOO_SANDBOX=workspace-write
BOO_NETWORK_ACCESS=false
```

Mode yang tersedia:

| Mode | Perilaku |
|---|---|
| `workspace-write` | command dan file tools boleh mengubah workspace; metadata agent dilindungi |
| `read-only` | command serta `write_file`/`edit_file` tidak boleh mengubah workspace |
| `danger-full-access` | command tidak memakai OS sandbox; tetap meminta approval |

Gunakan `--sandbox read-only` untuk satu sesi. Network hanya dibuka bila
`BOO_NETWORK_ACCESS=true`; ini tetap tidak memasukkan credential yang disaring ke
environment command. Bila `bwrap` tidak terpasang di Linux, atau pada Windows yang
belum memiliki backend filesystem sandbox Boo, command tetap meminta approval dan
hasil tool menampilkan bahwa kebijakan tidak enforced—Boo tidak mengaku sandbox
aktif. Dukungan backend Windows yang benar adalah tahap lanjutan, bukan diganti
dengan pembatasan PowerShell yang mudah dilewati.

### Permission rules persisten

Gunakan `/permissions` untuk melihat aturan izin yang aktif. Aturan pribadi berada
di `~/.boo/permissions.json` dan dapat berisi `allow`, `ask`, atau `deny`. Repository
dapat menambahkan `.boo/permissions.json`, tetapi demi keamanan hanya boleh
memperketat dengan `ask` atau `deny`; repository yang baru di-clone tidak dapat
memberi auto-allow kepada dirinya sendiri.

```json
{
  "version": 1,
  "rules": [
    { "id": "tests", "effect": "allow", "tool": "bash", "command": "pnpm test" },
    { "id": "source", "effect": "allow", "tool": "write_file", "path": "src/**" },
    { "id": "no-publish", "effect": "deny", "tool": "bash", "command": "*publish*" },
    { "id": "confirm-docs", "effect": "ask", "tool": "browser_*", "domain": "*.example.com" }
  ]
}
```

`tool` wajib diisi; kondisi opsional `command`, `path`, `app`, dan `domain`
digabung dengan logika AND. Pola mendukung `*`, `**`, dan `?`. Bila beberapa aturan
cocok, prioritasnya selalu `deny`, kemudian `ask`, kemudian `allow`, sehingga urutan
JSON tidak dapat melemahkan aturan yang lebih ketat. Untuk patch multi-file, allow
berbasis path hanya berlaku bila seluruh file cocok; deny cukup cocok dengan satu
file.

Aturan dimuat ulang pada setiap approval, jadi perubahan manual langsung berlaku.
`allow` tidak dapat menonaktifkan batas workspace, perlindungan secret, mode
read-only, atau sandbox. Command hanya dapat di-auto-allow jika sandbox OS benar-benar
enforced dan bukan `danger-full-access`. Tool yang memang wajib meminta approval
baru—commit Git, MCP call, input proses, aksi browser, pesan WhatsApp, perubahan
memori, dan delegasi penulis—tetap menampilkan dialog walaupun aturan `allow` cocok.
Pada `boo-code exec`, `ask` dan `deny` sama-sama menolak karena tidak ada UI;
`allow` tidak pernah memperluas batas `--approval never|workspace`.

Berkas dibatasi 64 KiB dan 100 aturan per sumber. Symlink konfigurasi yang keluar
dari home/workspace ditolak. Fitur ini hanya membaca JSON lokal dan tidak memakai
database.

### Kesadaran repository

Untuk repository Git, agent memiliki tool baca-saja `git_status` dan `git_diff`
agar perubahan yang sudah dibuat pengguna terlihat sebelum agent mengedit file.
Boo juga menyimpan sidik isi file yang telah dibaca. Jika editor atau proses lain
mengubah file sebelum penulisan dijalankan, penulisan itu ditolak sampai agent
membaca ulang versi terbaru; perubahan pengguna tidak ditimpa diam-diam.

Saat penyebab regresi, maksud desain, atau asal baris benar-benar bergantung pada
sejarah, agent juga dapat memakai:

- `git_log` — commit terbaru, opsional untuk satu path;
- `git_show` — metadata dan patch satu file pada revision tertentu;
- `git_blame` — commit, tanggal, author, subject, dan source untuk rentang maksimal
  200 baris.

Ketiganya baca-saja dan dijalankan lewat argumen proses langsung, bukan shell.
Ref yang menyerupai opsi ditolak, path harus berada dalam workspace, file credential
tidak dapat dibaca, author email tidak pernah dikembalikan, karakter kontrol commit
dinetralkan, dan output dibatasi. Hasil diperlakukan sebagai data workspace tidak
tepercaya. Agent diarahkan memakai sejarah hanya bila relevan agar konteks tidak
habis untuk commit lama.

Bila pengguna secara eksplisit meminta commit, tool `git_commit` membuat commit
lokal dari daftar file yang disebut satu per satu. Seluruh isi terkini file itu
ditampilkan sebagai cakupan approval; direktori, commit implisit seluruh workspace,
file credential, dan metadata `.git`/`.boo` ditolak. Perubahan staged lain tidak
ikut commit dan tetap staged. Boo memeriksa fingerprint file, index, dan HEAD lagi
setelah approval agar perubahan dari editor atau proses lain tidak terselip.

Setiap commit meminta approval baru dan tidak tersedia pada mode read-only maupun
`exec --full-auto`. Git hooks dan signing sengaja tidak dijalankan oleh tool agar
satu approval commit tidak mengeksekusi program tambahan. Jalankan test/lint
sebelum commit; bila signing atau hook diperlukan, lakukan melalui workflow Git
pengguna. Jika commit gagal, keadaan index sebelum percobaan dipulihkan.

Untuk perubahan yang saling terkait, tool `apply_patch` dapat menambah, mengubah,
atau menghapus beberapa file dalam satu approval. Semua path dan hunk divalidasi
lebih dahulu; konteks yang hilang atau ambigu membatalkan seluruh patch sebelum
file pertama ditulis. Perubahan patch juga tercatat sebagai satu checkpoint untuk
`/undo`.

Tool baca-saja `repo_map` membuat outline file sumber dan deklarasi penting lintas
bahasa (TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin, Swift, Dart, dan
lainnya) lengkap dengan nomor baris. Parameter `query` dan `path` memfokuskan
hasil, sehingga agent dapat menemukan modul dan simbol relevan tanpa memasukkan
isi banyak file ke context window. File rahasia, biner, dependency, serta hasil
build tetap dilewati.

Tool `code_search` menangani pencarian konseptual seperti "alur autentikasi" atau
"cache pengguna". Ia meranking path, simbol, identifier, import, dan hubungan
dependency satu tingkat; hasilnya menyertakan baris source terbaru sebagai bukti.
Gunakan `grep` untuk teks atau regex yang persis, `repo_map` untuk melihat struktur,
`code_search` untuk menemukan implementasi ketika nama simbol belum diketahui, dan
`code_graph` untuk menelusuri relasi simbol yang sudah bernama.

Indeks disimpan sebagai JSON di `~/.boo/indexes/<hash-workspace>/`—tanpa database
atau service tambahan. Pemindaian berikutnya memakai ulang metadata file yang
ukuran dan waktu ubahnya sama, memperbarui file berubah, serta membuang file yang
hilang. Cache hanya memuat path relatif, hash, simbol, import, dan identifier;
komentar, string literal, serta source penuh tidak disimpan. File sensitif, biner,
symlink ke luar workspace, file di atas 512 KB, dependency, dan hasil build
dilewati. Cache dibatasi 30 MB, ditulis atomik dengan izin file `600` dan folder
`700`; repository yang melewati batas tetap dapat dicari di memori proses aktif.

### Graf simbol dari AST

Tool `code_graph` menjawab pertanyaan yang tidak terjawab oleh pencarian teks: di
mana sebuah simbol didefinisikan, siapa yang memanggilnya, apa yang ia panggil, dan
apa yang diwarisinya. Untuk JavaScript dan TypeScript, relasi ini diambil dari AST
memakai compiler TypeScript, bukan tebakan regex, sehingga nama yang sama di file
berbeda tidak tercampur dan pemanggilan lewat properti tetap terbaca.

```
› siapa yang memanggil resolveInWorkspace?
  ● Exploring     1 search  0.9s
```

Hasilnya memuat definisi beserta rentang barisnya, pemanggil, yang dipanggil, dan
rantai pewarisan, semuanya merujuk baris source terbaru. Bahasa lain tetap
mendapat deklarasi dan import dari pembacaan berbasis pola, ditandai `fallback`,
jadi tool ini tidak pernah menolak menjawab hanya karena bahasanya belum didukung
penuh.

Compiler TypeScript berukuran belasan megabyte, jadi ia **tidak ikut dibundel** ke
dalam berkas CLI. Ia dipasang sebagai dependency paket dan dimuat sekali saat
analisis AST pertama dibutuhkan; bila tidak tersedia di mesin itu, analisis turun
ke mode `fallback` tanpa error. Paket rilis tetap sekitar satu megabyte.

Tool `diagnostics` mendeteksi pemeriksaan statis yang sudah dikonfigurasi proyek,
misalnya script `typecheck`/`lint`, `go vet`, `cargo check`, `dart analyze`,
`flutter analyze`, Pyright, atau Ruff lokal. Command tidak berasal dari teks model,
ditampilkan melalui approval, dijalankan di sandbox, dan hanya dianggap sebagai
bukti verifikasi bila seluruh pemeriksaan berhasil. Tool ini menjadi pemeriksaan
proyek menyeluruh, sedangkan tool LSP di bawah memberi analisis semantic per-file.

Tool baca-saja `test_impact` menghubungkan file yang berubah dengan test bernama
sepadan dan test yang mengimpor jalur tersebut melalui reverse dependency graph
lokal. Ia juga mendeteksi command test dari konfigurasi nyata seperti script
`package.json`, `go.mod`, `Cargo.toml`, `pubspec.yaml`, konfigurasi pytest, atau
wrapper Gradle/Maven. Tool ini hanya memberi kandidat—tidak pernah menjalankan
command. Setelah edit, hasil yang sama otomatis dimasukkan ke pengingat verifikasi,
sehingga Boo dapat memilih test terkecil yang cukup kuat tanpa menebak command.

### Review baca-saja

`/review` meninjau perubahan working tree, sedangkan `/review main` membandingkan
branch saat ini dengan `main...HEAD`. Mode ini memakai registry terpisah yang hanya
berisi tool analisis. Tool penulis, shell bebas, aplikasi, pengiriman pesan, dan MCP
call tidak diberikan kepada model; command diagnostics/LSP yang terkontrol dipaksa
ke sandbox `read-only`.

Review dimulai dari status dan daftar file berubah, kemudian membaca diff per file
agar file sensitif tidak ikut masuk secara tidak sengaja. Temuan harus menyebut
severity, file/baris, skenario kegagalan, dan hubungan sebab-akibat. Bila model
tetap menghalusinasikan tool tulis, agent loop menolaknya sebagai tool yang tidak
dikenal dan workspace tidak berubah.

### Plan Mode ringan

Gunakan `/plan <tugas>` untuk meminta Boo menyelidiki repository dan menyusun
rencana implementasi tanpa mengubah file. Mode ini hanya mendapat tool analisis
yang sama-sama read-only, sehingga model dapat memeriksa kode, git, LSP, dan
diagnostics sebelum menentukan langkah konkret.

```
› /plan tambahkan cache untuk endpoint katalog tanpa mengubah respons API
```

Rencana final disimpan sebagai bagian riwayat sesi—tanpa database atau berkas
proyek tambahan. Jalankan `/implement` untuk mengerjakan rencana terbaru. Boo
akan memeriksa ulang keadaan repository sebelum mengedit karena kode mungkin
sudah berubah sejak rencana dibuat. Setelah sesi dilanjutkan dengan `/resume`,
rencana yang sama tetap tersedia.

Pakai `/plan` untuk rencana percakapan yang cepat. Untuk pekerjaan besar yang
memerlukan requirements, design, checklist bertahap, dan persetujuan tiap tahap,
pakai `/spec` agar artefaknya tersimpan di `.boo/specs/`.

### Pertanyaan keputusan dari agent

Bila repository tidak menyediakan jawaban dan sebuah pilihan akan mengubah hasil
secara material, Boo dapat berhenti sementara lewat tool `ask_user`. CLI menampilkan
pemilih bernomor; web menampilkan kartu pilihan yang sama. Satu pemanggilan memuat
maksimal sepuluh pertanyaan, masing-masing 2–4 opsi beserta dampaknya dan, bila memang
diperlukan, kolom jawaban bebas.

Contohnya, saat dua strategi migrasi sama-sama valid Boo dapat menanyakan apakah
kompatibilitas API lama harus dipertahankan atau versi baru boleh dibuat. Boo tidak
boleh memakai pertanyaan ini untuk fakta yang dapat dibaca dari repository,
preferensi remeh, persetujuan menjalankan tool, atau sekadar meminta kepastian.
Jawaban dikembalikan sebagai hasil tool dan ikut tersimpan di riwayat sesi—tanpa
database—sehingga `/resume` tetap memiliki konteks keputusan tersebut.

### Trace dan metrik lokal

Setiap permintaan CLI/web secara bawaan menulis satu ringkasan JSONL ke
`~/.boo/traces/`. Trace hanya berisi metrik: model/routing, waktu, turn, nama dan
durasi tool, kegagalan, retry, status verifikasi, tingkat risiko, compaction, jumlah arahan live,
dan hasil akhir.
Prompt, jawaban, reasoning, source code, path file, argumen, preview, serta output
tool tidak direkam. Workspace diidentifikasi dengan hash path, bukan path aslinya.

Gunakan `/stats` untuk melihat agregat 100 run terakhir pada workspace aktif.
Direktori trace berizin `700` dan setiap file `600`. Perekaman dapat dimatikan:

```env
BOO_TRACE=false
```

Trace terpisah per run sehingga tidak membutuhkan database atau lock lintas proses;
file rusak dilewati dan tidak pernah menghambat agent.

### Memori proyek persisten

Boo dapat mengingat fakta stabil antar-sesi, misalnya keputusan arsitektur,
perintah test yang tepat, batasan kompatibilitas, atau konvensi yang tidak mudah
ditebak. Cukup minta dengan bahasa biasa:

```
› ingat untuk proyek ini: test tunggal dijalankan dengan node --test <file>
```

Agent memakai `memory_add` dan menampilkan isi catatan lengkap untuk persetujuan.
Setiap penambahan dan penghapusan selalu meminta persetujuan baru; izin permanen
tidak tersedia. Gunakan "lihat memori proyek" untuk memanggil `memory_list`, atau
"lupakan memori deadbeef" setelah melihat ID catatannya.

Memori disimpan sebagai JSON privat di `~/.boo/memories/<hash-workspace>.json`,
bukan database. Maksimal 100 catatan, 1.000 karakter per catatan, dan 64 KB per
workspace. Catatan identik dideduplikasi dan pola credential/secret ditolak.
Path workspace asli, prompt, jawaban, dan source code tidak disimpan.

Saat dikirim ke model, memori ditandai sebagai konteks fakta berprioritas rendah,
bukan instruksi. Permintaan pengguna saat ini, isi repository, dan hasil tool yang
terverifikasi selalu mengalahkannya. Simpan aturan wajib di `BOO.md`; memori cocok
untuk pengetahuan proyek yang ringkas. Sub-agent baca-saja dapat melihat memori,
tetapi tidak dapat menambah atau menghapusnya.

### Sub-agent paralel

Untuk pekerjaan kompleks yang memiliki beberapa area investigasi independen, agent
utama dapat memakai tool `delegate`. Satu pemanggilan menjalankan paling banyak tiga
sub-agent secara paralel. Masing-masing menerima instruksi yang fokus, system prompt
dan riwayat terpisah, aturan proyek/skill yang sama, serta model yang sudah dipilih
oleh mode Auto untuk task utama.

Sub-agent sengaja hanya memiliki tool eksplorasi: membaca/mencari file, membuat
repository map, melihat status/diff Git, membaca skill, dan melihat katalog MCP.
Sub-agent tidak dapat mengedit file, menjalankan `bash`/diagnostics/LSP, memanggil
MCP, membuka aplikasi, mengirim pesan, atau membuat sub-agent berikutnya. Sandbox
child selalu dipaksa ke `read-only`, termasuk ketika sesi utama memakai
`danger-full-access`.

Setiap child dibatasi delapan putaran secara bawaan dan maksimum dua belas putaran.
Progress tool ditampilkan dengan ID task, kemudian laporan berisi status, jumlah
putaran, jumlah tool call, dan bukti path/baris dikembalikan kepada agent utama.
Agent utama tetap bertanggung jawab memeriksa laporan, mengambil keputusan,
mengimplementasikan perubahan, meminta approval, dan menjalankan verifikasi. Boo
tidak memakai delegasi untuk pekerjaan sederhana karena panggilan model tambahan
menambah waktu dan biaya.

Untuk implementasi yang benar-benar dapat dipisah berdasarkan file/area, Boo juga
memiliki `delegate_write`. Setiap child menerima Git worktree detached tersendiri,
system prompt dan riwayat terpisah, serta file tools untuk membaca dan mengubah kode.
Child tidak mendapat shell bebas, diagnostics/LSP, MCP, aplikasi, pengiriman pesan,
atau kemampuan mendelegasikan lagi. Satu approval baru menampilkan seluruh task dan
mengizinkan batch tersebut saja; izin permanen sengaja tidak tersedia.

Sebelum child berjalan, Boo menyalin perubahan tracked, staged, dan untracked yang
tidak di-ignore dari working tree utama ke setiap worktree. Dengan demikian child
melihat pekerjaan pengguna yang belum di-commit, bukan hanya `HEAD`. Sesudah semua
child selesai, hasil digabungkan secara serial sesuai urutan task. Sebuah task hanya
digabungkan bila semua file tujuannya masih sama dengan snapshot awal. Jika pengguna
atau child sebelumnya sudah mengubah salah satu path, seluruh hasil task itu ditahan
dan dilaporkan sebagai konflik; perubahan terbaru di workspace utama tidak ditimpa.

Worktree sementara disimpan di
`~/.boo/worktrees/<hash-workspace>/batch-*/`, dengan metadata privat `700/600`, lalu
dihapus setelah batch selesai. Batch milik proses yang crash dibersihkan pada
delegasi berikutnya. Ini memakai filesystem dan Git biasa, tanpa database. Fitur ini
memerlukan Boo dijalankan dari akar repository Git yang sudah memiliki minimal satu
commit. Snapshot perubahan dibatasi 20.000 file/128 MB dan hasil merge 64 MB.

Agent utama tetap bertanggung jawab meninjau hasil gabungan dan menjalankan test,
lint, atau build. Berikan task yang tidak menyentuh file sama, misalnya satu child
untuk modul API dan satu child untuk komponen UI. Untuk perubahan yang saling terkait
erat atau menyentuh file bersama, agent utama mengerjakannya sendiri agar konflik dan
keputusan arsitektur tidak terpecah.

### Language Server Protocol

Tool `lsp` memberi agent operasi semantic yang sama dengan editor modern:
`document_symbols`, `definition`, `references`, `hover`, dan `diagnostics` per
file. Posisi memakai nomor baris dan kolom 1-based. Boo mengutamakan language
server lokal proyek dan saat ini mengenali:

| File | Language server |
|---|---|
| TypeScript/JavaScript | `typescript-language-server` |
| Python | `pyright-langserver` |
| Go | `gopls` |
| Rust | `rust-analyzer` |
| C/C++ | `clangd` |
| Dart | Dart Analysis Server |

Boo tidak memasang server secara otomatis. Jika executable belum tersedia, hasil
tool menyebut dependency yang perlu dipasang. Setiap server dijalankan melalui
sandbox command dengan credential environment disaring, meminta approval, diberi
timeout, dan dihentikan setelah query. Lokasi definition/reference di luar
workspace tidak diteruskan ke model, dan permintaan untuk file rahasia ditolak.

### Skills

Boo menemukan skill dari `~/.boo/skills/<nama>/SKILL.md` dan
`<repo>/.boo/skills/<nama>/SKILL.md`. Dalam monorepo, folder `.boo/skills` dari
akar repository sampai workspace ikut dipertimbangkan; nama yang paling dekat ke
workspace menimpa versi global atau induk.

`SKILL.md` dapat memakai metadata sederhana:

```markdown
---
name: review-api
description: Review perubahan API dan kompatibilitas kontraknya.
---

Ikuti checklist di references/checklist.md.
```

Hanya nama dan deskripsi yang masuk ke system prompt. Saat task cocok atau pengguna
menyebut skill, agent memanggil `read_skill`; resource tambahannya dimuat melalui
`read_skill_resource`. Ini menjaga context tetap kecil. Resource wajib berada di
direktori skill, file rahasia/biner ditolak, symlink keluar root tidak diikuti,
dan skill tidak dapat melewati approval maupun sandbox.

### Custom slash commands

Workflow yang sering dipakai dapat disimpan sebagai Markdown di
`~/.boo/commands/<nama>.md` untuk semua proyek atau `.boo/commands/<nama>.md`
untuk proyek aktif. Command proyek menimpa command global bernama sama. Dalam
monorepo, konfigurasi dari akar repository sampai workspace ikut dibaca.

```markdown
---
description: Perbaiki test pada modul tertentu dan verifikasi hasilnya.
---

Cari penyebab test gagal pada $ARGUMENTS, lakukan perbaikan sekecil mungkin,
lalu jalankan test yang relevan.
```

Simpan sebagai `.boo/commands/fix-tests.md`, kemudian jalankan:

```text
› /fix-tests packages/api
```

`$ARGUMENTS` diganti dengan seluruh teks setelah nama command. Jika placeholder
tidak ditulis, argumen tetap ditambahkan di bawah prompt. Subfolder menjadi
namespace: `commands/quality/release.md` dipanggil sebagai `/quality:release`.
Gunakan `/commands` untuk melihat katalog. CLI dan web memuat ulang katalog saat
dipakai; riwayat dan `/resume` tetap menampilkan command asli, bukan prompt hasil
ekspansinya. Nama command bawaan tidak dapat ditimpa. File dibatasi 64 KiB,
symlink keluar root dan file sensitif dilewati, dan fitur ini tidak membutuhkan
database.

### Lifecycle hooks

Boo dapat menjalankan pemeriksaan lokal pada tiga titik lifecycle agent melalui
`~/.boo/hooks.json` atau `.boo/hooks.json`. Konfigurasi proyek dengan pasangan
`event` dan `id` yang sama menimpa konfigurasi global atau induknya.

```json
{
  "hooks": {
    "before_tool": [
      {
        "id": "guard-write",
        "matcher": "write_*",
        "command": "node scripts/check-write-policy.mjs"
      }
    ],
    "after_tool": [
      {
        "id": "lint-edit",
        "matcher": "edit_file",
        "command": "pnpm lint",
        "timeout": 120,
        "verifies_workspace": true
      }
    ],
    "on_complete": [
      {
        "id": "test",
        "command": "pnpm test",
        "timeout": 120,
        "verifies_workspace": true
      }
    ]
  }
}
```

`before_tool` berjalan sebelum tool yang cocok dan memblokir tool bila hook gagal
atau ditolak. `after_tool` menambahkan hasil pemeriksaan ke hasil tool; kegagalannya
dikembalikan kepada model sebagai error agar dapat diperbaiki. `on_complete`
berjalan sebelum agent benar-benar selesai; bila gagal, laporannya dimasukkan ke
context dan agent wajib melanjutkan pekerjaan lalu memeriksa ulang.

`matcher` memakai wildcard `*` dan `?` terhadap nama tool. Tandai hook yang memang
mengubah file dengan `mutates_workspace`, dan hook yang membuktikan hasil kerja
dengan `verifies_workspace`. Setiap command tetap meminta approval dan berjalan
melalui sandbox Boo; izin sesi hanya berlaku untuk command persis yang disetujui.
Gunakan `/hooks` untuk melihat hook aktif. Konfigurasi dibatasi 64 KiB dan 50 hook,
timeout maksimum 120 detik, symlink keluar root serta file sensitif dilewati, dan
fitur ini tidak memerlukan database.

### Model Context Protocol (MCP)

Boo dapat memakai MCP server lokal melalui `stdio` dan server remote melalui
Streamable HTTP. Konfigurasi dibaca dari `~/.boo/mcp.json` dan `.boo/mcp.json` dari
akar repository sampai workspace; server bernama sama yang paling dekat ke
workspace menimpa konfigurasi induknya.

```json
{
  "servers": {
    "project-tools": {
      "command": "node",
      "args": ["/path/ke/mcp-server.mjs"]
    },
    "remote-tools": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer token"
      }
    },
    "disabled-example": {
      "command": "another-mcp-server",
      "enabled": false
    }
  }
}
```

Alurnya sengaja eksplisit:

1. `list_mcp_servers` hanya membaca katalog dan tidak memulai proses.
2. `mcp_list_tools` memulai satu server setelah approval untuk membaca `tools/list`.
3. `mcp_call` menjalankan satu tool dan selalu meminta approval baru sambil
   menampilkan server, nama tool, serta seluruh argumennya.

Server `stdio` mendapat root workspace melalui `roots/list`, dijalankan dengan
kebijakan sandbox dan network Boo, diberi timeout, lalu dihentikan setelah operasi
selesai. Permintaan sampling atau elicitation dari server ditolak. Credential
environment tetap disaring dan konfigurasi proyek tidak dapat menyisipkan
environment variable; gunakan mekanisme login/config milik server di luar
repository.

Streamable HTTP mendukung MCP modern `2026-07-28` yang stateless dan otomatis
fallback ke lifecycle/session `2025-11-25`. Respons satu JSON maupun SSE per-request
didukung. Boo mengirim metadata/header routing modern, memvalidasi dan menerapkan
`x-mcp-header` dari schema tool, menyimpan session hanya selama satu operasi, lalu
mengirim `DELETE` best-effort. Transport HTTP+SSE lama dari MCP `2024-11-05` tidak
diadopsi karena sudah deprecated; server lama perlu menyediakan endpoint Streamable
HTTP.

URL remote wajib HTTPS; HTTP hanya diterima untuk `localhost`, `127.0.0.0/8`, atau
`::1`. Redirect ditolak. Remote non-loopback tetap diblokir kecuali
`BOO_NETWORK_ACCESS=true` atau sandbox memang `danger-full-access`. Header seperti
`Authorization` boleh dikonfigurasi, tetapi nilainya tidak pernah muncul di katalog
atau panel approval—hanya nama header yang ditampilkan. Simpan token di konfigurasi
global `~/.boo/mcp.json`, bukan di repository.

Symlink konfigurasi yang keluar dari root, konfigurasi terlalu besar, URL tidak
aman, header protocol yang mencoba menimpa header milik Boo, nama server tidak
valid, serta command/argument/header dengan karakter kontrol diabaikan. Setiap
discovery tetap meminta approval dan setiap tool call selalu meminta approval baru.

### Bendera baris perintah

| Bendera | Fungsi |
|---|---|
| `--resume [id]` | lanjutkan sesi; tanpa id, pilih dari daftar |
| `--continue` | lanjutkan sesi terakhir di direktori ini |
| `--model <id>` | pilih model untuk sesi ini |
| `--effort <tingkat>` | low, medium, high, atau xhigh untuk GPT-5.6 |
| `--verbose` | tampilkan keluaran tool selengkapnya |
| `--version` | tampilkan versi |
| `--help` | tampilkan bantuan |

### Prompt

Model dan tingkat penalaran yang sedang dipakai tampil di atas baris ketik, dan
ikut berubah begitu `/model` menggantinya:

```
boo · GPT-5.6 Sol · Extra High
> _
```

Namanya diturunkan dari id model saja, tanpa memanggil 9Router, sehingga aman
dibangun ulang setiap kali prompt muncul.

Baris nama dicetak terpisah, bukan dijadikan bagian prompt readline. Prompt yang
memuat baris baru rusak saat readline menggambar ulang barisnya — ketika riwayat
dipanggil dengan panah atas, atau ketika ketikan dipulihkan setelah spinner
berhenti — karena readline hanya kembali ke awal baris ketik lalu membersihkan
ke bawah.

### Menempel teks banyak baris

Log error atau potongan kode yang ditempel tidak lagi pecah menjadi banyak
permintaan. Tempelan banyak baris diwakili satu penanda di baris ketik, jadi kamu
masih bisa menambahkan pertanyaan sebelum atau sesudahnya:

```
› kenapa error ini muncul? [Tempelan #1 · 24 baris]
```

Saat dikirim, penanda diganti dengan isi aslinya utuh. Ini memakai bracketed paste,
yang didukung terminal modern (Terminal.app, iTerm2, Warp, VS Code, Windows
Terminal). Tempelan satu baris langsung disisipkan apa adanya.

### Menulis prompt beberapa baris

Tekan `Shift+Enter` untuk membuat baris baru tanpa mengirim prompt; tekan `Enter`
untuk mengirim seluruh prompt. Boo mengenali shortcut terminal modern (termasuk
kitty keyboard protocol) dan variasi `Esc`+`Enter` dari terminal lama.

Terminal.app bawaan macOS mengirim `Shift+Enter` sama persis dengan `Enter`, jadi
tidak ada aplikasi CLI yang dapat membedakannya tanpa pengaturan terminal. Di
Terminal.app buat mapping satu kali: **Terminal > Settings > Profiles > [profil]
> Keyboard > +**, pilih **Key: Return**, **Modifier: Shift**, **Action: Send
String**, lalu isi `\\033[13;2u`. Restart Terminal, kemudian `Shift+Enter` akan
diterima Boo sebagai baris baru. Apple memang menyediakan pembuatan kombinasi
tombol dan pengiriman string pada pengaturan profil tersebut. Sementara itu,
tekan `Esc` lalu `Enter` dengan cepat sebagai alternatif. [Panduan Apple](https://support.apple.com/en-ae/guide/terminal/trml108/mac)

### Perintah di dalam sesi

| Perintah | Fungsi |
|---|---|
| `/model` | pilih model dengan tombol panah |
| `/model auto` | pilih model dan tingkat penalaran otomatis per permintaan |
| `/model <id> [tingkat]` | ganti langsung, misal `/model cx/gpt-5.6-sol xhigh` |
| `/resume` | pilih dan lanjutkan sesi lain di direktori ini |
| `/fork` | cabangkan konteks percakapan ke sesi eksperimen baru |
| `/rewind [nomor]` | buat cabang baru dari tepat sebelum prompt lama |
| `/init` | minta Boo menulis `BOO.md` berisi aturan proyek ini |
| `/undo` | batalkan perubahan berkas dari permintaan terakhir |
| `/restore [id]` | pulihkan file ke sebelum checkpoint lama |
| `/plan <tugas>` | selidiki repository dan buat rencana tanpa mengubah file |
| `/implement` | kerjakan rencana terbaru dari `/plan` |
| `/commands` | lihat custom slash commands proyek dan global |
| `/hooks` | lihat lifecycle hooks proyek dan global yang aktif |
| `/permissions` | lihat aturan izin persisten dan lokasi konfigurasinya |
| `/attach <path>` | lampirkan gambar ke prompt berikutnya |
| `/attachments [clear]` | lihat atau lepas gambar yang menunggu |
| `/compact` | ringkas percakapan sejauh ini agar konteks lega |
| `/context` | lihat pemakaian, sumber, dan ruang konteks model |
| `/status` | lihat tujuan, progres todo, tool, file terdampak, dan verifikasi task terakhir |
| `/stats` | lihat metrik lokal 100 permintaan terakhir untuk workspace ini |
| `/review [base]` | review working tree atau branch terhadap base tanpa mengedit |
| `/spec <ide>` | rancang fitur dulu: requirements, design, tasks, lalu kerjakan |
| `/spec` | lihat spec di proyek ini dan lanjutkan tahapnya |
| `/queue` | lihat task berikutnya yang mengantre |
| `/queue <task>` | antrekan task baru, bukan arahan untuk pekerjaan aktif |
| `/queue hapus` | kosongkan antrean |
| `/help` | daftar perintah |
| `/keluar` | akhiri sesi |

`/status` tidak memanggil model. Boo membangun potret task dari event agent dan
checkpoint lokal: tujuan asli, hasil akhir, durasi, model/reasoning, turn, jumlah
tool selesai/gagal/ditolak, todo aktif, file terdampak, command, review otomatis,
sinyal prompt injection, dan status verifikasi. Sesudah `/resume`, tujuan dan todo
dipulihkan dari history serta file diambil dari checkpoint; bagian yang memang
tidak direkam ditampilkan sebagai tidak diketahui, bukan ditebak. State ini hidup
di memori proses dan filesystem yang sudah ada, tanpa database.

### Arahan tengah jalan dan antrean

Mengetik teks biasa selagi Boo bekerja menjadi arahan untuk pekerjaan yang sedang
aktif. Arahan tidak memutus model atau command secara paksa: Boo menerapkannya pada
batas aman berikutnya—setelah respons model atau tool yang sedang berjalan selesai.
Jika model sudah meminta tool berdasarkan instruksi lama tetapi tool belum mulai,
tool itu dilewati dan Boo merencanakan ulang berdasarkan arahan terbaru:

```
boo > refactor parser dan pertahankan perilakunya
  * Applying     src/parser.ts  3.2s
› jangan ubah API publik
  ↳ arahan diterima #1
  ↳ 1 arahan tengah jalan diterapkan
  ...
```

Gunakan `/queue <task>` untuk pekerjaan independen yang memang harus dimulai setelah
task aktif selesai. `/queue` menampilkan task tersebut dan `/queue hapus`
mengosongkannya. Command slash, attachment, dan input ketika kartu izin/pertanyaan
sedang terbuka tetap memakai jalur antrean atau jawaban masing-masing—tidak pernah
disisipkan diam-diam sebagai steering.

Maksimal sepuluh arahan atau total 32.000 karakter diterima per task. Arahan yang
sudah diterapkan tersimpan di sesi dengan marker internal, tetapi `/resume`
menampilkannya kembali sebagai baris `↳` tanpa membocorkan marker. Trace hanya
menghitung jumlah arahan, bukan isinya. Spinner juga berhenti begitu kamu mulai
mengetik agar animasinya tidak menimpa huruf yang sedang diketik.

Pada `/model`, gunakan **panah atas/bawah** (atau `j`/`k`) untuk menelusuri,
**enter** untuk memakai, **esc** untuk membatalkan. Terminal yang tidak mendukung
raw mode otomatis mendapat jalur cadangan berupa daftar bernomor yang diketik.

### Memilih model dan tingkat penalaran

9Router mendaftarkan setiap kombinasi model dan tingkat sebagai model terpisah,
sehingga daftar mentahnya panjang dan berulang. `/model` meringkasnya menjadi dua
langkah — pilih keluarga, lalu pilih tingkat penalaran:

```
  Pilih model                     GPT-5.6 Sol · tingkat penalaran
   Gemini 3.5 Flash                  Low
   Gemini 3.7 Flash                  Medium
   Gemini 3.1 Pro                    High
   Claude Sonnet 4.6               > Extra High
   Claude Opus 4.6 Thinking
   GPT-5.6 Luna
   GPT-5.6 Terra
 > GPT-5.6 Sol
   Model lain…
```

Langkah kedua dilewati untuk keluarga yang hanya punya satu varian, termasuk
kedua model Claude. Model lainnya tetap tersedia di bawah **Model lain…**.

Setelah memilih atau membatalkan, daftar dihapus dari layar sehingga riwayat
terminal hanya memuat hasilnya:

```
> /model
  model GPT-5.6 Sol · Extra High
```

Tingkat penalaran disampaikan lewat dua mekanisme yang berbeda:

| Keluarga | Tingkat berada di | Pilihan |
|---|---|---|
| Gemini 3.7 / 3.6 Flash | nama model | Low · Medium · High |
| Gemini 3.5 Flash | nama model | Extra Low · Low · High |
| Gemini 3.1 Pro | nama model | Low saja |
| GPT-5.6 Sol · Terra · Luna | parameter `reasoning_effort` | Low · Medium · High · Extra High |

Pemilih hanya menawarkan tingkat yang benar-benar ada — Gemini 3.5 Flash memang
tidak punya Medium, dan tidak ada Gemini dengan Extra High.

`reasoning_effort` untuk GPT-5.6 telah diverifikasi melewati 9Router: nilai tak
valid ditolak upstream Codex dengan "Invalid value", dan keempat tingkat diterima.
Model Codex lain belum diverifikasi sehingga tidak diberi pilihan tingkat. Besarnya
efek tiap tingkat tidak dapat diukur dari sisi ini karena 9Router tidak melaporkan
`reasoning_tokens`.

Tingkat selalu dibuang saat berpindah ke model yang tidak menerimanya. Mengirim
`reasoning_effort` ke model semacam itu membuat upstream menolak, dan 9Router lalu
mengunci model tersebut beberapa puluh detik untuk semua permintaan berikutnya.

Bentuk langsung dan bendera:

```bash
/model cx/gpt-5.6-sol xhigh          # di dalam sesi
boo --model cx/gpt-5.6-terra --effort high
BOO_EFFORT=high                       # di ~/.boo/.env
```

Mengganti model **tidak menghapus riwayat percakapan** — Boo melanjutkan dengan
konteks yang sama memakai model baru.

### Memilih model saat menjalankan

```bash
pnpm boo --model cx/gpt-5.5     # flag baris perintah
BOO_MODEL=ag/gemini-3-flash pnpm boo
```

Urutan prioritas: flag `--model`, lalu model/mode sesi yang dilanjutkan, lalu
`BOO_MODEL` dari konfigurasi berlapis, lalu mode `auto`.

### Mode Auto

Pilih **Auto · sesuai kesulitan tugas** di `/model`, atau aktifkan langsung:

```bash
/model auto                    # di dalam sesi
boo-code --model auto           # sesi CLI baru
boo-code web --model auto       # antarmuka web
BOO_MODEL=auto                  # default di ~/.boo/.env atau .env.local
```

Auto menilai isi permintaan dan tiga permintaan pengguna terakhir melalui satu
panggilan model ringan tanpa tool. Penilai memberi kategori kesulitan, bukan
nama model; router memilih dari keluarga coding yang dikenal dan benar-benar
terdaftar di 9Router. Kebijakan awalnya:

| Kesulitan | Model yang diprioritaskan | Target penalaran |
|---|---|---|
| Ringan | Gemini Flash, lalu GPT-5.6 Luna | Low |
| Sedang | Gemini 3.1 Pro, lalu GPT-5.6 Terra | Medium |
| Berat | GPT-5.6 Sol, lalu Claude Opus Thinking, lalu Gemini Pro | High |
| Sangat berat | GPT-5.6 Sol, lalu Claude Opus Thinking, lalu Gemini Pro | Extra High |

Ini kebijakan routing Boo, bukan peringkat kecerdasan universal. Bila model utama
tidak terdaftar, router memilih alternatif yang tersedia. Tingkat penalaran hanya
dipakai jika didukung: GPT-5.6 lewat parameter, Gemini bertingkat lewat id model;
Gemini Pro/Claude tanpa opsi tingkat tidak mendapat parameter tambahan.

Kebijakan awal dapat ditingkatkan oleh hasil benchmark lokal. Jalankan suite dengan
minimal dua model berbeda dan gabungkan hasilnya ke profil Auto:

```bash
pnpm eval:benchmark --model ag/gemini-3.1-pro --update-auto-profile
pnpm eval:benchmark --model cx/gpt-5.6-sol --effort high --update-auto-profile
```

Profil disimpan di `~/.boo/auto-performance.json` sebagai agregat skor, kelulusan,
durasi, retry, kegagalan tool, difficulty, dan tag—tanpa prompt, jawaban, source,
atau path workspace. Data eval baru digabung, bukan menimpa statistik model lain.
Auto baru menggunakannya bila sedikitnya dua kandidat tersedia dan masing-masing
memiliki tiga sampel untuk difficulty tersebut. Statistik lebih dari 45 hari
diabaikan. Dengan demikian satu hasil kebetulan, profil rusak, model yang hilang,
atau benchmark lama tidak dapat mengambil alih routing; kebijakan tabel di atas
selalu menjadi fallback.

Model, tingkat, alasan, dan kesulitan terpilih ditampilkan sebelum task berjalan.
Jika profil eval dipakai, alasan juga menampilkan jumlah sampel dan skor routing.
Pemilihan dilakukan ulang pada setiap permintaan baru; permintaan pendek seperti
"lanjutkan" mempertahankan difficulty task sebelumnya selama sesi berjalan. Model
tetap selama satu task, supaya tidak berganti setiap tool call. Riwayat percakapan
tetap utuh dan mode Auto tersimpan untuk `--resume`.

Penilai menambah satu panggilan model per task dan memiliki batas waktu 12 detik.
Bila penilai gagal atau JSON tidak valid, Boo memakai perkiraan lokal dan menandainya
di tampilan. Jika daftar model gagal dimuat, Boo memakai model terakhir. Pilih model
manual kapan saja melalui `/model <id> [tingkat]` untuk menonaktifkan Auto. Sesi
baru memakai Auto secara bawaan; isi `BOO_MODEL` dengan id tertentu untuk membuat
model tersebut menjadi default manual.

## Struktur

```text
packages/
├── core/          # otak — tidak tahu apa pun soal terminal atau browser
│   ├── domain/    # tipe pesan dan kontrak Tool
│   ├── provider/  # adapter 9Router (streaming + tool calling)
│   ├── tools/     # file, search, app launcher, dan command runner
│   ├── agent/     # loop dan system prompt
│   └── design/    # token visual, sama persis dengan yang dipakai web
└── cli/           # binary `boo` — hanya menggambar dan meminta izin
```

Dependency mengarah satu arah: CLI bergantung pada core, core tidak bergantung pada
siapa pun. Web nanti menjadi konsumen kedua dari core yang sama, bukan salinannya.

## Completion verification

Setelah `write_file` atau `edit_file` benar-benar mengubah berkas, agent loop
menambahkan pengingat internal pada putaran berikutnya. Boo harus menjalankan
pemeriksaan yang relevan sesudah edit terakhir—misalnya test, lint, typecheck,
build, atau `git diff --check`. Test yang dijalankan sebelum edit baru tidak
dianggap bukti untuk hasil terbaru. Jika model tetap menyimpulkan pekerjaan tanpa
pemeriksaan, CLI dan web menampilkan peringatan **belum ada verifikasi**; command
yang gagal ditampilkan sebagai **verifikasi belum berhasil**.

### Change Risk Engine

Setelah perubahan terverifikasi, Boo menilai diff checkpoint secara lokal sebagai
risiko **low**, **medium**, atau **high**. Penilaian tidak hanya memakai prompt:
ia mempertimbangkan batas autentikasi/otorisasi, pembayaran, schema dan migrasi,
deployment/infrastruktur, manifest dependency, penghapusan file, pola pelemahan
kontrol keamanan, jumlah file, dan ukuran diff. Alasan yang ditampilkan berupa
kategori umum; source code dan path lengkap tidak ditulis ke trace.

Untuk risiko tinggi, formatter, `node --check`, atau `git diff --check` saja belum
dianggap bukti substantif. Boo meminta satu pemeriksaan yang lebih kuat setelah
edit terakhir—test terarah, typecheck, build, atau diagnostics proyek. Bila proyek
benar-benar tidak menyediakannya, Boo tidak berputar tanpa akhir: ia memberi
peringatan bahwa buktinya lemah dan melanjutkan ke automatic critic. Diff berisiko
tinggi selalu memicu critic walaupun teks task terlihat sederhana.

Risk engine hanya melihat perubahan yang masuk checkpoint tool Boo. Perubahan yang
dibuat sepenuhnya oleh command shell tetap mengikuti batas checkpoint yang sama
dengan `/undo` dan automatic critic; Boo tidak mengklaim sudah menilainya.

## Automatic Reviewer/Critic

Untuk task perubahan kode yang dinilai **berat** atau **sangat berat**, Boo
menjalankan reviewer independen setelah edit terakhir berhasil diverifikasi.
Reviewer menerima task, ringkasan command verifikasi, dan diff checkpoint saat
ini saja. Reviewer tidak menerima tool, tidak dapat mengubah workspace, dan bila
tersedia memakai model kuat lain dari model utama. Jika model lain tidak tersedia,
Boo memakai konteks model aktif yang tetap terisolasi dari percakapan utama.

Output reviewer harus berupa JSON ketat berisi maksimal lima temuan konkret dengan
severity medium, high, atau critical. Temuan diperlakukan sebagai masukan advisory:
agent utama wajib memeriksanya terhadap kode aktual sebelum memperbaiki atau
menolaknya. Setelah perbaikan, verifikasi wajib dijalankan lagi. Siklus dibatasi
dua review per task agar tidak berputar tanpa akhir.

Review otomatis tidak berjalan untuk task ringan, jawaban baca-saja, mode `/review`
manual, mode perencanaan, perubahan yang belum lolos verifikasi, atau perubahan
yang hanya dibuat oleh command shell dan tidak masuk checkpoint Boo. Kegagalan
model reviewer tidak menggagalkan hasil yang sudah terverifikasi; Boo menampilkan
peringatan dan menyimpan metriknya secara lokal. Fitur aktif secara bawaan dan
dapat dimatikan dengan `BOO_AUTO_REVIEW=false`.

## Agent Regression Benchmark

Benchmark menjalankan Boo sungguhan pada salinan fixture di direktori temporer,
lalu memberi skor berdasarkan artefak file, hash berkas yang wajib dipertahankan,
tool yang wajib/dilarang, bukti verifikasi, jumlah putaran, jumlah tool call, dan
isi jawaban. Suite bawaan memuat tujuh kasus untuk debugging, implementasi,
perubahan multi-file, aturan `BOO.md`, investigasi baca-saja, edge case, dan
kompatibilitas API.

Validasi schema, ID unik, expectation, serta keberadaan seluruh fixture tidak
menghubungi provider dan tidak memakai kuota:

```bash
pnpm eval:validate
```

Jalankan smoke test singkat atau benchmark lengkap—keduanya memakai provider/model
yang dikonfigurasi dan dapat memakai kuota:

```bash
pnpm eval:smoke
pnpm eval:benchmark
pnpm eval evals/benchmark.json --tag debugging
pnpm eval evals/benchmark.json --case investigate-config --keep
pnpm eval evals/benchmark.json --model <id> --effort high --update-auto-profile
```

Selama benchmark, perubahan file hanya terjadi pada salinan temporer. Shell ditolak
kecuali command-nya sama persis dengan salah satu `allowedCommands` pada kasus;
aksi aplikasi, WhatsApp, dan operasi berisiko lain tetap ditolak. `--case` dan
`--tag` dapat diulang; bila keduanya diberikan, sebuah kasus harus cocok dengan
keduanya. `--keep` mempertahankan workspace agar kegagalan dapat diperiksa.
`--model` dan `--effort` memungkinkan model diuji secara tetap. Setiap kasus bawaan
memiliki difficulty eksplisit agar hasil model manual tetap dapat melatih router.
`--update-auto-profile` hanya menyimpan agregat privat ke profil Auto; tidak ada
database dan tidak ada isi pekerjaan yang direkam.

Laporan JSON menyimpan hasil per kasus, durasi, model, skor, turn, tool call,
kegagalan tool, retry, dan status verifikasi. Baseline juga berupa JSON biasa—tanpa
database. Perbandingan hanya mencakup kasus yang benar-benar dijalankan, sehingga
filter parsial tidak dianggap menghilangkan kasus lain:

```bash
pnpm eval:benchmark --report .boo/eval/latest.json \
  --write-baseline .boo/eval/baseline.json

pnpm eval:benchmark --report .boo/eval/latest.json \
  --baseline .boo/eval/baseline.json --tolerance 5
```

Run keluar dengan kode `1` bila ada kasus gagal atau regresi baseline. `--tolerance`
mengizinkan penurunan skor hingga persentase tertentu, tetapi kasus yang sebelumnya
lulus lalu gagal selalu dianggap regresi.

Format suite:

```json
{
  "schemaVersion": 1,
  "name": "Regression project",
  "model": "auto",
  "cases": [{
    "id": "fix-example",
    "prompt": "Perbaiki bug dan jalankan test.",
    "fixture": "fixtures/fix-example",
    "tags": ["debugging", "typescript"],
    "difficulty": "standard",
    "allowedCommands": ["pnpm test"],
    "expect": {
      "files": [
        { "path": "src/app.ts", "contains": "expected code" },
        { "path": "test/app.test.ts", "sha256": "<64-digit-sha256>" }
      ],
      "requiredTools": ["edit_file", "bash"],
      "requireVerification": true,
      "maxTurns": 8,
      "maxToolCalls": 12
    }
  }]
}
```

## Sesi

Setiap percakapan disimpan, sehingga dapat dilanjutkan setelah `boo-code` ditutup —
seperti `claude --resume`. Saat keluar, perintahnya ditampilkan:

```
  Lanjutkan sesi ini: boo-code --resume 5bd73640
```

| Perintah | Fungsi |
|---|---|
| `boo-code 5bd73640` | langsung buka sesi tertentu, tanpa memilih; id lengkap atau awalannya |
| `boo-code --resume 5bd73640` | sama dengan di atas |
| `boo-code --resume` | pilih dari daftar sesi di direktori ini, terbaru lebih dulu |
| `boo-code --continue` | langsung lanjutkan sesi yang terakhir diperbarui |
| `/resume` | di dalam sesi: pindah ke sesi lain tanpa keluar dari `boo-code` |
| `/fork` | salin percakapan aktif lalu lanjutkan pada id sesi baru |
| `/rewind [nomor]` | pilih prompt lama lalu lanjutkan dari keadaan sebelumnya pada cabang baru |

`/resume` membuka pemilih yang sama dengan `boo-code --resume`, dengan sesi yang sedang
berjalan ditandai *(aktif)*. Sesi yang ditinggalkan sudah tersimpan pesan demi pesan,
jadi tidak ada yang hilang. Riwayat percakapan, model dan tingkat penalaran, serta
riwayat panah atas ikut berpindah; izin *untuk sisa sesi* dikosongkan karena diberikan
dalam konteks percakapan sebelumnya.

`/fork` membuat jalur eksperimen tanpa menimpa sesi asal. Seluruh pesan, ringkasan
konteks, mode Auto/manual, model, dan tingkat penalaran terakhir disalin ke berkas
sesi baru; kelanjutan percakapan setelah itu tersimpan independen dan sesi asal
tetap dapat dibuka lewat `/resume`. Web menyediakan tombol **Cabangkan sesi** dengan
perilaku yang sama. Cabang sengaja tetap memakai direktori kerja yang sama—fitur ini
tidak menyalin atau mengembalikan file proyek—dan riwayat `/undo` dimulai kosong.
Gunakan Git worktree bila eksperimen juga harus mengisolasi perubahan filesystem.
Semua metadata tetap berupa JSONL privat di `~/.boo/sessions`, tanpa database.

`/rewind` menampilkan seluruh prompt sesi di terminal; `/rewind 4`, misalnya,
membuat cabang berisi keadaan **sebelum prompt #4**. Model, tingkat penalaran, mode
Auto/manual, dan ringkasan konteks dipulihkan sesuai titik waktu tersebut—bukan
nilai terbaru sesi. Sesi asal tetap utuh. Web menyediakan tombol **Putar balik**
yang menampilkan 20 prompt terbaru; prompt yang lebih lama dapat dipilih dengan
mengetik `/rewind <nomor>`. Rewind hanya berlaku pada percakapan: file workspace
tidak dikembalikan dan riwayat `/undo` cabang dimulai kosong.

Sesi yang dilanjutkan memulihkan riwayat percakapan, model dan tingkat penalaran
terakhirnya, serta riwayat ketikan untuk panah atas.

Percakapannya **ditampilkan ulang seperti saat berlangsung**, sehingga membuka sesi
terasa kembali ke halaman chat-nya: pertanyaan persis seperti diketik, jawaban
dirender sebagai markdown, pekerjaan tool diringkas dengan baris fase yang sama
dengan tampilan langsung, dan penolakan tampil beserta arahannya. Isi hasil tool —
isi berkas dan keluaran perintah — tidak ditampilkan, sama seperti saat sesi
berjalan. Sesi panjang dibatasi pada 20 tukar-jawab terakhir.

```
  melanjutkan sesi 51d91869 · 10 pesan · 36 menit lalu

> Ubah baris kedua catatan.md dengan edit_file ...
  x Ubah berkas catatan.md · ditolak: tulis dengan huruf kapital semua
  * Applying      catatan.md

  Baris kedua catatan.md telah diubah menjadi huruf kapital semua.
```

Argumen tanpa bendera dianggap id sesi, tetapi nilai milik bendera lain tidak:
`boo-code --model cx/gpt-5.5` membuka sesi baru, bukan mencari sesi bernama `cx/gpt-5.5`. Bendera `--model` dan `--effort`
tetap dapat dipakai untuk mengganti model sesi itu.

### Penyimpanan

Setiap sesi adalah satu berkas JSONL di `~/.boo/sessions`. Rekaman ditambahkan
baris demi baris secara sinkron begitu pesan masuk ke riwayat, sehingga proses yang
berhenti mendadak — Ctrl-C, terminal ditutup, crash — paling banyak kehilangan
baris yang sedang ditulis. Membuka `boo` lalu langsung keluar tidak meninggalkan
berkas.

Sesi dapat memuat potongan kode dan apa pun yang diketik, jadi direktorinya hanya
dapat dibuka pemiliknya (`700`) dan berkasnya hanya dapat dibaca pemiliknya (`600`).
Isi berkas rahasia tidak pernah ada di dalamnya, karena `read_file` menolaknya
sebelum dibaca.

### Sesi terikat ke direktorinya

Sesi hanya dapat dilanjutkan dari direktori tempat ia dibuat. Riwayatnya merujuk
berkas di direktori itu, dan workspace adalah batas yang tidak boleh dilewati tool —
melanjutkannya dari tempat lain akan membuat agent bertindak atas berkas yang
keliru. `boo` menolak dan menunjukkan perintah yang benar.

### Sesi yang terputus

Proses yang berhenti di tengah pekerjaan dapat meninggalkan riwayat yang tidak sah:
pemanggilan tool tanpa hasil, atau pertanyaan tanpa jawaban. Model menolak riwayat
seperti itu, sehingga sesinya tidak akan dapat dilanjutkan sama sekali. Saat dimuat,
riwayat diperbaiki lebih dulu:

- Tool yang terputus diberi hasil *tidak dijalankan*.
- Pertanyaan yang tak sempat dijawab diberi jawaban pengganti, di mana pun letaknya
  dalam riwayat — termasuk sesi yang pernah dilanjutkan lalu terputus lagi.
- Hasil tool yatim dan baris berkas yang terpotong dibuang.
- Berkas yang berakhir di tengah baris diberi baris baru sebelum rekaman berikutnya,
  supaya pesan pertama setelah crash tidak tertempel pada baris rusak dan ikut hilang.

Perbaikan dilaporkan saat sesi dibuka:

```
  sesi sebelumnya berhenti mendadak: 1 baris rusak dilewati, 1 tool yang
  terputus ditandai tidak dijalankan, 1 permintaan terputus ditandai belum dijawab
```

Selain riwayat pesan, setiap permintaan memiliki jurnal runtime kecil di
`~/.boo/runs/<hash-workspace>/`. Jurnal mencatat waktu, session ID, turn, model,
nama tool, status verifikasi, dan outcome—tidak menyimpan prompt, source, path,
argumen, preview, jawaban, atau output tool. Bila tidak ada rekaman `finish` dan
PID pemiliknya sudah mati, run dianggap terputus.

Pada permintaan pertama setelah resume, Boo menerima **Durable Task Resume** satu
kali. Konteksnya menggabungkan tujuan user terakhir dari history, progres todo,
model dan reasoning terakhir, tool yang selesai/gagal/ditolak atau belum pasti,
status verifikasi, sinyal prompt injection, serta label file dari checkpoint
privat. Source, prompt, argumen, preview, jawaban, dan output tool tetap tidak
disalin ke jurnal. Jika command shell pernah berjalan, recovery juga mengingatkan
bahwa mungkin ada state lain di luar file snapshot.

Status `needed` dicatat segera setelah setiap mutasi, bukan menunggu putaran model
berikutnya; verifikasi sukses mengubahnya menjadi `complete`. Boo kemudian mengikuti
protokol recovery: periksa `git status` dan filesystem aktual, baca ulang file
terdampak, cek efek tool yang terputus sebelum mengulang side effect, lanjutkan hanya
todo yang belum selesai, lalu jalankan verifikasi baru sebelum menyatakan selesai.
Catatan ini tidak ditambahkan ke history. File jurnal berizin `600` dan foldernya
`700`; paling banyak 500 run terbaru disimpan per workspace. Semua state berupa
JSONL dan checkpoint file—tidak memerlukan database.

### Menghentikan pekerjaan: Esc dan Ctrl-C

Selagi Boo bekerja, baris status menampilkan `esc untuk berhenti`. Menekan **Esc**
atau **Ctrl-C** menghentikan pekerjaan itu seketika, di titik mana pun:

- saat model masih menulis jawaban — permintaan ke 9Router diputus, teks yang
  sudah tampil disimpan;
- saat perintah `bash` berjalan — prosesnya ikut dimatikan (`sleep 30` berhenti
  dalam sekitar satu detik);
- saat pencarian `grep` berjalan, atau sebelum tool berikutnya dijalankan — tool
  yang tersisa tidak dijalankan sama sekali.

```
› jalankan sleep 30 && echo BANGUN
  ✓ Jalankan perintah · sleep 30 && echo BANGUN · diizinkan
  ✗ Dibatalkan
```

Setelah dihentikan, riwayat tetap sah: setiap tool yang dipanggil diberi hasil
"Dibatalkan", dan jawaban ditutup dengan tanda dibatalkan. Model tahu apa yang
tidak jadi dikerjakan, dan pertanyaan berikutnya tidak ditolak. Tanda yang sama
tampil saat sesi dilanjutkan dengan `boo-code --resume`.

Antrean tidak ikut dibuang. Cara cepat mengoreksi arah Boo: ketik koreksinya
(masuk antrean), lalu tekan Esc — pekerjaan lama berhenti dan koreksi langsung
dijalankan.

Saat Boo tidak bekerja, Ctrl-C menutup sesi dengan tertib. Ctrl-C kedua setelah
pekerjaan dihentikan keluar seketika. Keduanya aman, karena setiap pesan sudah
tersimpan begitu masuk ke riwayat.

## Tampilan proses

Selagi Boo bekerja, satu baris hidup menunjukkan apa yang sedang dikerjakan saat
itu, lengkap dengan waktu berjalannya:

```
  ⠋ Writing       src/komponen/tombol.tsx · 42 lines  12s
```

Setiap label berasal dari kejadian nyata di agent, bukan kata yang bergiliran
untuk hiasan:

| Label | Kapan |
|---|---|
| **Thinking** | menunggu jawaban pertama atas permintaan, atau model sedang bernalar |
| **Orchestrating** | model memutuskan langkah berikutnya setelah hasil tool kembali |
| **Generating** | model menulis jawaban |
| **Searching** | `list_dir` menelusuri folder |
| **Reading** | `read_file` membaca berkas |
| **Writing** | `write_file` menulis berkas |
| **Implementing** | `edit_file` mengubah kode yang sudah ada |
| **Running** | `bash` menjalankan perintah |
| **Waiting** | `ask_user` sedang menunggu keputusan pengguna |

Writing dan Implementing tampil sejak model mulai **menggenerate argumen tool**,
bukan baru saat tool dijalankan. Untuk `write_file` argumen itu adalah isi berkas
itu sendiri dan dapat mengalir belasan detik; selama itu jumlah baris yang sudah
selesai ditulis bertambah di baris status.

> Model `ag/*` menerima argumen tool dari 9Router dalam satu potongan utuh, jadi
> fase itu tidak terlihat dan labelnya baru muncul saat argumennya lengkap. Model
> `cx/*` mengalirkannya sedikit demi sedikit.

Ketika pekerjaan dalam satu kelompok selesai, baris hidup dibekukan menjadi
ringkasan:

```
boo > Buat bagi() melempar Error kalau pembagi nol, lalu uji.

  * Exploring     1 file, 1 directory  3.2s
  * Applying      hitung.js . 1 command  6.0s
```

Label hidup dan ringkasan sengaja dipisahkan. Membaca berkas lalu menelusuri folder
tetap menjadi satu ringkasan Exploring walau labelnya berganti di antaranya, dan
Thinking maupun Orchestrating tidak pernah dibekukan — model berpikir di antara
setiap pemanggilan tool, sehingga membekukannya akan memenuhi layar dengan baris
yang sama berulang.

Baris hidup dipotong agar muat selebar terminal. Baris yang terbungkus tidak dapat
digambar ulang di tempat, dan setiap frame akan meninggalkan sisa di layar.

Kegagalan tool tidak pernah disembunyikan di balik ringkasan. Untuk melihat
keluaran tool selengkapnya, jalankan dengan `--verbose`.

Semua keluaran selama Boo bekerja melewati satu pintu yang memperhatikan posisi
kursor dan baris ketik. Spinner selalu mendapat baris sendiri sehingga tidak
menghapus kalimat pengantar model, dan keluaran yang tiba selagi kamu mengetik
permintaan berikutnya ditahan lalu dilepas setelah ketikan dikirim — tidak menyusup
ke baris ketik maupun menghapus jawaban yang sedang mengalir.

## Dynamic Tool Discovery

Boo tidak lagi mengirim seluruh katalog tool ke model pada setiap putaran. Task baru
dimulai dengan tool inti untuk membaca, mencari, mengedit, menjalankan command,
melihat status Git, mengelola todo, dan meminta keputusan pengguna. `tool_search`
mencari capability khusus secara lokal—misalnya `browser interaction`, `git history`,
`project diagnostics`, `MCP integration`, atau `WhatsApp message`—lalu mengaktifkan
skema yang cocok mulai putaran berikutnya.

Tool yang ditemukan tetap aktif selama task yang sama dan di-reset pada task baru.
`list()`/policy runtime masih melihat katalog lengkap, jadi approval, permission,
mode review, dan sesi lama tidak kehilangan batas keamanannya. Mode review hanya
dapat mencari tool baca-saja yang memang diizinkan; sub-agent memakai katalog
terpisah sesuai kemampuannya. Pencarian, ranking, dan state aktivasi seluruhnya
lokal di memori, tanpa database atau request jaringan.

Pemangkasan skema mengurangi token tetap yang harus dibayar sebelum isi percakapan,
memberi ruang lebih besar untuk source code dan hasil pemeriksaan, serta memperkecil
kemungkinan model memilih tool khusus yang tidak relevan. `/context` otomatis
menghitung hanya skema yang sedang aktif.

## Pencarian kode

Agent menemukan kode dengan mencari lebih dulu, bukan menelusuri folder satu per satu
lalu membaca berkas utuh — cara itu lambat dan cepat menghabiskan anggaran konteks.

| Tool | Fungsi |
|---|---|
| `glob` | mencari berkas berdasarkan pola nama, misalnya `src/**/*.ts`; terakhir diubah lebih dulu |
| `grep` | mencari isi berkas dengan regex; hasil berupa `path:baris: isi` |
| `code_search` | meranking kode secara konseptual dari path, simbol, identifier, import, dan dependency |
| `code_graph` | definisi, pemanggil, yang dipanggil, dan pewarisan satu simbol dari AST |
| `test_impact` | menemukan test terdampak dan command test yang terkonfigurasi tanpa menjalankannya |
| `repo_map` | outline file dan deklarasi lintas bahasa dengan filter query/path |
| `git_status` / `git_diff` | membaca perubahan repository tanpa shell bebas |
| `git_log` / `git_show` / `git_blame` | memahami sejarah, patch commit, dan asal baris secara terbatas |
| `lsp` | simbol, definition, references, hover, dan diagnostics semantic |

`grep` dapat dibatasi ke satu berkas atau folder (`path`), ke pola berkas (`include`),
tanpa membedakan huruf besar-kecil (`ignore_case`), atau hanya mengembalikan nama berkas
beserta jumlah kecocokan (`files_only`). Hasil dibatasi 200 baris.

Folder hasil build dan dependensi — `node_modules`, `dist`, `build`, `.git`, `target`,
dan sejenisnya — tidak ditelusuri. Berkas biner dan berkas di atas 1 MB dilewati. Pola
`**/*` tidak mencakup dotfile, sama seperti ripgrep; sebut polanya secara eksplisit bila
perlu, misalnya `.github/**/*.yml`.

Dua batas yang sama dengan tool lain tetap berlaku:

- **Isi berkas rahasia tidak pernah dibaca**, termasuk bila `.env` disasar langsung
  lewat `path` atau `include`; berkasnya dilewati dan dicatat sebagai *rahasia dilewati*.
- **Pencarian tidak dapat keluar dari workspace**, termasuk lewat pola seperti
  `../**/*` atau path absolut.

## Aturan proyek: BOO.md

Tulis aturan yang harus selalu diikuti Boo di proyek ini — perintah test, gaya
kode, hal yang tidak boleh disentuh — ke `BOO.md` di akar repo. Boo membacanya di
setiap sesi, jadi tidak perlu mengulang penjelasan yang sama:

```markdown
# Aturan

- Pakai pnpm, bukan npm. Test: `pnpm test`, satu berkas: `node --test <berkas>`.
- Komentar dalam bahasa Indonesia.
- Jangan ubah apa pun di `migrations/`.
```

Tidak mau menulis sendiri? Ketik `/init`: Boo menyelidiki proyeknya lalu menulis
`BOO.md` (atau memperbaiki yang sudah ada), dengan izinmu seperti berkas lain.

Berkas yang dibaca, dari yang paling umum ke yang paling spesifik:

| Lokasi | Kegunaan |
|---|---|
| `~/.boo/BOO.md` | aturan pribadi untuk semua proyek, misal "jawab singkat" |
| setiap direktori dari akar repo git sampai direktori kerja | aturan repo, lalu aturan per paket di monorepo |

Di setiap direktori hanya satu berkas yang dipakai: `BOO.md`, atau bila tidak ada
`AGENTS.md`, atau `CLAUDE.md` — repo yang sudah punya aturan untuk Codex atau
Claude Code langsung terbaca. Bila bertentangan, aturan yang lebih dekat ke
direktori kerja menang. Di luar repo git, hanya direktori kerja yang dibaca.

Berkas yang dimuat tampil saat Boo dibuka:

```
  Boo Code · Gemini 3.1 Pro · ~/proyek/web
  aturan proyek: ~/.boo/BOO.md, ../../AGENTS.md, BOO.md
```

Aturan dibaca ulang sebelum setiap permintaan. Mengubah `BOO.md` di tengah sesi —
sendiri atau lewat Boo — langsung berlaku, dan diberitahukan:

```
› apa ibu kota Prancis?
  aturan proyek dimuat ulang: BOO.md
```

Batasnya:

- **32 KB gabungan.** Aturan masuk ke setiap permintaan dan memakan anggaran
  konteks; yang melebihi batas dipotong dan ditandai `(dipotong)`.
- **Tidak bisa melonggarkan izin.** Aturan hanya memengaruhi apa yang dikerjakan
  model. Persetujuan untuk `write_file`, `edit_file`, dan `bash`, batas workspace,
  dan larangan membaca file rahasia tetap ditegakkan oleh kode.
- **Symlink tidak dipercaya.** Berkas aturan yang merupakan symlink ke luar repo
  atau ke file rahasia (`.env`, kunci) diabaikan. Isi aturan dikirim ke model,
  jadi repo yang dikloning tidak boleh bisa menyelipkan kunci milikmu ke sana.

Karena aturan dari repo ikut dibaca, periksa `BOO.md`/`AGENTS.md` di repo asing
sebelum meminta Boo bekerja di sana, sama seperti memeriksa skripnya.

### Aturan nested yang mengikuti target file

Dalam monorepo, aturan dapat diletakkan lebih dalam dari direktori tempat Boo
dijalankan. Misalnya `packages/ui/AGENTS.md` hanya berlaku untuk
`packages/ui/**`, sedangkan `packages/api/BOO.md` hanya berlaku untuk
`packages/api/**`.

Boo menemukan aturan nested ketika:

- prompt memakai `@path` ke file atau folder tersebut;
- tool membawa `path`, `paths`, atau `changed_files` eksplisit;
- `apply_patch` menyebut file pada header patch;
- sub-agent membaca atau menulis file di worktree-nya.

Untuk tool call yang pertama kali menemukan scope baru, Boo memuat aturan lalu
**menunda tool sebelum preview, approval, hook, pembacaan, atau perubahan file**.
Model menerima hasil `[BOO SCOPED INSTRUCTIONS]`, membaca system prompt terbaru,
dan harus mengajukan ulang tindakan yang masih sesuai. Dengan demikian file tidak
sempat disentuh memakai asumsi aturan parent.

Aturan sibling tidak saling bocor: instruksi UI tidak diterapkan ke API. Jika satu
patch menyentuh beberapa package, seluruh scope yang relevan ditampilkan dengan
label `(scope: path/**)`. Perubahan pada berkas aturan yang sudah aktif juga dimuat
sebelum turn model berikutnya. Discovery hanya membaca file aturan biasa di dalam
repo, tetap menolak symlink keluar/secret, berbagi batas konteks 32 KB, dan tidak
memerlukan database.

## Tampilan jawaban

Jawaban model dirender dari markdown menjadi teks terminal yang rapi, dengan warna
yang sama dengan web:

| Markdown | Tampilan |
|---|---|
| `**tebal**`, `*miring*`, `~~coret~~` | gaya teks, tanpa penandanya |
| `` `kode` `` | merah muda, sama dengan inline code di web |
| `[label](url)` | label bergaris bawah, alamat redup |
| `#`, `##`, `###` | tebal; dua tingkat pertama berwarna aksen |
| `-`, `1.`, `- [ ]` | `•` `◦` `▪`, nomor, `☐` `☑`, dengan indentasi bertingkat |
| blok kode | label bahasa, garis tepi, syntax highlighting |
| tabel | bingkai, kolom sejajar, isi sel dibungkus bila terlalu lebar |
| `>` | garis tepi aksen, miring |
| `---` | garis pemisah redup |

Teks dibungkus pada batas kata dengan indentasi gantung, sehingga lanjutan baris
sejajar dengan awal isinya — termasuk di dalam butir daftar dan sel tabel. Lebar
dihitung per kolom terminal, bukan per karakter: emoji dan aksara CJK memakan dua
kolom, sehingga tabel berisi emoji tetap sejajar.

### Tampil per baris lengkap

Jawaban tiba sepotong-sepotong, dan konstruksi markdown sering terpotong di tengah
(`**teb` lalu `al**`). Seperti Codex, sebuah baris baru ditampilkan setelah lengkap,
sehingga gayanya diputuskan dengan pengetahuan penuh atas isinya: penanda yang tidak
pernah ditutup tampil apa adanya, alih-alih membuat sisa jawaban tebal. Tabel
ditahan sampai bloknya berakhir karena lebar kolom bergantung pada seluruh isinya.
Selama baris belum lengkap, spinner Orchestrating tetap tampil.

Aturan penekanan mengikuti CommonMark secara sederhana supaya teks teknis tidak
rusak: `2 * 3 * 4` tetap apa adanya, `nama_variabel_ini` tidak miring, dan isi code
span maupun blok kode tidak pernah diproses sebagai markdown.

Syntax highlighting mengenali keluarga C (JS, TS, Go, Rust, Java, …), Python, shell,
SQL, JSON/YAML, dan diff. Ia sengaja ringan — dipecah dengan ekspresi reguler, bukan
parser — karena tujuannya membuat kode mudah dipindai, dan pustaka highlighter
lengkap terlalu mahal untuk CLI yang dijalankan berkali-kali.

## Saat 9Router bermasalah

Limit model, 9Router yang sibuk, atau koneksi yang putus sebentar tidak lagi
menghentikan pekerjaan. Panggilan diulang otomatis sampai tiga kali:

```
› halo
  ↻ [antigravity/claude-sonnet-4-6] [429]: Resource exhausted (reset after 2s) · mencoba lagi dalam 3s (1/3)

  Jawaban setelah pulih.
```

| Keadaan | Diulang? | Jeda |
|---|---|---|
| limit (429), 9Router/provider sibuk (500, 502, 503, 504, 529) | ya | sesuai `reset after Ns` dari 9Router, atau 2s, 5s, 15s |
| koneksi putus, atau tidak ada data sama sekali selama 120 detik | ya | 2s, 5s, 15s |
| permintaan salah (400), kunci salah (401/403), model tidak ada (404) | tidak | — |
| limit dengan jeda lebih dari 60 detik | tidak | — |

9Router menambahkan `(reset after Ns)` pada error **apa pun**, termasuk
permintaan yang memang salah, jadi keputusan mengulang diambil dari status
provider di dalam pesannya (`[429]`), bukan dari ada-tidaknya tanda reset.
Mengulang permintaan yang salah hanya membuang waktu.

Batas waktu 120 detik dihitung sejak data terakhir diterima, bukan sejak
permintaan dimulai: jawaban panjang yang terus mengalir tidak pernah diputus.
Esc tetap bekerja selama menunggu jeda.

Bila tetap gagal, error ditampilkan dan dicatat di riwayat sebagai jawaban yang
gagal. Model tahu jawabannya tadi tidak sampai, dan pertanyaan berikutnya tidak
ditolak.

## Loop & Stall Guard

Boo menghentikan pola tool yang berputar tanpa kemajuan. Guard hanya aktif untuk
panggilan **berturut-turut** dengan nama dan argumen yang sama persis, lalu
memastikan hasilnya juga sama:

1. Panggilan pertama berjalan normal.
2. Hasil identik kedua memunculkan peringatan dan instruksi tepercaya agar model
   mengganti pendekatan.
3. Panggilan identik ketiga diblokir **sebelum tool dijalankan**, sehingga side
   effect tidak terjadi lagi.
4. Jika model tetap mengulanginya, task dihentikan dengan riwayat yang tetap sah
   dan dapat dilanjutkan memakai pendekatan berbeda.

Argumen, hasil, atau nama tool yang berubah dianggap kemajuan dan mereset urutan.
`bash_output` dan `bash_input` dikecualikan karena proses interaktif memang dapat
memerlukan polling/input berulang. Penolakan pengguna lebih tegas: izin tidak
ditanyakan ulang untuk panggilan identik; percobaan berikutnya langsung diblokir.

Guard menyimpan hanya hash signature dan hasil di memori selama satu request.
Prompt, argumen, dan output tool tidak ditulis ke database atau log baru. `/status`
menampilkan jumlah peringatan dan pemblokiran loop pada task terakhir.

## Tool Argument Guard & Self-Correction

Setiap function call divalidasi lokal terhadap schema tool **sebelum** Boo membuat
preview, membuka dialog persetujuan, menjalankan lifecycle hook, atau mengeksekusi
tool. Guard memeriksa JSON object, field wajib, tipe, enum, pola, batas angka,
jumlah item, dan struktur object/array bertingkat.

Bila model mengirim argumen salah, tool tidak dianggap pernah berjalan. CLI dan web
menampilkan path schema yang bermasalah, misalnya:

```
! write_file tidak dijalankan · argumen tidak valid
    $.content: wajib diisi
```

Model menerima pengingat system sementara yang tepercaya untuk memperbaiki function
call pada putaran berikutnya. Pesan koreksi hanya memuat nama tool, path field, dan
aturan schema—nilai argumen mentah tidak disalin ke event, trace, atau jurnal run.
JSON rusak juga tidak dipantulkan kembali, sehingga payload besar atau sensitif
tidak bocor ke log. Jika kode `preview` tool sendiri melempar error, guard memakai
jalur aman yang sama dan tidak meminta approval atau menjalankan tool.

`boo-code exec --json` mengeluarkan event `tool.invalid`, sedangkan `/status`
menampilkan jumlah argumen invalid. Semuanya berjalan di proses lokal tanpa DB atau
permintaan model tambahan.

## Tool Protocol Circuit Breaker

Argument Guard menangani satu function call yang salah; Circuit Breaker menangani
model/provider yang **terus** gagal memakai protokol tool. Hanya putaran yang seluruh
call-nya invalid yang dihitung—nama tool tidak dikenal, JSON rusak, schema tidak
cocok, atau finish reason meminta tool tetapi tidak membawa call. Satu call valid
dalam batch membuktikan protokol masih bekerja dan langsung mereset rangkaian.

Pada putaran invalid pertama Boo memberi koreksi tepercaya. Putaran kedua memunculkan
peringatan di CLI/web. Pada putaran ketiga circuit terbuka: mode Auto mengarantina
model tersebut untuk sesi aktif dan mencoba model cadangan; mode manual berhenti
dengan riwayat yang tetap sah. Auto membatasi fallback protokol maksimal dua kali,
sehingga beberapa model rusak tidak membuat pekerjaan berputar tanpa akhir.

Tool call tanpa ID atau dengan ID duplikat dinormalisasi sebelum masuk history,
agar setiap hasil tetap berpasangan dengan pemanggil yang unik. Call invalid tidak
pernah mencapai preview, approval, hook, atau eksekusi. Event hanya menyimpan jenis
kegagalan dan hitungan—bukan payload argumen—serta tersedia sebagai
`tool.protocol_warning|fallback|stopped` pada `exec --json`. `/status` menampilkan
peringatan, fallback, dan penghentian. Seluruh state hanya hidup di memori tanpa DB.

## Task-scoped Evidence Cache

Pembacaan `read_file` yang sukses disimpan selama satu task. Bila model meminta
file, offset, dan limit yang sama lagi, Boo tidak membaca filesystem atau mengirim
ulang isi panjang ke history. Runtime mengembalikan reference kecil
`[BOO EVIDENCE CACHE REF:…]`; jika hasil asli kemudian terbuang oleh trimming atau
compaction, bukti penuh dihidrasi kembali sebelum request provider berikutnya.

Cache sengaja konservatif: hanya pembacaan file eksak yang memiliki snapshot/hash,
bukan hasil pencarian direktori yang dapat berubah tanpa path teramati. Cache
dibersihkan ketika file teramati berubah dari luar, tool menulis workspace,
command berjalan, lifecycle hook memutasi workspace, atau aturan proyek dimuat
ulang. Lifecycle hook yang cocok membuat pembacaan tetap dieksekusi normal.

CLI/web memperlihatkan cache hit; `/status` dan `/stats` mencatat hit serta perkiraan
karakter yang tidak perlu dikirim ulang. `exec --json` mengirim `tool.cache_hit`.
Isi bukti dan argumen tidak masuk trace/jurnal, seluruh cache hanya di memori dan
tidak memerlukan database.

## Relevance-aware Context Selection

Jika ringkasan otomatis tidak cukup dan request masih melebihi context window,
Boo tidak lagi hanya mempertahankan pesan paling baru. Runtime mengekstrak istilah
dari tujuan task aktif—terutama path, identifier, simbol, dan istilah error—lalu
meranking blok percakapan lama secara lokal. Permintaan user terakhir, blok terbaru,
dan bukti lama yang paling relevan mendapat prioritas; blok netral dibuang lebih dulu.

Seleksi tidak pernah memecah pasangan function call dan hasil tool, tidak mengubah
urutan kronologis, serta mempertahankan seluruh system prompt berurutan. Isi tool
tetap melewati prompt-injection wrapper. Bila satu blok terbaru saja terlalu besar,
isinya dipotong dengan aturan head/tail lama agar struktur protokol tetap sah.

`/context` memperkirakan berapa pesan lama relevan yang akan dipertahankan. Saat
seleksi benar-benar terjadi, CLI/web memberi notice, `/status` dan `/stats`
mengakumulasi jumlahnya, dan `exec --json` menambahkan `prioritized_messages` pada
event `context.trimmed`. Ranking hanya berlangsung di memori proses; prompt, source,
dan istilah ranking tidak ditulis ke trace atau database.

## Safe Parallel Discovery Scheduler

Jika model mengirim beberapa operasi discovery independen dalam satu response, Boo
dapat menjalankan maksimal empat tool sekaligus. Saat ini opt-in diberikan kepada
`read_file`, `grep`, `repo_map`, serta inspeksi Git read-only. Batch boleh heterogen,
misalnya membaca konfigurasi sambil mencari simbol dan memeriksa status Git. Batch
yang lebih besar dipecah menjadi kelompok berikutnya. Walaupun waktu eksekusinya
paralel, event `tool-end` dan pesan hasil selalu dimasukkan ke history sesuai urutan
tool call dari model, sehingga protokol provider dan transcript tetap deterministik.

Scheduler hanya menerima tool valid, unik, read-only, secara eksplisit menandai diri
`parallelSafe`, dan tanpa lifecycle hook yang cocok. Status `risk: safe` saja tidak
cukup, sehingga tool network, interaktif, dynamic discovery, dan tool dengan state
mutable tidak ikut tanpa audit. Argumen invalid kembali ke Argument Guard biasa;
scoped instruction baru membuat seluruh batch ditunda sampai model menerima aturan
tersebut. Cache hit, snapshot perubahan eksternal, pembatalan, dan prompt-injection
detection tetap berlaku. Tool tulis, command, aksi eksternal, dan call duplikat tidak
pernah diparalelkan melalui jalur ini.

CLI/web menampilkan jumlah serta jenis tool discovery yang sedang berjalan paralel.
`/status` dan `/stats` mencatat jumlah batch/call, sedangkan `exec --json` mengirim
event `tool.parallel_started` dan `tool.parallel_completed` beserta nama tool. Trace
hanya menyimpan jumlah dan durasi, bukan path, argumen, atau isi hasil; metrik trace
lama `parallelRead*` tetap dibaca sebagai kompatibilitas. Fitur ini tidak memakai DB.

## Bounded Tool Result Store

Hasil tool di atas 64.000 karakter tidak lagi langsung memenuhi context window.
Boo mempertahankan 40.000 karakter awal dan 16.000 karakter akhir, menyisipkan
penanda yang menjelaskan bagian terpotong, lalu menyimpan hasil lengkap sementara
di memori task. Model dapat mengambil bagian yang dibutuhkan dengan
`read_tool_output`, memakai reference opaque serta offset karakter 1-based. Satu
halaman dibatasi 60.000 karakter.

Penyimpanan dibatasi 32 hasil, 2 juta karakter per hasil, dan 4 juta karakter total.
Jika hasil melampaui batas, head/tail tetap tersedia tetapi bagian tengah tidak
disimpan. Reference kedaluwarsa saat task selesai, tidak dapat ditebak untuk membaca
file atau hasil lain, dan tidak bertahan setelah `/resume`. Isi lengkap tidak ditulis
ke trace, sesi, filesystem, atau database; hanya jumlah hasil dan karakter yang
ditahan dari context yang masuk `/status` dan `/stats`.

Prompt-injection detector memeriksa hasil asli sebelum dipadatkan. Tool paging juga
melewati guard output biasa, sehingga membaca bagian lanjutan tidak mengubah data
tidak tepercaya menjadi instruksi. `exec --json` melaporkan
`tool.result_truncated` tanpa menyertakan isi hasil.

## Membaca berkas besar

`read_file` membaca paling banyak 2.000 baris atau 60 ribu karakter sekaligus,
lalu memberi tahu model bagian mana yang sudah dibaca:

```
[Baris 1–2000 dari 5000. Lanjutkan dengan offset 2001, atau cari bagian yang dibutuhkan dengan grep.]
```

Model dapat membaca bagian tertentu dengan `offset` dan `limit`; nomor barisnya
tetap nomor asli di berkas, sehingga cocok untuk `edit_file`. Status menampilkan
rentangnya (`Reading  src/app.ts · lines 2001–2400`). Baris hasil minify yang
sangat panjang dipotong per baris, dan berkas biner ditolak alih-alih dibaca
sebagai teks rusak.

## Batas langkah

Satu permintaan bisa memakan banyak langkah: membaca, mengubah, menjalankan test,
memperbaiki. Setiap 40 langkah Boo bertanya:

```
  ● Exploring     12 files, 4 searches  38.1s
  Boo sudah 40 langkah mengerjakan permintaan ini. Lanjutkan?
 > 1. Ya, lanjutkan
   2. Tidak, berhenti di sini
```

Memilih berhenti menutup pekerjaan dengan riwayat yang sah; ketik "lanjutkan" untuk
meneruskannya nanti. Batasnya dapat diubah dengan `BOO_MAX_TURNS`.

## Batas konteks

Riwayat agent tumbuh jauh lebih cepat daripada chat biasa: satu `read_file`
menyuntikkan isi file penuh ke percakapan. Tanpa penanganan, sesi panjang akan
melewati batas konteks model dan gagal.

### Ringkasan otomatis

Saat pesan yang akan dikirim melewati 75% anggaran token (bawaan 100.000, atur
dengan `BOO_MAX_CONTEXT_TOKENS`), bagian lama percakapan **diringkas oleh model**,
bukan dibuang:

```
  ↻ konteks diringkas: 4 pesan lama menjadi ringkasan (~719 token terkirim)
  Kode proyek Anda adalah JERUK-42 dengan tenggat hari Jumat.
```

Ringkasan memuat permintaan dan instruksimu, keputusan yang diambil, berkas yang
dibaca atau diubah beserta path-nya, perintah dan hasil pentingnya, serta apa yang
belum selesai. Ringkasan itu dikirim di depan pesan yang tersisa; Boo tetap ingat
apa yang disepakati di awal sesi.

- **Dipotong di awal permintaan.** Pesan terbaru yang dipertahankan utuh dipilih
  sebanyak mungkin, sekitar 35% anggaran, dan selalu mulai dari pertanyaanmu —
  hasil tool tidak pernah terpisah dari pemanggilnya.
- **Bertingkat.** Ringkasan berikutnya menggabungkan ringkasan sebelumnya.
- **Riwayat lengkap tidak berubah.** Sesi tetap menyimpan dan menampilkan
  seluruh percakapan; yang diringkas hanya salinan yang dikirim ke model.
  Ringkasan ikut disimpan, jadi `boo-code --resume` langsung memakainya.
- **`/compact`** meringkas sekarang juga, misalnya sebelum memulai pekerjaan
  besar berikutnya di sesi yang sama. Esc membatalkannya.

### Inspector konteks

Ketik `/context` untuk melihat estimasi request model berikutnya tanpa memanggil
provider atau mengubah percakapan. Laporan memisahkan system prompt, pesan pengguna,
jawaban/reasoning, hasil dan panggilan tool, gambar, serta skema tool. Skema tool
ikut dihitung dan disisihkan dari budget runtime—daftar function calling memang
ikut dikirim pada setiap putaran, walaupun tidak terlihat sebagai pesan chat.

Laporan juga menunjukkan jumlah pesan riwayat, pesan aktif setelah compaction,
pesan yang benar-benar muat, headroom token, dan status **aman**, **perlu perhatian**,
atau **kritis**. Pada 75% Boo menyarankan `/compact`; pada 90% atau bila pesan harus
dipangkas, status menjadi kritis. Angka ini estimasi konservatif (sekitar empat
karakter per token dan biaya tetap untuk gambar), bukan tagihan token provider.

### Pemangkasan sebagai jaring pengaman

Bila ringkasan gagal dibuat, atau satu permintaan saja sudah melebihi anggaran,
salinan yang dikirim dipangkas. Saat terjadi, CLI memberi tahu:

```
konteks dipangkas: 5 pesan lama dibuang (~6000 token terkirim)
```

Pemangkasan bekerja **per blok, bukan per pesan**. Pesan assistant yang memanggil
tool beserta seluruh hasil toolnya adalah satu kesatuan yang tidak boleh dipecah:
API menolak `tool_result` yang kehilangan `tool_use` pemanggilnya, dan menolak
pula bila sebagian hasilnya hilang. Bila satu blok saja sudah melebihi anggaran —
lazim saat membaca file raksasa — isinya dipotong, bloknya tidak dibuang.

## Kesegaran file workspace

Boo mengingat sidik file yang isinya pernah ditampilkan melalui `read_file` atau
bukti pencarian seperti `grep`, `repo_map`, dan `code_search`. Sebelum setiap
putusan model, Boo memeriksa metadata file tersebut. Hanya file yang metadatanya
berubah yang dibaca ulang untuk dibandingkan hash-nya, sehingga pemeriksaan sesi
panjang tetap ringan.

Jika editor, formatter, command, Git, atau proses lain mengubah/menghapus file,
Boo menampilkan notice dan menyuntikkan pengingat sementara agar model membaca
ulang file itu sebelum mengandalkan isi lama. Notice juga mendeteksi path yang
berubah menjadi symlink keluar workspace atau tidak lagi dapat dibaca. Setelah
`read_file` memperoleh versi terbaru, pengingat hilang otomatis dan tidak masuk
riwayat percakapan.

Detector tidak memindai semua file sebagai watcher global: hanya file yang memang
pernah menjadi konteks model yang dipantau. Isi, hash, dan path absolut tidak
ditulis ke trace; state hanya hidup di memori proses, tanpa database. Pemeriksaan
hash saat penulisan tetap menjadi lapisan terakhir yang menolak overwrite bila
file berubah sesaat setelah notice diperiksa.

## Aplikasi lokal lintas-platform

Boo dapat membuka aplikasi lokal di macOS, Windows, dan Linux/Ubuntu, tetapi
**tidak menebak atau memindai program di device**. Anda mendaftarkan alias yang
diizinkan terlebih dahulu; ini mencegah model mengirim nama executable atau argumen
sewenang-wenang ke shell.

Simpan konfigurasi pribadi di `~/.boo/apps.json`, atau konfigurasi khusus proyek di
`<workspace>/.boo/apps.json`. Alias proyek dengan `id` yang sama menimpa alias
pribadi. Contoh yang tidak mengunci Boo pada aplikasi tertentu:

```json
{
  "apps": [
    {
      "id": "project-editor",
      "label": "Editor proyek",
      "command": "my-editor",
      "args": ["."]
    },
    {
      "id": "notes",
      "command": "notes-linux",
      "platforms": {
        "darwin": { "command": "open", "args": ["-a", "My Notes"] },
        "win32": { "command": "my-notes.exe" }
      }
    }
  ]
}
```

`command` dan `args` dijalankan langsung melalui proses OS, bukan sebagai teks shell.
Kunci `platforms` dapat berisi `darwin`, `win32`, atau `linux`; bila OS aktif tidak
memiliki override, nilai `command`/`args` utama digunakan. Pastikan command tersebut
memang tersedia di PATH atau gunakan path executable yang benar.

| Perintah | Fungsi |
|---|---|
| `/apps` | lihat alias aplikasi yang telah didaftarkan |
| `/open <alias>` | buka satu aplikasi terdaftar; selalu meminta persetujuan |
| `/run <perintah>` | jalankan command shell di workspace; selalu meminta persetujuan |

Agent juga mempunyai tool `list_apps` dan `open_app`: ia hanya bisa membuka alias
dari konfigurasi di atas dan tetap harus meminta izin Anda. Fitur ini **membuka atau
menjalankan aplikasi**, bukan otomatis mengendalikan semua tombol UI-nya. Kontrol UI
desktop perlu adapter API/CLI aplikasi atau izin automation OS tersendiri.

### Kontrol browser lokal lintas-platform

Boo dapat mengendalikan tab Chrome/Edge milik Anda melalui Chrome DevTools Protocol
(CDP) lokal. Fitur ini cocok untuk halaman yang sudah login, aplikasi web lokal, dan
alur interaktif yang tidak dapat diselesaikan oleh `web_search`/`web_fetch`. Gunakan
profil browser terpisah, login sendiri, lalu biarkan browser tersebut berjalan:

```bash
# macOS
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.boo/chrome-agent"

# Windows (Command Prompt)
start "" chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.boo\chrome-agent"

# Ubuntu/Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.boo/chrome-agent"
```

Edge juga dapat dipakai dengan mengganti executable menjadi Microsoft Edge,
`msedge.exe`, atau `microsoft-edge` sesuai sistem operasi. Jika memakai port selain
`9222`, simpan `~/.boo/browser.json`:

```json
{ "cdpUrl": "http://127.0.0.1:9333" }
```

Setelah itu gunakan prompt biasa, misalnya:

```text
Buka browser ke http://localhost:3000, periksa form pendaftaran, lalu jelaskan error yang terlihat.

Pada tab dashboard yang sudah login, buka laporan bulan ini dan rangkum angka yang terlihat.
```

Agent memeriksa kesiapan lewat `browser_status`, lalu meminta persetujuan baru saat
akan melihat daftar tab, membuka URL, membaca halaman, mengeklik, atau mengetik.
Snapshot hanya mengambil teks terlihat dan referensi elemen; nilai kolom input tidak
dibaca. Setiap nilai query URL dan fragment disembunyikan. Isi halaman diperlakukan
sebagai data tidak tepercaya dan tidak boleh mengubah instruksi agent.

`browser_type` menolak kolom password, upload file, hidden field, dan kode sekali
pakai; agent juga dilarang mengetik API key, token, data pembayaran, atau rahasia.
Mengetik tidak pernah otomatis mengirim form—klik tombol kirim tetap menjadi izin
terpisah. Boo tidak menyalin atau menyimpan cookie, password, maupun isi halaman ke
database. Endpoint CDP wajib berada di loopback (`localhost`/`127.0.0.1`); browser
remote ditolak.

Untuk aplikasi web dinamis, `browser_navigate` dapat memakai tab yang sama,
`browser_select` memilih opsi `<select>` berdasarkan **label terlihat yang cocok
persis**, dan `browser_press` mengirim satu tombol terbatas seperti `Enter`, `Tab`,
`Escape`, tombol panah, `Home`/`End`, `PageUp`/`PageDown`, `Backspace`, `Delete`,
atau `Space`. Model tidak memperoleh keyboard bebas maupun akses evaluasi JavaScript.
Ketiga aksi selalu meminta persetujuan baru; penekanan tombol pada password, upload
file, hidden field, dan kolom OTP juga ditolak.

Untuk mendiagnosis aplikasi web, `browser_diagnostics` memantau tab selama 250 ms
sampai 10 detik dan melaporkan console warning/error, exception JavaScript, respons
HTTP `>= 400`, serta request jaringan yang gagal. Secara bawaan halaman **tidak**
dimuat ulang; agent hanya boleh meminta reload bila reproduksi error memerlukannya,
dan pilihan itu terlihat di panel persetujuan. Diagnostik tidak membaca request atau
response body, header, cookie, maupun storage. Nilai query URL dan pola token/secret
yang umum disamarkan, hasil dibatasi 100 masalah, dan seluruh keluarannya tetap
ditandai sebagai konten eksternal tidak tepercaya.

```text
Pada tab aplikasi lokal, pantau error console dan request gagal selama 3 detik tanpa reload.

Muat ulang tab localhost lalu cari penyebab halaman gagal mengambil data API.
```

### WhatsApp Web pribadi

Boo dapat mengirim satu pesan melalui **WhatsApp Web akun pribadi** yang sudah Anda
login sendiri. Integrasi tidak memakai API WhatsApp Business dan tidak menyimpan QR,
cookie, password, daftar kontak, ataupun riwayat chat. Boo hanya menempel ke tab
Chrome/Edge yang Anda buka dalam mode debugging **lokal**.

Mulai Chrome/Edge dengan port CDP khusus, lalu login WhatsApp Web sekali pada profil
tersebut. Gunakan profil terpisah agar sesi automasi tidak bercampur dengan browser
harian Anda.

```bash
# macOS (tutup instance Chrome yang memakai profil ini sebelum menjalankan)
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.boo/chrome-whatsapp"

# Windows (Command Prompt)
start "" chrome.exe --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\\.boo\\chrome-whatsapp"

# Ubuntu/Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.boo/chrome-whatsapp"
```

Di tab tersebut buka `https://web.whatsapp.com/`, login, dan biarkan browser tetap
berjalan. Bila port yang dipakai bukan `9222`, simpan `~/.boo/whatsapp.json`:

```json
{ "cdpUrl": "http://127.0.0.1:9333" }
```

Hanya endpoint loopback (`127.0.0.1`/`localhost`) yang diterima; Boo menolak browser
remote. Kemudian gunakan prompt biasa:

```text
Cek apakah WhatsApp Web siap.

Kirim WhatsApp ke Budi Santoso: Rapat dipindahkan ke jam 15.00. Terima kasih.
```

Nama penerima harus cocok persis dengan nama kontak yang tampil di WhatsApp. Sebelum
menekan Kirim, Boo selalu menampilkan **penerima dan isi pesan lengkap** untuk
persetujuan baru. Persetujuan pesan tidak bisa dibuat permanen, pesan massal tidak
didukung, dan Boo membatalkan pengiriman bila tidak dapat memastikan chat aktif sesuai
penerima.

## Tool dan izin

| Tool | Risiko | Perilaku |
|---|---|---|
| `read_file` | aman | langsung jalan |
| `list_dir` | aman | langsung jalan |
| `glob` | aman | langsung jalan |
| `grep` | aman | langsung jalan |
| `code_search` | aman | mencari konsep lewat indeks repository lokal |
| `code_graph` | aman | membaca graf simbol AST dari indeks lokal |
| `test_impact` | aman | menganalisis test terdampak dan command dari manifest/config proyek |
| `repo_map` | aman | memetakan deklarasi tanpa mengirim isi file penuh |
| `web_search` | aman | mencari web publik dan mengembalikan URL sumber |
| `web_fetch` | aman | membaca satu halaman HTTPS publik dengan proteksi SSRF |
| `browser_status` | aman | memeriksa koneksi browser lokal tanpa membaca metadata tab |
| `browser_tabs` | konfirmasi setiap kali | melihat judul, ID, dan URL tab dengan nilai query disembunyikan |
| `browser_open` | konfirmasi setiap kali | membuka satu URL HTTP(S) eksplisit di tab baru |
| `browser_navigate` | konfirmasi setiap kali | menavigasikan tab yang ada ke satu URL HTTP(S) eksplisit |
| `browser_snapshot` | konfirmasi setiap kali | membaca teks terlihat dan referensi elemen pada satu tab |
| `browser_diagnostics` | konfirmasi setiap kali | menangkap error console/JavaScript/HTTP tanpa header, cookie, atau body |
| `browser_click` | konfirmasi setiap kali | mengeklik satu referensi elemen dari snapshot terbaru |
| `browser_type` | konfirmasi setiap kali | mengetik teks non-rahasia tanpa mengirim form otomatis |
| `browser_select` | konfirmasi setiap kali | memilih label dropdown yang cocok persis tanpa mengirim form |
| `browser_press` | konfirmasi setiap kali | mengirim satu tombol navigasi/aksi terbatas ke elemen |
| `git_status`, `git_diff` | aman | membaca status/diff repository |
| `git_log`, `git_show`, `git_blame` | aman | membaca sejarah Git terbatas tanpa email, shell bebas, atau file credential |
| `git_commit` | konfirmasi setiap kali | membuat commit lokal hanya dari path eksplisit |
| `lsp` | konfirmasi | menjalankan language server lokal dalam sandbox |
| `ask_user` | aman | meminta keputusan terstruktur; tidak mengubah sistem |
| `memory_list` | aman | melihat catatan proyek persisten |
| `memory_add`, `memory_remove` | konfirmasi setiap kali | mengubah satu catatan memori setelah isinya ditinjau |
| `list_apps` | aman | melihat alias aplikasi lokal yang terdaftar |
| `open_app` | konfirmasi | membuka satu alias aplikasi yang terdaftar |
| `whatsapp_status` | aman | memeriksa kesiapan tab WhatsApp Web tanpa membaca chat atau credential |
| `whatsapp_send_message` | konfirmasi setiap kali | mengirim satu pesan WhatsApp Web setelah penerima dan isi pesan ditinjau |
| `write_file` | konfirmasi | minta izin tiap kali |
| `apply_patch` | konfirmasi | menerapkan patch multi-file setelah seluruh hunk valid |
| `diagnostics` | konfirmasi | menjalankan static checks yang dideteksi dari proyek |
| `edit_file` | konfirmasi | minta izin tiap kali |
| `bash` | konfirmasi | minta izin tiap kali |
| `bash_output` | aman | membaca keluaran proses latar belakang milik Boo |
| `bash_input` | konfirmasi setiap kali | mengirim teks ke stdin proses interaktif milik Boo |
| `bash_kill` | aman | menghentikan proses latar belakang milik Boo |
| `todo_write` | aman | menulis dan memperbarui daftar tugas |

Setiap tindakan yang mengubah sesuatu ditanyakan lewat panel yang menyebut
tindakannya dengan bahasa manusia dan menampilkan isinya:

```
  ╭─ Ubah berkas ──────────────────────────────────────────╮
  │ catatan.md                                       +1 -1 │
  │                                                        │
  │ 3   1. Jeruk nipis adalah buah tropis.                 │
  │ 4 - 2. Rasanya sangat asam.                            │   <- latar merah
  │ 4 + 2. Jeruk nipis kaya vitamin C.                     │   <- latar hijau
  │ 5   3. Kaya vitamin C.                                 │
  │     ⋮ 2 baris tidak berubah                            │
  ╰────────────────────────────────────────────────────────╯

  Terapkan perubahan ke catatan.md?
 > 1. Ya
   2. Ya, izinkan semua perubahan berkas di sesi ini
   3. Tidak, beri tahu Boo apa yang harus dilakukan
```

| Tool | Judul panel | Isi panel |
|---|---|---|
| `write_file` (berkas baru) | Buat berkas | seluruh isi, bernomor baris |
| `write_file` (berkas ada) | Tulis ulang berkas | diff terhadap isi lama |
| `edit_file` | Ubah berkas | diff dengan nomor baris sesungguhnya di berkas |
| `bash` | Jalankan perintah | perintah selengkapnya |

Diff `edit_file` dihitung atas seluruh berkas, bukan hanya cuplikan yang diganti,
sehingga nomor barisnya sesuai posisi di berkas dan baris di sekitarnya ikut tampil.
Kode disorot sesuai ekstensi berkasnya, dan baris yang berubah diberi latar selebar
panel. **Perintah shell tidak pernah dipotong** — bagian yang tersembunyi bisa saja
bagian yang berbahaya — jadi perintah panjang dibungkus utuh.

Pilih dengan panah atau angka `1`–`3`; `esc` menolak.

- **Ya** — jalankan sekali ini.
- **Ya, untuk sisa sesi** — perubahan berkas disetujui sebagai satu kelompok, tetapi
  perintah shell hanya **per perintah persis**: menyetujui `ls` meloloskan `ls`
  berikutnya tanpa bertanya, sementara `pwd` tetap ditanyakan. Aplikasi lokal hanya
  disetujui untuk **alias yang sama**. Izin ini hanya berlaku selama proses berjalan
  dan tidak ikut tersimpan di sesi.
- **Tidak, beri tahu Boo** — menolak sambil mengetik arahan. Arahan itu diteruskan
  ke model sebagai hasil tool, sehingga penolakan menjadi petunjuk langkah berikutnya,
  bukan jalan buntu.

Setelah memilih, panel dihapus dan hanya satu baris keputusan yang tersisa:

```
  ✓ Buat berkas catatan.md · diizinkan
  ✗ Ubah berkas catatan.md · ditolak: tulis dengan huruf kapital semua
  ✓ Jalankan perintah · ls · diizinkan otomatis di sesi ini
```

Catatan untuk perintah memuat perintahnya sendiri, bukan deskripsi yang ditulis
model tentang perintah itu. Core meminta izin lewat callback `askPermission`, sehingga
web nanti dapat memakai mekanisme persetujuan sendiri tanpa mengubah core.

## Mode spec: rancang dulu, baru kerjakan

Untuk fitur yang lebih dari perubahan kecil, `/spec` memecah pekerjaan menjadi
tiga dokumen yang kamu tinjau satu per satu sebelum ada kode yang ditulis —
seperti Kiro:

```
› /spec login dengan Google untuk halaman admin
```

| Tahap | Berkas | Isinya |
|---|---|---|
| 1. Requirements | `.boo/specs/<nama>/requirements.md` | user story dan acceptance criteria (`WHEN … THEN sistem SHALL …`), termasuk kasus tepi |
| 2. Design | `.boo/specs/<nama>/design.md` | pendekatan, arsitektur, berkas yang tersentuh, model data, error, strategi test — merujuk nomor requirement |
| 3. Tasks | `.boo/specs/<nama>/tasks.md` | checklist implementasi kecil dan bertahap, test bersama kodenya |

Setiap tahap selesai, Boo bertanya:

```
  .boo/specs/login-dengan-google/requirements.md siap ditinjau. Langkah berikutnya?
 > Setujui dan lanjut ke design
   Revisi requirements.md
   Berhenti dulu (lanjutkan nanti dengan /spec)
```

Buka berkasnya, baca, lalu pilih. **Revisi** meminta arahanmu dan memperbarui
dokumen itu saja. Kamu juga bebas mengedit berkasnya sendiri sebelum menyetujui.

Setelah tasks siap:

```
  .boo/specs/login-dengan-google/tasks.md · 2/6 selesai · berikutnya 3. Tambah callback OAuth
 > Kerjakan tugas berikutnya
   Kerjakan semua tugas yang tersisa
   Revisi tasks.md
   Berhenti dulu (lanjutkan nanti dengan /spec)
```

Setiap tugas dikerjakan dalam satu permintaan: Boo membaca ketiga dokumen,
mengerjakan **hanya** tugas itu, memverifikasinya dengan test atau typecheck, lalu
mencentang `[x]` di `tasks.md`. Dengan "Kerjakan semua", tugas berikutnya langsung
dimulai — tetapi hanya bila tugas sebelumnya benar-benar dicentang. Esc menghentikan
alurnya kapan saja.

Semua keadaan ada di berkas, bukan di sesi: spec bisa di-commit bersama kodenya,
diedit tangan, dan dilanjutkan kapan pun dengan `/spec`, yang menampilkan semua spec
beserta tahapnya:

```
  Spec di proyek ini
 > login-dengan-google  tugas 2/6 selesai
   export-csv           requirements siap · berikutnya design
```

Penulisan dokumen tetap lewat `write_file` dan `edit_file`, dengan panel izin yang
sama seperti perubahan lainnya.

## Daftar tugas

Untuk pekerjaan beberapa langkah, Boo menulis rencananya lebih dulu dan
memperbaruinya setiap kali satu langkah selesai:

```
  ● Plan          1/4 done
    ✓ Baca math.js untuk memahami struktur yang ada
    ◼ Tambahkan fungsi kurang ke math.js
    □ Buat math.test.js untuk semua fungsi
    □ Jalankan node --test dan verifikasi hasilnya
  ● Applying      math.js  4.1s
```

Tugas yang sedang dikerjakan juga tampil di baris status selagi Boo berpikir,
jadi arahnya terlihat walau belum ada tool yang berjalan. Hanya satu tugas yang
boleh berjalan sekaligus; daftar yang melanggar ditolak dan model memperbaikinya.

Daftar dibaca ulang dari riwayat, sehingga tampil sama saat sesi dilanjutkan.
Permintaan satu langkah tidak memakai daftar tugas.

## Membatalkan dan memulihkan perubahan: /undo dan /restore

Setiap permintaan adalah satu titik pemulihan. `/undo` mengembalikan semua berkas
yang diubah Boo pada permintaan terakhir yang mengubah berkas — ke isi sebelum
permintaan itu, bukan hanya sebelum edit terakhirnya:

```
› /undo

  ╭─ Batalkan perubahan ─────────────────────────────────────╮
  │ Ubah catatan.md: ganti kata asam menjadi segar, lalu…    │
  │                                                          │
  │ ↺ kembalikan  catatan.md     +1 -1                       │
  │ ✗ hapus       docs/resep.md  +0 -1                       │
  ╰──────────────────────────────────────────────────────────╯
  ↺ 1 berkas dikembalikan, 1 berkas baru dihapus. Boo diberi tahu di permintaan berikutnya.
```

- Berkas yang dibuat Boo dihapus, beserta folder yang ikut dibuat untuknya bila
  sudah kosong.
- `/undo` berikutnya mundur satu permintaan lagi. Permintaan yang hanya membaca
  dilewati.
- Boo diberi tahu di awal permintaan berikutnya berkas mana yang kembali, agar ia
  membaca ulang alih-alih mengira perubahannya masih ada. Catatan itu tidak tampil
  sebagai bagian pertanyaanmu.

Untuk mundur lebih jauh, gunakan `/restore`. Tanpa argumen, Boo menampilkan sampai
20 checkpoint file terbaru; `/restore 7` langsung memilih checkpoint #7. Restore
mengembalikan workspace ke keadaan **sebelum** permintaan tersebut, sehingga
checkpoint terpilih dan seluruh checkpoint sesudahnya dilepas. Sebelum konfirmasi,
panel menggabungkan dampak akhirnya per file—termasuk file yang akan dihapus dan
perubahan pengguna yang berisiko hilang.

Restore memeriksa fingerprint file lagi setelah konfirmasi. Jika editor atau proses
lain mengubah workspace saat panel terbuka, operasi ditolak dan harus ditinjau
ulang. Semua path dan symlink dipreflight sebelum file pertama disentuh; bila satu
penulisan gagal, perubahan parsial di-roll back ke keadaan saat konfirmasi. Riwayat
percakapan tidak diputar balik, tetapi Boo diberi catatan restore pada prompt
berikutnya agar membaca ulang file terkait.

Batasnya:

- **Perintah bash tidak ikut dibatalkan.** `npm install`, `git checkout`, atau skrip
  yang mengubah berkas tidak terlihat oleh Boo. Panel memberi peringatan bila
  permintaan itu menjalankan perintah.
- **Perubahanmu sendiri ikut hilang.** Berkas yang kamu ubah setelah Boo
  mengubahnya ditandai `! diubah lagi setelah Boo mengubahnya` sebelum kamu
  mengonfirmasi.
- **Tahan restart untuk 20 checkpoint terakhir per sesi.** Snapshot disimpan di
  `~/.boo/checkpoints/<hash-workspace>/<session-id>/` sebelum file disentuh,
  ditulis atomik, dan hanya dapat dibaca pemilik (`600`, folder `700`). Berbeda
  dari jurnal run, snapshot memang memuat isi file sebelum edit agar dapat
  dipulihkan. Satu checkpoint dibatasi 64 MB dan dihapus setelah berhasil di-undo
  atau tercakup oleh restore.
  Untuk riwayat jangka panjang dan kolaborasi, tetap gunakan git.

## Menjalankan perintah

**Shell.** Boo memakai shell kamu (`$SHELL`) bila sintaksnya kompatibel — bash,
zsh, sh, dash, ksh. Selain itu bash, lalu sh. Jadi perintah yang sama berjalan di
macOS dengan zsh maupun di VPS Linux yang hanya punya bash atau sh. Pengguna fish
tetap aman: perintah dijalankan dengan bash.

**Keluaran tampil langsung.** Selama perintah berjalan, baris terakhir
keluarannya tampil di baris status:

```
  ⠹ Running       ✓ tests/math.test.js (12 tests)  4s  · esc untuk berhenti
```

**Keluaran panjang tidak menggagalkan perintah.** `pnpm install` yang cerewet
tetap dilaporkan berhasil. Yang dikirim ke model hanya 8 ribu karakter pertama dan
22 ribu karakter terakhir — tempat perintah dimulai dan tempat error biasanya
muncul — dengan catatan berapa yang dilewati. Warna dan bilah progres dibuang.

**Batas waktu.** Bawaan 120 detik. Model dapat menaikkannya per perintah sampai
600 detik untuk build atau test yang memang lama. Saat habis, keluaran sejauh ini
tetap dilaporkan.

**Tidak menggantung menunggu jawaban.** Masukan standar ditutup secara bawaan,
jadi perintah yang bertanya (`npm init`) langsung selesai, bukan menunggu sampai
batas waktu. Model diarahkan memakai flag seperti `--yes`. Bila proses memang
harus menerima jawaban bertahap, Boo harus menjalankannya di latar belakang dengan
opsi `interactive`; input tidak pernah dibuka diam-diam.

**Proses anak ikut berhenti.** `pnpm test` menjalankan node, yang menjalankan
proses lain. Perintah berjalan dalam process group sendiri, jadi saat dihentikan —
Esc, batas waktu, atau `bash_kill` — seluruh turunannya ikut berhenti, tidak
tertinggal memakan port.

### Latar belakang: dev server dan watcher

Perintah yang tidak pernah selesai sendiri, seperti `pnpm dev`, dijalankan di
latar belakang. Panel izin menyebutnya "Jalankan perintah di latar belakang".
Boo langsung mendapat id (`bg1`) dan bisa lanjut bekerja:

```
› jalankan dev server, lalu cek apakah halamannya error
  ✓ Jalankan perintah di latar belakang · pnpm dev · diizinkan
  ● Applying      1 command  2.8s
  ● Applying      1 output check  1.7s
```

`bash_output` membaca keluaran baru sejak pemeriksaan terakhir beserta statusnya
(masih berjalan, selesai dengan exit code, atau dihentikan). `bash_kill`
menghentikannya. Keduanya tidak meminta izin karena hanya menyentuh proses yang
dimulai Boo sendiri, yang sudah kamu izinkan saat dimulai.

Untuk CLI yang benar-benar meminta input, `bash` dapat memakai
`run_in_background: true` bersama `interactive: true`. Tool `bash_input` kemudian
mengirim teks ke stdin, dapat menambahkan Enter, atau menutup stdin untuk program
yang menunggu EOF. Teks persisnya selalu ditampilkan dan meminta persetujuan baru;
karakter kontrol ditolak dan satu kiriman dibatasi 4.096 karakter. Setelah itu Boo
membaca respons dengan `bash_output`. Kanal ini berupa pipe lintas platform, bukan
emulator terminal/TTY, sehingga UI terminal layar penuh tetap tidak didukung.

Esc tidak menghentikan proses latar belakang — ia memang dimaksudkan tetap hidup.
Semua proses latar belakang dihentikan saat Boo keluar.

## Prompt-Injection Defense

Isi workspace, hasil pencarian web, halaman browser, respons MCP, output command,
memori, dan laporan sub-agent diperlakukan sebagai data tidak tepercaya. Sebelum
dikirim ke model, salinan hasil tool tersebut dibungkus dengan marker
`[BOO UNTRUSTED TOOL DATA]` beserta sumber dan batas yang tegas. Riwayat lokal dan
transcript tetap menyimpan hasil asli. Kontrol arah Unicode yang dapat menyamarkan
urutan teks dibuat terlihat pada salinan outbound.

Detektor lokal mencari pola berkeyakinan tinggi seperti perintah mengabaikan aturan,
penyamaran role system/developer, permintaan membocorkan credential, aksi eksternal,
penyembunyian dari pengguna, dan kontrol teks tak terlihat. Pemeriksaan yang sama
berlaku pada isi `@file` sebelum model pertama dipanggil. Temuan tidak menghapus
source atau dokumentasi: Boo tetap dapat menganalisisnya sebagai bukti, tetapi
menambahkan `[BOO PROMPT-INJECTION GUARD]` dan menampilkan peringatan di CLI/web.

Setelah guard aktif, izin sesi maupun aturan `allow` tidak dapat meloloskan aksi
berisiko secara otomatis. Setiap file write, command, hook, browser action, MCP call,
atau efek lain harus mendapat persetujuan baru. Mode headless menolaknya karena tidak
dapat meminta konfirmasi interaktif. Ringkasan konteks juga diperintah untuk tidak
mengubah directive dari hasil tool menjadi instruksi sesi. Saat sesi dilanjutkan,
guard dipulihkan selama hasil berbahaya tersebut masih berada dalam konteks aktif.

Deteksi ini adalah pertahanan berlapis, bukan bukti bahwa teks aman atau berbahaya:
heuristik dapat melewatkan serangan baru atau memberi peringatan pada contoh keamanan
yang sah. Sandbox, Secret Guard, batas workspace, dan panel approval tetap berlaku.
Fitur berjalan lokal tanpa database dan tidak menyimpan isi temuan ke jurnal runtime.

## File rahasia

Apa pun yang dibaca tool akan dikirim ke provider model, dan sekali terkirim
tidak bisa ditarik kembali. Karena itu `read_file` dan `edit_file` **menolak**
berkas kredensial di lapisan tool, bukan menyerahkannya pada kebijaksanaan model:

`.env` dan turunannya · `*.pem` · `*.key` · `*.pfx` · `*.p12` · `*.keystore` ·
`*.jks` · `id_rsa` dan sejenisnya · `.npmrc` · `.netrc` · `.pypirc` ·
`.git-credentials` · `service-account*.json` · `secrets.*`

Berkas contoh (`.env.example`, `.env.sample`, `.env.template`, `*.dist`) tetap
boleh dibaca karena berguna sebagai rujukan struktur. `list_dir` tetap menampilkan
berkas rahasia dengan penanda, supaya model tahu ia ada tanpa mencoba membacanya.

Penolakan path ini **bukan jaminan mutlak**: `bash` masih dapat membaca file lewat
perintah yang disetujui. Perintah selalu ditampilkan utuh agar dapat ditolak, dan
Secret Guard di bawah menjadi pertahanan terakhir sebelum hasilnya menuju provider.

Seluruh path melewati `resolveInWorkspace`, yang menolak `..` maupun path absolut di
luar workspace. Itu satu-satunya penghalang antara agent dan sisa filesystem.

### Outbound Secret Guard

Sebagai pertahanan terakhir, setiap request percakapan disalin dan disanitasi tepat
sebelum dikirim ke provider. Guard berlaku untuk system prompt, prompt pengguna,
aturan proyek, ringkasan konteks, reasoning lama, argumen tool, serta hasil shell,
MCP, lifecycle hook, browser, dan tool lain. Riwayat lokal tidak dimutasi; hanya
salinan outbound yang berubah.

Guard menyamarkan nilai API key provider dan environment sensitif yang diketahui,
termasuk varian URL-encoded dan base64. Ia juga mengenali private key PEM, AWS/GitHub/
Slack/Stripe/Google token, JWT, header Authorization/Cookie, URL dengan credential,
assignment environment sensitif, properti credential JSON, dan argumen seperti
`--token`. Model menerima marker `[RAHASIA DISEMBUNYIKAN OLEH BOO]` dan diperintah
untuk tidak menebak atau mencoba memperoleh kembali nilainya.

Redaksi ini bersifat defensif, bukan alasan untuk sengaja membaca rahasia. Pola baru
atau credential yang tidak menyerupai secret mungkin tidak dikenali. Pixel di dalam
attachment gambar juga tidak dapat dipindai sebagai teks; periksa screenshot sebelum
melampirkannya. Persetujuan tool, penolakan file sensitif, environment shell yang
dibersihkan, dan sandbox tetap menjadi lapisan perlindungan utama. Fitur ini berjalan
di memori dan tidak memerlukan database atau layanan DLP eksternal.

## Model

Default `auto`, dapat diganti lewat `BOO_MODEL` di `.env.local`. Mode Auto menilai
jenis dan kesulitan permintaan, lalu memilih model serta effort yang sesuai dari
model yang benar-benar tersedia di 9Router. Jika kandidat tidak tersedia atau
provider mengembalikan error model-not-found, Boo mencoba kandidat berikutnya.
Gunakan `/model` untuk memilih Auto atau mengunci model tertentu.

Model wajib mendukung function calling secara utuh. Verifikasi dengan
`pnpm check:tools` di repo `boo-ai-chat-web` sebelum memakainya di sini —
dukungan tool calling berbeda per provider.

Tiga perilaku 9Router yang sudah ditangani core dan jangan diubah tanpa pengujian ulang:

- `stream` selalu dikirim eksplisit; provider `ag/*` default-nya streaming.
- `reasoning_content` dipisahkan dari `content` supaya balasan model thinking tidak
  dikira kosong.
- Potongan `tool_calls` pada SSE disambung berdasarkan `index` karena `arguments`
  datang terpecah antar chunk.

## Validasi

```bash
pnpm lint
pnpm typecheck
pnpm test
```
