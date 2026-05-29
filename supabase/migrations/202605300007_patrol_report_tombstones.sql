-- Tombstone untuk temuan/laporan patroli yang dihapus admin.
--
-- Akar masalah "temuan dihapus admin muncul lagi": hydrate (cloudState) membangun
-- ulang checkpointsByShip dari SELURUH baris patrol_reports, dan efek re-upsert di
-- klien (AppContextRuntime) menulis ulang SETIAP checkpoint 'completed' ke
-- patrol_reports pada SEMUA device (termasuk device petugas). Saat admin menghapus
-- baris, device petugas masih memegang checkpoint 'completed' secara lokal lalu
-- meng-upsert ulang -> baris hidup kembali untuk semua orang. Tombstone client-side
-- tidak pernah sampai ke device lain (writeStateToSql hanya sinkron profiles/ships).
--
-- Solusi: tabel tombstone di DB + trigger BEFORE INSERT/UPDATE pada patrol_reports
-- yang memblokir penulisan ulang baris yang client_event_id-nya sudah di-tombstone.
-- Dengan begitu re-upsert dari device manapun ditolak diam-diam di sisi server.

create table if not exists public.patrol_report_tombstones (
  client_event_id text primary key,
  shift_key text,
  ship_id text,
  checkpoint_id text,
  ship_name text,
  deleted_by text references public.profiles(id),
  deleted_at timestamptz not null default now()
);

alter table public.patrol_report_tombstones enable row level security;

-- Admin boleh kelola tombstone. Trigger memakai security definer sehingga tetap
-- berfungsi untuk penulis non-admin (petugas) yang tidak punya akses tulis/baca —
-- klien TIDAK perlu membaca tabel ini agar trigger jalan.
drop policy if exists "patrol_tombstones_admin_write" on public.patrol_report_tombstones;
create policy "patrol_tombstones_admin_write" on public.patrol_report_tombstones
for all to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Baca dibatasi seperti patrol_reports: admin, atau pengguna yang ditugaskan ke
-- kapal terkait. Tanpa pembatasan ini, PETUGAS/PIC satu kapal bisa enumerasi
-- metadata penghapusan (shift_key/ship_id/checkpoint_id) seluruh armada.
drop policy if exists "patrol_tombstones_read" on public.patrol_report_tombstones;
create policy "patrol_tombstones_read" on public.patrol_report_tombstones
for select to authenticated
using (public.is_admin() or public.can_access_ship_name(ship_name));

-- Trigger: tolak insert/update patrol_reports yang sudah di-tombstone.
-- RETURN NULL pada BEFORE INSERT/UPDATE membatalkan baris tersebut tanpa error,
-- sehingga upsert idempotent dari device lain tidak menghidupkan kembali temuan.
create or replace function public.block_tombstoned_patrol_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.patrol_report_tombstones t
    where t.client_event_id = new.client_event_id
  ) then
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists block_tombstoned_patrol_report_trg on public.patrol_reports;
create trigger block_tombstoned_patrol_report_trg
before insert or update on public.patrol_reports
for each row execute function public.block_tombstoned_patrol_report();
