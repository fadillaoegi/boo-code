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
- **Dikerjakan oleh:** Claude Code (melanjutkan sesi Codex yang terhenti karena limit)
- **Verifikasi:** `pnpm typecheck`, `pnpm test` (511 lolos), `pnpm -s lint`, dan
  `pnpm release` — semuanya bersih. Uji asap ke 9Router sungguhan lewat
  `boo-code exec` dan `boo-code doctor` berhasil, dan halaman web diuji di Chrome
  headless (dialog penyedia, simpan berhasil, dan kegagalan koneksi).
- **Git:** semua pekerjaan sudah di-commit; tidak ada yang menggantung.

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

## Sedang dikerjakan

Tidak ada. Yang tersisa dari #72, bila ingin dilanjutkan:

- Mencoba jalur Anthropic dengan kunci API sungguhan. Di mesin ini belum ada
  `ANTHROPIC_API_KEY`, jadi adapter baru diuji lewat server tiruan di
  `packages/core/tests/providers.test.ts`.

## Berikutnya (peta jalan Codex, nomor 2–10)

1. Expanded Agent Evals — benchmark debugging kompleks, refactor lintas modul,
   keamanan, concurrency, repository besar.
2. Adaptive Tool Timeout & Recovery.
3. Verification Repair Loop.
4. Change Impact Graph.
5. Persistent LSP Session.
6. Native Windows Sandbox.
7. Provider Capability Learning.
8. Failure Postmortem.
9. Context Dependency Graph.

## Perintah verifikasi

```bash
pnpm install
pnpm typecheck
pnpm test        # seluruh package
pnpm -s lint
pnpm release     # paket rilis; perhatikan ukuran bundel tetap ~1 MB
```
