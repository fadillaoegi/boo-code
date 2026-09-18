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
  Model bawaan [ag/gemini-3.1-pro]:

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

### Konfigurasi

Dibaca berlapis; yang belakangan menimpa yang sebelumnya:

| Sumber | Untuk |
|---|---|
| `~/.boo/.env` | setelan tetap milik pengguna |
| `<direktori kerja>/.env` | setelan proyek |
| `<direktori kerja>/.env.local` | setelan proyek yang tidak di-commit |
| environment variable | selalu menang |

Hanya kunci milik Boo yang diambil (`NINEROUTER_URL`, `NINEROUTER_KEY`,
`BOO_MODEL`, `BOO_EFFORT`, `BOO_MAX_CONTEXT_TOKENS`, `BOO_MAX_TURNS`). Berkas `.env` proyek lazim memuat rahasia
aplikasi lain, dan tidak ada alasan memuatnya ke dalam proses ini.

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

### Perintah di dalam sesi

| Perintah | Fungsi |
|---|---|
| `/model` | pilih model dengan tombol panah |
| `/model <id> [tingkat]` | ganti langsung, misal `/model cx/gpt-5.6-sol xhigh` |
| `/resume` | pilih dan lanjutkan sesi lain di direktori ini |
| `/init` | minta Boo menulis `BOO.md` berisi aturan proyek ini |
| `/undo` | batalkan perubahan berkas dari permintaan terakhir |
| `/compact` | ringkas percakapan sejauh ini agar konteks lega |
| `/spec <ide>` | rancang fitur dulu: requirements, design, tasks, lalu kerjakan |
| `/spec` | lihat spec di proyek ini dan lanjutkan tahapnya |
| `/queue` | lihat permintaan yang mengantre |
| `/queue hapus` | kosongkan antrean |
| `/help` | daftar perintah |
| `/keluar` | akhiri sesi |

### Antrean permintaan

Mengetik selagi Boo bekerja tidak memotong pekerjaannya. Permintaan masuk antrean
dan dijalankan berurutan setelah yang sekarang selesai:

```
boo > apa isi a.txt?
  antre #1  lalu perbaiki bug di parser
  antre #2  jalankan test
  * Exploring     1 file  1.4s
  ...
boo > lalu perbaiki bug di parser  (1 lagi mengantre)
```

Antrean ini terpisah dari masukan permintaan izin. Bila keduanya berbagi satu
tumpukan, permintaan yang baru diketik akan termakan sebagai jawaban `y/N` atas
izin yang sedang menunggu. Penanya yang sedang aktif selalu dilayani lebih dulu;
ketikan saat sibuk hanya menjadi tugas berikutnya.

`/queue` tetap dijalankan seketika walau Boo sedang bekerja — justru pada saat
itulah ia dibutuhkan. Spinner juga berhenti begitu kamu mulai mengetik, supaya
animasinya tidak menimpa huruf yang sedang diketik.

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

Urutan prioritas: flag `--model`, lalu `BOO_MODEL` di `.env.local`, lalu bawaan
`ag/gemini-3.1-pro`.

## Struktur

```text
packages/
├── core/          # otak — tidak tahu apa pun soal terminal atau browser
│   ├── domain/    # tipe pesan dan kontrak Tool
│   ├── provider/  # adapter 9Router (streaming + tool calling)
│   ├── tools/     # read_file, list_dir, glob, grep, write_file, edit_file, bash, bash_output, bash_kill
│   ├── agent/     # loop dan system prompt
│   └── design/    # token visual, sama persis dengan yang dipakai web
└── cli/           # binary `boo` — hanya menggambar dan meminta izin
```

Dependency mengarah satu arah: CLI bergantung pada core, core tidak bergantung pada
siapa pun. Web nanti menjadi konsumen kedua dari core yang sama, bukan salinannya.

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

`/resume` membuka pemilih yang sama dengan `boo-code --resume`, dengan sesi yang sedang
berjalan ditandai *(aktif)*. Sesi yang ditinggalkan sudah tersimpan pesan demi pesan,
jadi tidak ada yang hilang. Riwayat percakapan, model dan tingkat penalaran, serta
riwayat panah atas ikut berpindah; izin *untuk sisa sesi* dikosongkan karena diberikan
dalam konteks percakapan sebelumnya.

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

## Pencarian kode

Agent menemukan kode dengan mencari lebih dulu, bukan menelusuri folder satu per satu
lalu membaca berkas utuh — cara itu lambat dan cepat menghabiskan anggaran konteks.

| Tool | Fungsi |
|---|---|
| `glob` | mencari berkas berdasarkan pola nama, misalnya `src/**/*.ts`; terakhir diubah lebih dulu |
| `grep` | mencari isi berkas dengan regex; hasil berupa `path:baris: isi` |

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

## Tool dan izin

| Tool | Risiko | Perilaku |
|---|---|---|
| `read_file` | aman | langsung jalan |
| `list_dir` | aman | langsung jalan |
| `glob` | aman | langsung jalan |
| `grep` | aman | langsung jalan |
| `write_file` | konfirmasi | minta izin tiap kali |
| `edit_file` | konfirmasi | minta izin tiap kali |
| `bash` | konfirmasi | minta izin tiap kali |
| `bash_output` | aman | membaca keluaran proses latar belakang milik Boo |
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
  berikutnya tanpa bertanya, sementara `pwd` tetap ditanyakan. Izin ini hanya berlaku
  selama proses berjalan dan tidak ikut tersimpan di sesi.
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

## Membatalkan perubahan: /undo

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

Batasnya:

- **Perintah bash tidak ikut dibatalkan.** `npm install`, `git checkout`, atau skrip
  yang mengubah berkas tidak terlihat oleh Boo. Panel memberi peringatan bila
  permintaan itu menjalankan perintah.
- **Perubahanmu sendiri ikut hilang.** Berkas yang kamu ubah setelah Boo
  mengubahnya ditandai `! diubah lagi setelah Boo mengubahnya` sebelum kamu
  mengonfirmasi.
- **Hanya selama sesi berjalan.** Titik pemulihan disimpan di memori; setelah Boo
  ditutup dan sesi dilanjutkan, perubahan lama tidak bisa di-undo. Untuk riwayat
  jangka panjang, tetap gunakan git.

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

**Tidak menggantung menunggu jawaban.** Masukan standar ditutup, jadi perintah
yang bertanya (`npm init`) langsung selesai, bukan menunggu sampai batas waktu.
Model diarahkan memakai flag seperti `--yes`.

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

Esc tidak menghentikan proses latar belakang — ia memang dimaksudkan tetap hidup.
Semua proses latar belakang dihentikan saat Boo keluar.

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

Penolakan ini **bukan jaminan mutlak**: `bash` masih dapat membaca file apa pun
lewat `cat .env`. Itu disengaja — perintah shell selalu ditampilkan utuh saat
meminta izin, sehingga kamu dapat melihat dan menolaknya sendiri.

Seluruh path melewati `resolveInWorkspace`, yang menolak `..` maupun path absolut di
luar workspace. Itu satu-satunya penghalang antara agent dan sisa filesystem.

## Model

Default `ag/gemini-3.1-pro`, dapat diganti lewat `BOO_MODEL` di `.env.local`.

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
