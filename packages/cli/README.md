# Boo Code

Coding agent buatan FLdev yang berjalan di terminal. Model diakses lewat 9Router.

## Memasang

Membutuhkan Node.js 22.12 atau lebih baru, dan setidaknya satu penyedia model:
9Router, OpenAI, Anthropic, OpenRouter, Ollama lokal, atau alamat OpenAI-compatible
lain.

```bash
npm install -g ./boo-code-0.1.0.tgz
boo-code setup
```

`setup` menampilkan daftar penyedia, menanyakan alamat dan kunci API (tidak tampil
saat diketik), memeriksa koneksinya, lalu menyimpannya di `~/.boo/.env` dengan izin
hanya untuk pemilik. Beberapa penyedia boleh dipasang sekaligus; model dari penyedia
selain yang utama ditandai awalan seperti `anthropic:claude-sonnet-4-6`. Menjalankan
`boo-code` pertama kali tanpa setelan juga langsung membuka setup.

Kredensial langganan Codex CLI dan Claude Code tidak dipakai — keduanya diterbitkan
untuk aplikasi itu sendiri. Pakai kunci API resmi, atau 9Router.

Periksa instalasi kapan saja dengan `boo-code doctor`, atau `/doctor` dari dalam
sesi. Pemeriksaan meliputi runtime, workspace, provider/model, izin konfigurasi,
Git, ripgrep, sandbox, dan browser CDP opsional. Credential, source, prompt, cookie,
dan isi halaman tidak dicetak. Exit code `1` hanya dipakai untuk kegagalan wajib;
integrasi opsional yang tidak aktif dilaporkan sebagai peringatan.

Command lokal dijaga Seatbelt pada macOS, Bubblewrap pada Linux, dan Microsoft MXC
ProcessContainer pada Windows x64/ARM64. Backend Windows memakai AppContainer atau
BaseContainer native, memblokir filesystem/network secara default, membersihkan ACL
sesudah proses, dan menolak status enforced bila `wxc-exec --probe` gagal. Jika
backend OS tidak tersedia, Boo kembali meminta approval dan menjelaskan fallback;
ia tidak mengganti sandbox dengan pembatasan PowerShell.

## Memakai

```bash
cd ~/proyek/apa-saja
boo-code                 # sesi baru di direktori ini
boo-code --resume        # pilih sesi sebelumnya
boo-code --help          # semua pilihan
```

Untuk script atau CI, jalankan satu tugas tanpa UI interaktif:

```bash
boo-code exec "jelaskan perubahan pada branch ini"
cat task.md | boo-code exec --full-auto
boo-code exec --json --ephemeral "periksa test yang gagal"
boo-code exec --image ./screenshot.png "jelaskan error ini"
```

Mode `exec` menolak tool yang membutuhkan approval secara bawaan. `--full-auto`
hanya mengizinkan perubahan workspace dan command lokal yang benar-benar dijaga
OS sandbox; aplikasi, pesan, memori global, dan MCP tetap ditolak. `--json`
menghasilkan JSONL dan record terakhir selalu bertipe `result`.

Task berkala memakai penyimpanan JSON lokal tanpa database:

```bash
boo-code schedule add --every 30m -- "periksa status proyek"
boo-code schedule add --daily 09:00 --full-auto -- "jalankan lint dan perbaiki"
boo-code daemon
```

`--full-auto` scheduler memiliki batas yang sama dengan mode headless: hanya file
workspace dan command lokal tersandbox; computer use, pesan, MCP, dan aksi eksternal
tetap ditolak.

Task juga dapat dipicu event tanpa database:

```bash
boo-code trigger add file --pattern "src/**/*.ts" --debounce 2s -- "jalankan test terkait"
boo-code trigger add git -- "review commit baru"
boo-code trigger add custom --event ci.failed -- "diagnosis build"
boo-code trigger emit ci.failed
boo-code trigger add webhook -- "proses notifikasi deployment"
boo-code daemon
```

Webhook hanya membuka loopback `127.0.0.1:7331`, memakai Bearer token yang
ditampilkan satu kali, dan tidak meneruskan request body ke model. File/Git memakai
polling portabel dengan debounce dan pengamatan pertama hanya membuat baseline.
Definisi, antrean, dan ringkasan run disimpan sebagai file privat di `~/.boo`.

