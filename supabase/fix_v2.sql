-- ============================================================
-- BANDAR80 — supabase/fix_v2.sql   (PATCH, TIDAK menghapus data)
-- Jalankan SEKALI di SQL Editor jika kamu sudah menjalankan
-- setup.sql v2 dan INSERT klaim gagal dengan error:
--   "null value in column claim_no of relation claims
--    violates not-null constraint"
-- Fix: trigger insert tidak boleh menyentuh kolom identity
-- `claim_no` (biarkan sequence mengisi otomatis). Sekalian
-- meng-null-kan kolom verifikasi (match/actual_bet/
-- actual_scatter/site_label) supaya anon tidak bisa
-- "pra-palsukan" hasil verifikasi.
-- AMAN: tidak ada drop table, tidak ada data yang hilang.
-- ============================================================

create or replace function public.claims_enforce_insert()
returns trigger language plpgsql security definer as $$
declare
  cnt int;
begin
  -- jangan izinkan spoof status/label/mode dari form publik
  new.status := 'PENDING';
  new.label  := 'ANTRI';
  new.mode   := coalesce(nullif(new.mode,''), 'WEB');

  -- hasi verifikasi hanya boleh ditulis oleh worker (via UPDATE),
  -- tidak boleh dikirim langsung saat INSERT
  new.match          := null;
  new.actual_bet     := null;
  new.actual_scatter := null;
  new.site_label     := null;

  new.created_at := now();
  new.updated_at := now();
  -- CATATAN: kolom identity `claim_no` TIDAK diutak-atik —
  -- biarkan sequence mengisi otomatis.

  -- rate-limit: max 60 klaim / jam per user_id
  select count(*) into cnt from public.claims
  where user_id = new.user_id and created_at > now() - interval '1 hour';
  if cnt >= 60 then
    raise exception 'terlalu banyak klaim dalam 1 jam, coba nanti';
  end if;

  return new;
end $$;