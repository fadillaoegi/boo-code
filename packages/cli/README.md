# Boo Code

Coding agent buatan FLdev yang berjalan di terminal. Model diakses lewat 9Router.

## Memasang

Membutuhkan Node.js 22.12 atau lebih baru, dan akses ke instance 9Router.

```bash
npm install -g ./boo-code-0.1.0.tgz
boo-code setup
```

`setup` menanyakan alamat 9Router, kunci API (tidak tampil saat diketik), dan
model bawaan, memeriksa koneksinya, lalu menyimpannya di `~/.boo/.env` dengan izin
hanya untuk pemilik. Menjalankan `boo-code` pertama kali tanpa setelan juga
langsung membuka setup.

## Memakai

```bash
cd ~/proyek/apa-saja
boo-code                 # sesi baru di direktori ini
boo-code --resume        # pilih sesi sebelumnya
boo-code --help          # semua pilihan
```

Di dalam sesi, ketik `/help` untuk daftar perintah: `/model`, `/spec`, `/undo`,
`/compact`, `/init`, dan lainnya. Esc menghentikan pekerjaan yang sedang berjalan.

Boo hanya dapat menyentuh berkas di direktori tempat ia dijalankan, dan meminta
izin sebelum mengubah berkas atau menjalankan perintah.

## Melepas

```bash
npm uninstall -g boo-code
```

Sesi dan setelan di `~/.boo` tidak ikut terhapus.
