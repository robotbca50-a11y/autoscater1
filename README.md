# AUTO CEK SCATER LIVE — Web Klaim BANDAR80

Web publik untuk menerima klaim scatter dari user. **User tidak perlu extension** —
klaim dikirim ke database Supabase, lalu **"otak"** (extension di komputer pemilik
sistem) yang mengambil, memverifikasi, menginput ke web bonus tujuan situs, dan
menentukan approve/reject.

## Struktur
- `index.html` — form klaim publik (Situs, User ID, Kode Tiket, Betting, Scatter).
- `dashboard.html` — meja owner: statistik + arsip hasil (Waktu · Situs · User ID · Kode Tiket · Betting · Scatter · Hasil).
- `sb.js` — helper REST ke Supabase (shared).
- `supabase/setup.sql` — buat tabel `claims` + `sites`, kebijakan RLS anon, seed situs.
- `messageImage_1787629523742.jpg` — latar belakang dashboard.

## Alur kerja (1 otak → banyak situs)
1. User isi form → row `status=PENDING` masuk tabel `claims`.
2. Extension (di PC owner) polling row PENDING, verifikasi betting/scatter ke data asli (RELAX AA).
3. Double-check: kalau cocok, diinput ke **web bonus tujuan situs** lewat kolom `sites.bonus_url` — tidak pernah salah target karena tiap situs punya URL sendiri.
4. Setelah diinput, logika auto-cek scatter berjalan di dashboard bonus tujuan → sesuai = approve, tidak = reject.
5. Status row diupdate real-time dan tampil di `dashboard.html`.

## Setup
1. Buka Supabase SQL Editor, jalankan isi `supabase/setup.sql` sekali.
2. Update `SBW_*` / `SB.*` jika memakai project Supabase lain.
3. Deploy folder ini ke GitHub Pages (atau web hosting statis lain — file bisa disalin).
4. Daftarkan situs lain di tabel `sites`, isi `bonus_url` yang benar, baru set `active=true`.
   Situs yang `active=false` **tidak** akan diinput ke web bonus manapun (aman dari salah input).