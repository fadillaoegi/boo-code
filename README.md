# Boo Code

Coding agent buatan FLdev. Satu otak (`@boo/core`), dua antarmuka: CLI `boo` hari ini,
web menyusul. Nama produknya Boo Code; CLI dan web hanyalah dua cara menjalankannya. Model diakses lewat [9Router](http://localhost:20128) sebagai satu pintu.

## Memasang secara global

```bash
pnpm install
cd packages/cli && npm link      # binary `boo` dan `boo-code` tersedia global
```

Lalu buat setelan tetap sekali saja:

```bash
mkdir -p ~/.boo
cat > ~/.boo/.env <<'ENV'
NINEROUTER_URL=http://localhost:20128
NINEROUTER_KEY=sk-...
BOO_MODEL=ag/claude-sonnet-4-6
ENV
chmod 600 ~/.boo/.env
```

Setelah itu `boo` dapat dipanggil dari direktori mana pun:

```bash
cd ~/proyek/apa-saja
boo                    # atau boo-code
```

Melepasnya: `npm unlink -g boo-code`.

> `npm link` dipakai karena direktori bin globalnya biasanya sudah ada di PATH.
> `pnpm link --global` juga bisa, tetapi memerlukan `pnpm setup` lebih dulu yang
> mengubah berkas konfigurasi shell.
>
> Paket ini belum siap `npm publish`: `@boo/core` masih berupa dependency
> workspace, sehingga pemasangan dari registry memerlukan langkah build yang
> menyatukannya lebih dulu.

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
`BOO_MODEL`, `BOO_EFFORT`, `BOO_MAX_CONTEXT_TOKENS`). Berkas `.env` proyek lazim memuat rahasia
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

### Perintah di dalam sesi

| Perintah | Fungsi |
|---|---|
| `/model` | pilih model dengan tombol panah |
| `/model <id> [tingkat]` | ganti langsung, misal `/model cx/gpt-5.6-sol xhigh` |
| `/resume` | pilih dan lanjutkan sesi lain di direktori ini |
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
`ag/claude-sonnet-4-6`.

## Struktur

```text
packages/
├── core/          # otak — tidak tahu apa pun soal terminal atau browser
│   ├── domain/    # tipe pesan dan kontrak Tool
│   ├── provider/  # adapter 9Router (streaming + tool calling)
│   ├── tools/     # read_file, list_dir, write_file, edit_file, bash
│   ├── agent/     # loop dan system prompt
│   └── design/    # token visual, sama persis dengan yang dipakai web
└── cli/           # binary `boo` — hanya menggambar dan meminta izin
```

Dependency mengarah satu arah: CLI bergantung pada core, core tidak bergantung pada
siapa pun. Web nanti menjadi konsumen kedua dari core yang sama, bukan salinannya.

## Sesi

Setiap percakapan disimpan, sehingga dapat dilanjutkan setelah `boo` ditutup —
seperti `claude --resume`. Saat keluar, perintahnya ditampilkan:

```
  Lanjutkan sesi ini: boo --resume 5bd73640
```

| Perintah | Fungsi |
|---|---|
| `boo --resume 5bd73640` | lanjutkan sesi tertentu; id lengkap atau awalannya |
| `boo --resume` | pilih dari daftar sesi di direktori ini, terbaru lebih dulu |
| `boo --continue` | langsung lanjutkan sesi yang terakhir diperbarui |
| `/resume` | di dalam sesi: pindah ke sesi lain tanpa keluar dari `boo` |

`/resume` membuka pemilih yang sama dengan `boo --resume`, dengan sesi yang sedang
berjalan ditandai *(aktif)*. Sesi yang ditinggalkan sudah tersimpan pesan demi pesan,
jadi tidak ada yang hilang. Riwayat percakapan, model dan tingkat penalaran, serta
riwayat panah atas ikut berpindah; izin *untuk sisa sesi* dikosongkan karena diberikan
dalam konteks percakapan sebelumnya.

Sesi yang dilanjutkan memulihkan riwayat percakapan, model dan tingkat penalaran
terakhirnya, serta riwayat ketikan untuk panah atas. Beberapa tukar-jawab terakhir
ditampilkan sebagai pengingat: pertanyaan persis seperti diketik, jawaban sebagai
teks polos tanpa markdown mentah. Bendera `--model` dan `--effort`
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

### Ctrl-C

Ctrl-C pertama menutup sesi dengan tertib; bila Boo masih bekerja, pekerjaan itu
diselesaikan dulu. Ctrl-C kedua keluar seketika. Keduanya aman, karena setiap pesan
sudah tersimpan begitu masuk ke riwayat.

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

## Batas konteks

Riwayat agent tumbuh jauh lebih cepat daripada chat biasa: satu `read_file`
menyuntikkan isi file penuh ke percakapan. Tanpa penanganan, sesi panjang akan
melewati batas konteks model dan gagal.

Sebelum tiap permintaan, riwayat dipangkas ke anggaran token (bawaan 100.000,
dapat diatur lewat `maxContextTokens`). Riwayat penuh tetap tersimpan di memori —
yang dipangkas hanya salinan yang dikirim. Saat terjadi, CLI memberi tahu:

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
| `write_file` | konfirmasi | minta izin tiap kali |
| `edit_file` | konfirmasi | minta izin tiap kali |
| `bash` | konfirmasi | minta izin tiap kali |

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

Default `ag/claude-sonnet-4-6`, dapat diganti lewat `BOO_MODEL` di `.env.local`.

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