Computer use native memakai bridge accessibility yang didaftarkan di
`~/.boo/computer.json` untuk `darwin`, `win32`, atau `linux`. Snapshot, klik, input,
dan tombol selalu membutuhkan approval baru. Device lain dapat dipasangkan lewat
`boo-code node pair` dan dilayani lewat `boo-code node serve`; HTTP hanya loopback,
alamat jaringan wajib HTTPS, dan protokol remote tidak menyediakan shell bebas.

Dalam sesi interaktif gunakan `/attach <path>` sebelum mengetik prompt. PNG, JPEG,
WebP, dan GIF didukung hingga lima gambar per pesan. Gambar disimpan privat agar
tetap tersedia saat `/resume`; path lokalnya tidak dikirim ke provider.

Jika proses mati di tengah task, `/resume` juga memulihkan konteks kerja durable:
tujuan terakhir, todo, file checkpoint yang terdampak, tool yang belum pasti, dan
status verifikasi. Boo memeriksa ulang workspace serta menjalankan verifikasi baru
sebelum menyatakan selesai. Metadata ini memakai JSONL/checkpoint lokal tanpa DB;
isi source, argumen, prompt, dan output tool tidak disalin ke jurnal runtime.

Sertakan konteks source langsung dengan `@path`, rentang seperti
`@src/app.ts:20-60`, atau `@"folder dengan spasi"`. Boo membatasi isi dan tree,
menolak path di luar workspace, symlink langsung, binary, serta berkas credential.
Prompt asli tetap tampil ringkas saat sesi dilanjutkan.

Untuk informasi terbaru atau dokumentasi eksternal, minta Boo mencari web atau
berikan URL HTTPS publik. Tool `web_search` dan `web_fetch` berjalan baca-saja,
menyertakan URL sumber, menolak alamat privat/lokal, dan memperlakukan isi halaman
sebagai data tidak tepercaya. Jangan memasukkan credential atau source code privat
ke query pencarian.

Untuk halaman interaktif atau situs yang sudah login, jalankan Chrome/Edge dengan
`--remote-debugging-port=9222` dan profil terpisah (`--user-data-dir=...`), lalu
minta Boo membuka, membaca, mengeklik, atau mengetik di tab tersebut. Hanya CDP
loopback yang diterima. Metadata, isi halaman, navigasi, klik, dan input selalu
memerlukan persetujuan baru; password, token, data pembayaran, upload file, dan OTP
tidak boleh diisi. Port khusus dapat diatur di `~/.boo/browser.json` dengan
`{ "cdpUrl": "http://127.0.0.1:9333" }`. Panduan per OS tersedia di README utama.
Selain membuka, membaca, klik, dan mengetik, Boo dapat menavigasikan tab yang sama,
memilih label dropdown yang cocok persis, serta menekan tombol navigasi/aksi dari
daftar terbatas. Tidak ada keyboard bebas atau evaluasi JavaScript dari model.
Boo juga dapat memantau error console, exception JavaScript, HTTP gagal, dan request
gagal selama 250 ms–10 detik. Diagnostik tidak mengambil header, cookie, storage,
atau body; reload halaman harus terlihat dan disetujui secara eksplisit.

Di dalam sesi, ketik `/help` untuk daftar perintah: `/model`, `/spec`, `/undo`, `/restore`,
`/fork`, `/rewind`, `/permissions`, `/compact`, `/context`, `/init`, dan lainnya. `/fork` menyalin percakapan, model, dan
ringkasan konteks ke sesi eksperimen baru tanpa menimpa sesi asal. File workspace
tetap dipakai bersama dan riwayat undo cabang dimulai kosong; gunakan Git worktree
bila perubahan file juga harus terisolasi. `/rewind` memilih prompt lama lalu
membuat cabang dari keadaan tepat sebelum prompt tersebut; sesi asal tetap utuh
dan fitur ini tidak mengembalikan file workspace. Esc menghentikan pekerjaan yang sedang berjalan.

