-- ============================================================
-- supabase/verify.sql — cek cepat keamanan DB (jalankan di SQL Editor)
-- 1) Apakah trigger pelindung ada? (2 klaim/hari, spoof-protect)
-- 2) Apakah RLS aktif?
-- ============================================================

-- Trigger pada tabel claims (harus muncul: trg_claims_enforce_insert,
-- trg_claims_protect_update)
select tgname, tgrelid::regclass as tabel
from pg_trigger
where not tgisinternal
  and tgrelid = 'public.claims'::regclass
order by tgname;

-- RLS ON/OFF per tabel
select relname as tabel, relrowsecurity as rls_aktif
from pg_class
where relname in ('claims', 'sites')
order by relname;

-- Hasil dari dua query di atas: bila trigger tidak muncul,
-- jalankan web/supabase/patch_rules.sql lalu ulangi cek ini.