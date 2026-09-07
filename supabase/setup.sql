-- ============================================================
-- BANDAR80 — supabase/setup.sql
-- Jalankan SEKALI di Supabase SQL Editor (dashboard supabase).
-- Bikin tabel claims, sites, kebijakan RLS anon, dan seed situs.
-- WARNING: keys publishable boleh terbuka, tapi RLS di bawah longgar
-- (anon boleh insert/select/update) supaya extension worker dan web
-- bisa dipakai tanpa secret. Untuk produksi lebih ketat, pindahkan
-- worker ke service-role + batasi kolom via trigger. Sesuaikan dgn
-- kebutuhanmu sendiri.
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
  betting numeric not null,
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
  updated_at timestamptz not null default now()
);

create index if not exists claims_status_idx on public.claims(status);
create index if not exists claims_site_idx on public.claims(site);
create index if not exists claims_created_idx on public.claims(created_at desc);

-- ---------- TABEL SITES (registri situs terdaftar) ----------
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

-- anon: lihat klaim (dashboard owner online)
drop policy if exists "claims_select_anon" on public.claims;
create policy "claims_select_anon" on public.claims
  for select to anon using (true);

-- anon: update status (extension worker di PC owner)
drop policy if exists "claims_update_anon" on public.claims;
create policy "claims_update_anon" on public.claims
  for update to anon using (true);

-- anon: hapus (tombol bersihkan arsip selesai)
drop policy if exists "claims_delete_anon" on public.claims;
create policy "claims_delete_anon" on public.claims
  for delete to anon using (true);

-- anon: baca daftar situs (dropdown Situs)
drop policy if exists "sites_select_anon" on public.sites;
create policy "sites_select_anon" on public.sites
  for select to anon using (true);

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