`/restore` memilih checkpoint file lama dan mengembalikan checkpoint tersebut
beserta semua perubahan file sesudahnya. Boo menampilkan preview gabungan,
menandai edit pengguna, memeriksa fingerprint ulang setelah konfirmasi, dan
melakukan rollback bila penerapan parsial gagal. Command serta percakapan tidak
diputar balik; maksimal 20 checkpoint per sesi disimpan sebagai JSON privat.
Tidak ada database atau service tambahan.

`/context` memeriksa anggaran konteks secara lokal tanpa memanggil model. Laporannya
memisahkan system prompt, percakapan, hasil/panggilan tool, gambar, dan skema tool;
menunjukkan headroom serta pesan yang akan dipangkas; lalu menyarankan `/compact`
bila pemakaian mulai tinggi. Guard runtime memakai perhitungan yang sama dan
menyisihkan biaya skema tool sebelum memangkas pesan.

Skema tool juga dipangkas secara dinamis. Setiap task dimulai dengan tool inti dan
`tool_search`; model mencari capability khusus yang dibutuhkan, lalu hasilnya aktif
mulai putaran berikutnya sampai task selesai. Review dan sub-agent hanya dapat
menemukan tool yang termasuk katalog terbatasnya. Ranking serta state tersimpan di
memori saja, tanpa database, dan `/context` menghitung skema aktif aktual.

`/status` juga sepenuhnya lokal. Perintah ini menampilkan tujuan dan outcome task
terakhir, model/reasoning, durasi, turn, hasil tool, progres todo, file checkpoint,
command, review keamanan, serta status verifikasi. Saat sesi dilanjutkan, fakta yang
tersedia dipulihkan dari history/checkpoint dan state yang tidak diketahui tidak
ditebak. Fitur ini tidak membutuhkan database.

Loop guard mendeteksi tool berturut-turut dengan nama, argumen, dan hasil identik.
Hasil kedua memberi peringatan, percobaan ketiga diblokir sebelum dijalankan, dan
pengulangan berikutnya menghentikan task secara aman. Argumen/hasil berbeda mereset
urutan; `bash_output` dan `bash_input` dikecualikan untuk polling proses. Penolakan
pengguna juga tidak akan memunculkan permintaan izin identik lagi. State guard hanya
berupa hash di memori dan jumlahnya terlihat lewat `/status`, tanpa database.

Tool argument guard memvalidasi JSON dan schema function call sebelum preview,
approval, hook, atau eksekusi. Field wajib, tipe, enum, pola, batas, array, dan object
nested diperiksa; kesalahan dikembalikan sebagai path schema agar model mengoreksi
panggilannya sendiri. Nilai argumen mentah tidak masuk event/jurnal, `/status`
menghitung panggilan invalid, dan mode `exec --json` mengirim event `tool.invalid`.

Tool Protocol Circuit Breaker menghitung putaran yang seluruh function call-nya
invalid. Putaran kedua memberi peringatan; putaran ketiga menghentikan mode manual
atau mengarantina model dan memilih fallback pada mode Auto. Satu call valid mereset
rangkaian. ID kosong/duplikat dinormalisasi, fallback Auto dibatasi dua kali, dan
`exec --json` mengirim `tool.protocol_warning|fallback|stopped`. Hanya jenis serta
jumlah kegagalan yang dicatat di memori; payload argumen tidak disimpan dan tidak
memerlukan database.

File yang pernah dibaca atau ditampilkan sebagai bukti pencarian dipantau selama
proses berjalan. Bila editor, command, atau proses lain mengubah, menghapus, atau
membuat path-nya tidak aman, Boo memberi notice dan model menerima pengingat
sementara untuk membaca ulang. Detector memakai metadata lalu hash hanya saat perlu,
tidak memindai seluruh workspace, tidak memasukkan notice ke history, dan tidak
memerlukan database.

Pembacaan `read_file` identik yang sukses memakai evidence cache selama satu task.
Cache diinvalidasi saat workspace/aturan berubah, tidak melewati lifecycle hook,
dan otomatis menghidrasi isi penuh bila bukti sumber sudah terpotong dari konteks.
`/status` dan `/stats` menampilkan hit serta karakter yang dihemat; `exec --json`
mengirim `tool.cache_hit`. Cache hanya hidup di memori tanpa database.

