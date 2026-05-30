-- Propagasi penghapusan temuan ke device petugas.
--
-- Masalah: setelah admin menghapus temuan (baris patrol_reports terhapus + tombstone
-- tertulis), device PETUGAS masih menampilkan temuan. Penyebabnya:
--   1. patrol_report_tombstones TIDAK ada di realtime publication, jadi petugas tidak
--      pernah menerima event INSERT tombstone secara realtime.
--   2. Sebagian tombstone memiliki ship_name NULL, sehingga RLS can_access_ship_name(NULL)
--      menolak petugas membaca tombstone — padahal klien butuh membacanya untuk mereset
--      checkpoint lokal.
--
-- Migrasi ini menambahkan tabel tombstone ke realtime publication dan mengisi ulang
-- ship_name yang kosong dari tabel ships berdasarkan ship_id.

-- 1. Backfill ship_name yang NULL/kosong dari tabel ships agar RLS read petugas lolos.
update public.patrol_report_tombstones t
set ship_name = s.name
from public.ships s
where t.ship_id = s.id
  and (t.ship_name is null or t.ship_name = '');

-- 2. Tambahkan tabel tombstone ke realtime publication agar event INSERT terkirim ke
--    device petugas (tunduk pada RLS read per kapal).
do $$
begin
  alter publication supabase_realtime add table public.patrol_report_tombstones;
exception
  when duplicate_object then null;
end $$;
