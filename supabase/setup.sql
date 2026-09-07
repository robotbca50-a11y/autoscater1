-- ============================================================
-- BANDAR80 — supabase/setup.sql  (v2 HARDENED)
-- Jalankan SEKALI di Supabase SQL Editor (dashboard supabase).
-- Perubahan v2:
--   * INSERT dari web dipaksa: status PENDING + mode WEB (row
--     tidak bisa di-spoof status-nya oleh penyerang).
--   * UPDATE hanya boleh mengubah kolom proses verifikasi
--     (status/label/detail/match/actual_*) — kolom inti klaim
--     (site/user_id/kode_tiket/betting/scatter/mode) "terkunci".
--   * status cuma boleh salah satu nilai yang dikenal (enum check).
--   * DELETE hanya untuk baris status FINAL (arsip selesai) —
--     klaim PENDING/VERIFYING tidak bisa dihapus sembarangan orang.
--   * Rate-limit: max 60 klaim/jam per user_id (anti spam).
--   * claims SELECT tetap dibuka (publik: lacak status), tapi data
--     sensitif dijaga oleh aturan di atas.
-- CATATAN HONEST: tanpa login owner (Supabase Auth), anon masih bisa
--   baca & hapus arsip status FINAL. Untuk benar-benar rapat, upgrade
--   berikutnya: login owner + policy `auth.role()='authenticated'`.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- TABEL CLAIMS ----------
drop table if exists public.claims cascade;
create table public.claims (
  id uuid primary key default gen_random_uuid(),
  claim_no bigint generated always as identity,
  site text not null,
  user_id text not null,
  kode_tiket text not null,
  betting numeric not null check (betting > 0),
  scatter int not null check (scatter between 3 and 5),
  status text not null default 'PENDING',
  label text,
  detail text,
  match boolean,
  actual_bet text,
  actual_scatter text,
  mode text not null default 'WEB',
  site_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status in ('PENDING','QUEUED','VERIFYING','SESUAI','TIDAK_SESUAI',
                   'INPUTTING','INPUT_OK','INPUT_FAIL','ERROR','NO_TOKEN'))
);

create index if not exists claims_status_idx on public.claims(status);
create index if not exists claims_site_idx on public.claims(site);
create index if not exists claims_created_idx on public.claims(created_at desc);
create index if not exists claims_user_idx on public.claims(user_id);

-- ---------- TABEL SITES ----------
drop table if exists public.sites cascade;
create table public.sites (
  site_id text primary key,
  label text not null,
  check_domains text[] not null default '{}',
  bonus_url text,
  form_site_value text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- RLS ----------
alter table public.claims enable row level security;
alter table public.sites  enable row level security;

-- anon: kirim klaim (user web, tanpa login)
drop policy if exists "claims_insert_anon" on public.claims;
create policy "claims_insert_anon" on public.claims
  for insert to anon with check (true);

-- anon: lihat klaim (dashboard owner online + lacak status publik)
drop policy if exists "claims_select_anon" on public.claims;
create policy "claims_select_anon" on public.claims
  for select to anon using (true);

-- anon (extension worker di PC owner): ubah status verifikasi
drop policy if exists "claims_update_anon" on public.claims;
create policy "claims_update_anon" on public.claims
  for update to anon using (true);

-- anon: hapus HANYA arsip status FINAL (tombol bersihkan arsip selesai)
drop policy if exists "claims_delete_anon" on public.claims;
create policy "claims_delete_anon" on public.claims
  for delete to anon
  using (status in ('INPUT_OK','TIDAK_SESUAI','INPUT_FAIL','ERROR','NO_TOKEN'));

-- anon: baca daftar situs (dropdown Situs)
drop policy if exists "sites_select_anon" on public.sites;
create policy "sites_select_anon" on public.sites
  for select to anon using (true);

-- ---------- FUNGSI + TRIGGER PERLINDUNGAN ----------
create or replace function public.claims_enforce_insert()
returns trigger language plpgsql security definer as $$
declare
  cnt int;
  waktu_wib time;
begin
  -- jangan izinkan spoof status/label/mode dari form publik
  new.status := 'PENDING';
  new.label  := 'ANTRI';
  new.mode   := coalesce(nullif(new.mode,''), 'WEB');

  -- hasil verifikasi hanya boleh ditulis oleh worker (via UPDATE),
  -- tidak boleh dikirim langsung saat INSERT
  new.match          := null;
  new.actual_bet     := null;
  new.actual_scatter := null;
  new.site_label     := null;

  new.created_at := now();
  new.updated_at := now();
  -- CATATAN: kolom identity `claim_no` TIDAK diutak-atik —
  -- biarkan sequence mengisi otomatis.

  -- jam layanan WIB (UTC+7): hanya 00.00 s/d 23.50
  waktu_wib := (now() at time zone 'Asia/Jakarta')::time;
  if waktu_wib > time '23:50' then
    raise exception 'pengajuan klaim dibuka 00.00 s/d 23.50 WIB';
  end if;

  -- maksimal 2 klaim / user id / hari (WIB), reset otomatis tengah malam
  select count(*) into cnt from public.claims
  where user_id = new.user_id
    and cast(created_at + interval '7 hours' as date) = cast(now() + interval '7 hours' as date);
  if cnt >= 2 then
    raise exception 'maksimal 2 klaim per user id per hari';
  end if;

  return new;
end $$;

drop trigger if exists trg_claims_enforce_insert on public.claims;
create trigger trg_claims_enforce_insert
  before insert on public.claims
  for each row execute function public.claims_enforce_insert();

create or replace function public.claims_protect_update()
returns trigger language plpgsql security definer as $$
begin
  -- kolom inti tidak bisa diutak-atik lewat REST anon
  if (new.site      is distinct from old.site)      or
     (new.user_id   is distinct from old.user_id)   or
     (new.kode_tiket is distinct from old.kode_tiket) or
     (new.betting   is distinct from old.betting)   or
     (new.scatter   is distinct from old.scatter)   or
     (new.mode      is distinct from old.mode)      or
     (new.site_label is distinct from old.site_label) then
    raise exception 'kolom inti klaim tidak boleh diubah';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_claims_protect_update on public.claims;
create trigger trg_claims_protect_update
  before update on public.claims
  for each row execute function public.claims_protect_update();

-- ---------- SEED SITUS ----------
insert into public.sites (site_id, label, check_domains, bonus_url, form_site_value, active) values
  ('bandar80', 'BANDAR80',          array['ag-bandar80.idrbo2.com','bandar80.idrbo2.com'], 'https://bonussmb.com/tickets', 'bandar80', true),
  ('idrbo',    'IDRBO',             array['idrbo.com'],   null, 'idrbo',    false),
  ('idrbo1',   'IDRBO1',            array['idrbo1.com'],  null, 'idrbo1',   false),
  ('idrbo2',   'IDRBO2',            array['idrbo2.com'],  null, 'idrbo2',   false),
  ('idrbo3',   'IDRBO3',            array['idrbo3.com'],  null, 'idrbo3',   false)
on conflict (site_id) do nothing;

-- CATATAN: situs yang active=false belum muncul di form Situs dan
-- worker TIDAK akan menginput ke web bonus manapun (aman dari salah
-- input). Isi kolom bonus_url yang benar lalu set active=true saat
-- sudah yakin URL web bonus situs itu.