Saat fallback trimming diperlukan, Boo meranking blok lama terhadap tujuan task
aktif dan mempertahankan bukti yang menyebut path, identifier, simbol, atau error
relevan sebelum percakapan netral. User request terakhir, blok terbaru, seluruh
system prompt, serta pasangan tool call/result tetap utuh dan kronologis. `/context`,
`/status`, `/stats`, notice CLI/web, dan field `prioritized_messages` pada
`context.trimmed` menunjukkan hasil seleksi. Ranking hanya hidup di memori tanpa DB.

Hingga empat tool discovery independen (`read_file`, `grep`, `repo_map`, dan inspeksi
Git read-only) dari satu response model dapat berjalan paralel, termasuk dalam batch
heterogen, tetapi hasil selalu masuk history sesuai urutan call. Hanya tool opt-in
yang diaudit; scoped instruction, lifecycle hook, argumen invalid, duplicate call,
tool network/interaktif, atau tool yang berpotensi side effect otomatis memakai
jalur serial aman. Cache, snapshot, pembatalan, dan prompt-injection guard tetap
aktif. `/status` serta `/stats` menampilkan jumlah batch/call; `exec --json` mengirim
`tool.parallel_started|completed` beserta daftar tool. Tidak ada database tambahan.

Output tool di atas 64.000 karakter dipadatkan menjadi bagian awal/akhir dan, bila
masih di bawah batas penyimpanan, ditahan sementara di memori task. Agent dapat
membaca rentang lain melalui `read_tool_output` memakai reference opaque yang
ditampilkan. Reference berakhir bersama task dan tidak ditulis ke sesi atau DB.
`/status`, `/stats`, serta event JSON `tool.result_truncated` melaporkan hanya jumlah
dan ukuran, bukan isi output.

Aturan `BOO.md`, `AGENTS.md`, atau `CLAUDE.md` di subdirektori monorepo dimuat
berdasarkan target `@path` dan path eksplisit tool. Aturan diberi scope subtree;
sibling tidak saling berlaku. Tool pertama yang menemukan scope baru ditunda sebelum
preview/approval/eksekusi, lalu model mengulanginya setelah membaca system prompt
terbaru. Path dalam `apply_patch` dan sub-agent worktree ikut didukung, tanpa DB.

`/permissions` menampilkan aturan izin persisten dari `~/.boo/permissions.json`
(pribadi: allow/ask/deny) dan `.boo/permissions.json` (proyek: ask/deny saja).
Aturan dapat mencocokkan tool serta kondisi command, path, aplikasi, atau domain.
Allow tidak melewati sandbox, batas workspace, perlindungan secret, maupun aksi
yang wajib mendapat approval baru. Seluruhnya berupa JSON lokal tanpa database.
Teks biasa yang dikirim saat Boo masih bekerja menjadi arahan untuk task aktif dan
diterapkan pada batas aman berikutnya. Pakai `/queue <task>` untuk menambahkan
pekerjaan terpisah yang baru berjalan sesudah task aktif selesai.
Mode Auto memilih model dan tingkat penalaran per tugas. Jika profil benchmark lokal
`~/.boo/auto-performance.json` tersedia dan memiliki sedikitnya tiga sampel untuk
dua model pada difficulty yang sama, hasil terukur ikut menentukan pilihan; data
lama/rusak selalu diabaikan dan kebijakan bawaan tetap menjadi fallback.
Auto juga mempelajari dukungan model dari respons dan error provider nyata di
`~/.boo/provider-capabilities.json`: availability, tool calling, gambar, reasoning,
dan kapasitas konteks. Hanya counter serta angka token yang disimpan, tanpa prompt,
source, path, argumen, jawaban, atau output. Jalankan `/capabilities` untuk melihat
bukti lokal yang sedang aktif.

Task yang berakhir gagal, berhenti, atau belum terverifikasi menghasilkan failure
postmortem lokal di `~/.boo/postmortems/<hash-workspace>/`. Diagnosis memakai event
nyata tanpa panggilan model tambahan dan tidak menyimpan prompt, pesan error mentah,
source, path, argumen, jawaban, atau output. Gunakan `/postmortem` untuk melihat
penyebab terakhir beserta tindakan lanjut yang disarankan.

