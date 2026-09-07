-- ============================================================
-- BANDAR80 — supabase/rules_v3.sql   (PATCH, TIDAK menghapus data)
-- Aturan bisnis klaim (ganti rate-limit 60/jam dengan aturan harian):
--   1. Maksimal 2 klaim per user id PER HARI.
--   2. Limit reset tiap hari pukul 00.00 WIB (UTC+7).
--   3. Jam layanan pengajuan: 00.00 s/d 23.50 WIB.
-- AMAN: cuma create or replace function, tidak ada drop table.
-- ============================================================

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