/*
Tujuan: Mengaktifkan sinkronisasi status petugas shift (patroli/istirahat) lintas-device.
Konteks: Tabel public.shift_status_records & public.shift_status_items sudah dibuat di init
(202605220001) dengan RLS ENABLED tetapi TANPA satu pun policy → semua akses ditolak secara
default, dan kedua tabel TIDAK pernah masuk realtime publication. Akibatnya status shift yang
diisi salah satu petugas tidak pernah sampai ke petugas lain sekapal: setiap device terpaksa
mengisi ulang. Migration ini menambahkan policy RLS (baca/tulis untuk kapal yang ditugaskan
via can_access_ship_name, hapus untuk admin), trigger updated_at, serta realtime publication,
mengikuti pola tabel patrol_reports.
Side Effects: DDL idempotent (drop policy if exists + guard publication). Tidak menyentuh data.
*/

-- Trigger updated_at (kolom updated_at sudah ada sejak init).
drop trigger if exists set_shift_status_records_updated_at on public.shift_status_records;
create trigger set_shift_status_records_updated_at
  before update on public.shift_status_records
  for each row execute function public.set_updated_at();

-- RLS shift_status_records: baca/tulis dibatasi kapal yang ditugaskan (atau admin via
-- can_access_ship_name yang sudah true untuk admin), hapus hanya admin. Konsisten dengan
-- patrol_reports sehingga satu record per (ship_id, shift_key) bisa di-upsert oleh petugas
-- mana pun di kapal yang sama dan dibaca oleh seluruh kru sekapal + admin/PIC.
drop policy if exists "shift_status_records_read_assigned" on public.shift_status_records;
create policy "shift_status_records_read_assigned" on public.shift_status_records
for select to authenticated
using (public.can_access_ship_name(ship_name));

drop policy if exists "shift_status_records_insert_assigned" on public.shift_status_records;
create policy "shift_status_records_insert_assigned" on public.shift_status_records
for insert to authenticated
with check (public.can_access_ship_name(ship_name));

drop policy if exists "shift_status_records_update_assigned" on public.shift_status_records;
create policy "shift_status_records_update_assigned" on public.shift_status_records
for update to authenticated
using (public.can_access_ship_name(ship_name))
with check (public.can_access_ship_name(ship_name));

drop policy if exists "shift_status_records_admin_delete" on public.shift_status_records;
create policy "shift_status_records_admin_delete" on public.shift_status_records
for delete to authenticated
using (public.is_admin());

-- RLS shift_status_items: akses mengikuti record induknya (tabel ini opsional untuk klien,
-- yang menyimpan daftar item juga di payload JSONB record; policy ditambahkan agar tabel
-- tetap konsisten bila suatu saat ditulis terpisah).
drop policy if exists "shift_status_items_access_assigned" on public.shift_status_items;
create policy "shift_status_items_access_assigned" on public.shift_status_items
for all to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.shift_status_records r
    where r.id = record_id and public.can_access_ship_name(r.ship_name)
  )
)
with check (
  public.is_admin()
  or exists (
    select 1 from public.shift_status_records r
    where r.id = record_id and public.can_access_ship_name(r.ship_name)
  )
);

-- Realtime publication agar perubahan status shift langsung terdorong ke device lain.
alter table public.shift_status_records replica identity full;

do $$
begin
  alter publication supabase_realtime add table public.shift_status_records;
exception
  when duplicate_object then null;
end $$;