Saat context window mulai penuh, Boo memilih history relevan bersama dependency
penjelasnya: task user, rantai tool, perubahan yang sedang diverifikasi, serta
path/simbol yang muncul kembali. Graph ini dibatasi, hanya hidup di memori, dan
tidak memakai DB. `/context` memperkirakan pesan/relasi yang dipertahankan;
`/status` dan `/stats` menampilkan angka agregat sesudah trimming terjadi.

Setelah perubahan kode berat lolos verifikasi, Boo menjalankan reviewer independen
tanpa tool terhadap diff checkpoint terbaru. Temuan diperiksa kembali oleh agent
utama, lalu perbaikan wajib diverifikasi lagi; maksimal dua putaran per task.
Reviewer gagal tidak membatalkan hasil terverifikasi. Setel
`BOO_AUTO_REVIEW=false` untuk menonaktifkannya.

Diff checkpoint juga dinilai lokal sebagai risiko low/medium/high. Perubahan
autentikasi, pembayaran, migrasi, deployment, dependency, penghapusan, bypass
keamanan, atau diff besar dapat dinaikkan ke high. Risiko tinggi meminta test,
typecheck, build, atau diagnostics—bukan hanya formatter/`git diff --check`—dan
memicu reviewer otomatis meskipun prompt awal terlihat sederhana.

Sesudah file berubah, Boo memakai indeks dependency lokal untuk mencari test yang
bernama sepadan atau mengimpor jalur terdampak. Command hanya direkomendasikan bila
terdeteksi dari manifest/config proyek; rekomendasi ditampilkan sebagai kandidat
dan tetap memerlukan approval ketika benar-benar dijalankan.

Untuk diagnosis yang memang membutuhkan sejarah, tool baca-saja `git_log`,
`git_show`, dan `git_blame` dapat melihat commit, patch satu file, serta asal rentang
baris. Eksekusinya tanpa shell; ref opsi, path luar workspace, dan credential ditolak.
Email author tidak dikembalikan, karakter kontrol dinetralkan, blame maksimal 200
baris, dan output dibatasi agar tidak memenuhi konteks.

Jika diminta secara eksplisit, Boo dapat membuat commit Git lokal dari file yang
disebut satu per satu. Panel approval menampilkan pesan dan seluruh daftar file;
perubahan staged lain tetap staged. Commit otomatis menolak credential, metadata
internal, direktori, serta state yang berubah saat approval terbuka. Git hooks dan
signing tidak dijalankan, dan `exec --full-auto` tidak dapat menyetujui commit.

Proses latar belakang yang membutuhkan jawaban dapat dimulai sebagai proses
interaktif. Boo lalu memakai `bash_input` untuk mengirim teks atau menutup stdin
dan `bash_output` untuk membaca respons. Setiap input ditampilkan utuh dan meminta
persetujuan baru, dibatasi 4.096 karakter, serta tidak boleh memuat credential.
Fitur ini memakai pipe lintas platform dan bukan terminal/TTY layar penuh.

Boo hanya dapat menyentuh berkas di direktori tempat ia dijalankan, dan meminta
izin sebelum mengubah berkas atau menjalankan perintah.

Sebelum request dikirim ke provider, Boo meredaksi API key yang diketahui, private
key, token umum, header auth/cookie, connection string ber-credential, dan properti
credential dari seluruh konteks teks—termasuk hasil shell, MCP, dan hook. Model
melihat marker `[RAHASIA DISEMBUNYIKAN OLEH BOO]`; riwayat lokal tidak diubah.
Guard ini tidak dapat membaca teks yang berada di dalam pixel screenshot, jadi
gambar tetap harus diperiksa pengguna sebelum dilampirkan.

Hasil file, web, browser, MCP, command, memori, dan sub-agent juga dibungkus sebagai
data tidak tepercaya sebelum menuju model. Jika detektor lokal menemukan pola prompt
injection, CLI memberi peringatan dan seluruh aksi berisiko berikutnya wajib approval
baru—izin sesi tidak dipakai. `boo-code exec` menolak aksi tersebut karena mode
headless tidak dapat meminta konfirmasi segar. Isi tetap tersedia untuk dianalisis;
guard tidak menghapus source dan tidak memerlukan database.

## Melepas

```bash
npm uninstall -g boo-code
```

Sesi dan setelan di `~/.boo` tidak ikut terhapus.
