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

## Banner

Banner menyusut bertahap mengikuti lebar terminal:

| Lebar | Tampilan |
|---|---|
| ≥ 78 kolom | teks `BOO CODE` + logo panda |
| ≥ 64 kolom | teks saja |
| < 64 kolom | satu baris `BOO CODE` |

Logo dirender sebagai ANSI half-block (satu karakter memuat dua piksel) dan
**ditanam sebagai string** di `packages/cli/src/logo.ts`, sehingga CLI tidak
memerlukan decoder PNG saat runtime. Regenerasi saat logo berubah:

```bash
python3 scripts/gen-logo.py   # butuh Pillow
```

Pada ukuran 13x12 piksel, yang membuat panda terbaca adalah kontras wajah putih
terhadap lingkar mata — bukan siluetnya. Karena itu warna dibiarkan apa adanya
dan kontrasnya dinaikkan; telinga hitam memang menyatu dengan latar terminal.

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

## Tool dan izin

| Tool | Risiko | Perilaku |
|---|---|---|
| `read_file` | aman | langsung jalan |
| `list_dir` | aman | langsung jalan |
| `write_file` | konfirmasi | minta izin tiap kali |
| `edit_file` | konfirmasi | minta izin tiap kali |
| `bash` | konfirmasi | minta izin tiap kali |

Izin ditanyakan dengan menampilkan tindakan utuhnya — perintah shell yang sebenarnya,
bukan sekadar nama tool. Core meminta izin lewat callback `askPermission`, sehingga
web nanti bisa memakai mekanisme persetujuan yang berbeda tanpa mengubah core.

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
