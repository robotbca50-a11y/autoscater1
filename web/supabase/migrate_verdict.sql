-- ============================================================
-- supabase/migrate_verdict.sql  — SEKALI JALAN (aman diulang)
-- Menambahkan kolom verdict (hasil cek approve/reject dari
-- bg-queue AUTO RELAX) + status APPROVED/REJECTED ke database.
-- ============================================================

alter table public.claims add column if not exists verdict text;
alter table public.claims add column if not exists verdict_at timestamptz;

do $$
begin
  -- lepas check constraint lama (nama boleh beda di tiap proyek),
  -- lalu pasang ulang dengan status terbaru (termasuk APPROVED/REJECTED).
  begin
    alter table public.claims drop constraint if exists claims_status_check;
  exception when others then raise notice 'constraint lama tidak ditemukan (abaikan)';
  end;
end $$;

alter table public.claims
  add constraint claims_status_check
  check (status in (
    'PENDING','QUEUED','VERIFYING','SESUAI','TIDAK_SESUAI',
    'INPUTTING','INPUT_OK','INPUT_FAIL','ERROR','NO_TOKEN','ID_SALAH',
    'APPROVED','REJECTED'
  ));

create index if not exists claims_verdict_idx on public.claims(verdict);
create index if not exists claims_verdict_at_idx on public.claims(verdict_at);

-- Verifikasi: kolom baru + constraint terpasang
select column_name from information_schema.columns
where table_schema = 'public' and table_name = 'claims'
  and column_name in ('verdict', 'verdict_at')
order by column_name;

select conname, pg_get_constraintdef(oid)
from pg_constraint
where conrelid = 'public.claims'::regclass and contype = 'c';