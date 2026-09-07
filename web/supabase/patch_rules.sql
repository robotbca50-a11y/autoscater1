-- ============================================================
-- BANDAR80 — supabase/patch_rules.sql   (PATCH AMAN, tanpa drop)
-- Tujuan: ganti total kedua trigger pelindung dengan versi yang
--   cocok ke kolom RIIL (betting/scatter/site, bukan jumlah_scatter
--   dsb) + aturan bisnis klaim terbaru:
--     1. Form publik: status/label dipaksa PENDING/ANTRI, mode WEB,
--        kolom verifikasi (match/actual_*) dipaksa kosong saat insert.
--     2. Jam layanan 00.00–23.50 WIB; sisa 10 menit untuk sistem
--        ganti hari. Lewat 23.50 WIB insert ditolak.
--     3. Maksimal 2 klaim per user id per hari (WIB).
--        Reset otomatis tiap tengah malam WIB.
--     4. Kolom inti (site/user_id/kode_tiket/betting/scatter/mode/
--        site_label/claim_no/id/created_at) tak bisa diubah via REST.
-- AMAN: hanya create or replace function + trigger, tidak ada drop
--   table, data tidak hilang. Bisa dijalankan ulang.
-- ============================================================

-- ---------- TRIGGER INSERT ----------
create or replace function public.claims_enforce_insert()
returns trigger language plpgsql security definer as $$
declare
  cnt int;
  waktu_wib time;
begin
  new.status := 'PENDING';
  new.label  := 'ANTRI';
  new.mode   := 'WEB'; -- kanal publik selalu WEB; MANUAL hanya via SQL admin

  -- hasil verifikasi hanya boleh ditulis worker via UPDATE
  new.match          := null;
  new.actual_bet     := null;
  new.actual_scatter := null;
  new.site_label     := null;

  new.created_at := now();
  new.updated_at := now();

  -- jam layanan WIB (UTC+7): 00.00 s/d 23.50
  waktu_wib := (now() at time zone 'Asia/Jakarta')::time;
  if waktu_wib > time '23:50' then
    raise exception 'pengajuan klaim dibuka 00.00 s/d 23.50 WIB';
  end if;

  -- maksimal 2 klaim / user id / hari WIB (reset tengah malam)
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

-- ---------- TRIGGER UPDATE ----------
create or replace function public.claims_protect_update()
returns trigger language plpgsql security definer as $$
begin
  -- kolom yang disensor / inti: tidak boleh diubah lewat REST anon
  if (new.id          is distinct from old.id)          or
     (new.claim_no    is distinct from old.claim_no)    or
     (new.site        is distinct from old.site)        or
     (new.user_id     is distinct from old.user_id)     or
     (new.kode_tiket  is distinct from old.kode_tiket)  or
     (new.betting     is distinct from old.betting)     or
     (new.scatter     is distinct from old.scatter)     or
     (new.mode        is distinct from old.mode)        or
     (new.site_label  is distinct from old.site_label)  or
     (new.created_at  is distinct from old.created_at)  then
    raise exception 'kolom inti klaim tidak boleh diubah';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_claims_protect_update on public.claims;
create trigger trg_claims_protect_update
  before update on public.claims
  for each row execute function public.claims_protect_update();