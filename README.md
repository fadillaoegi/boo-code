# Boo Code

Coding agent buatan FLdev. Satu otak (`@boo/core`), dua antarmuka: CLI `boo` hari ini,
web menyusul. Nama produknya Boo Code; CLI dan web hanyalah dua cara menjalankannya. Model diakses lewat [9Router](http://localhost:20128) sebagai satu pintu.

## Menjalankan

```bash
pnpm install
cp .env.example .env.local   # isi NINEROUTER_KEY
pnpm boo                     # jalankan di direktori yang ingin dikerjakan
```

`boo` memperlakukan direktori kerja saat ini sebagai workspace dan tidak dapat
menyentuh apa pun di luarnya.

### Perintah di dalam sesi

| Perintah | Fungsi |
|---|---|
| `/model` | pilih model dengan tombol panah |
| `/model <id>` | ganti langsung, misal `/model cx/gpt-5.5` |
| `/help` | daftar perintah |
| `/keluar` | akhiri sesi |

Pada `/model`, gunakan **panah atas/bawah** (atau `j`/`k`) untuk menelusuri,
**enter** untuk memakai, **esc** untuk membatalkan. Daftar yang lebih panjang
dari layar bergulir sendiri mengikuti kursor. Terminal yang tidak mendukung raw
mode otomatis mendapat jalur cadangan berupa daftar bernomor yang diketik.

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

Izin ditanyakan dengan menampilkan tindakan utuhnya — perintah shell yang sebenarnya,
bukan sekadar nama tool. Untuk `write_file` dan `edit_file`, diff perubahan
ditampilkan lebih dulu:

```
    export function bagi(a, b) {
  +   if (b === 0) {
  +     throw new Error("Pembagi tidak boleh nol")
  +   }
      return a / b
    }
    3 baris ditambah, 0 dihapus

  izin edit_file  ubah hitung.js
  jalankan? [y/N]
```

Menyetujui "tulis src/app.ts (40 baris)" berarti menyetujui sesuatu yang tidak
terlihat; diff membuat persetujuan menjadi keputusan yang berdasar. Core meminta
izin lewat callback `askPermission`, sehingga web nanti bisa memakai mekanisme
persetujuan yang berbeda tanpa mengubah core.

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
