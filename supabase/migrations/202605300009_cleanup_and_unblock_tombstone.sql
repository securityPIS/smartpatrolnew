-- Bersihkan baris patrol_reports yang tertinggal setelah perbaikan JS (202605300009).
--
-- Akar masalah: handleDeleteIncident me-reset checkpoint dengan shiftKey = currentShiftMeta.key
-- (bukan incident.shiftKey). Periodic-sync kemudian men-upsert baris baru ke patrol_reports
-- dengan shift_key = currentShiftMeta.key, yang BERBEDA dari tombstone (shift_key = incident.shiftKey).
-- Trigger two-key tidak mengenali baris ini, sehingga petugas bisa men-complete-kan ulang
-- checkpoint dan temuan hidup kembali.
-- Diperbaiki di JS: handleDeleteIncident sekarang memakai incident.shiftKey saat reset.
--
-- Migrasi ini membersihkan baris-baris lama (artefak admin-reset sebelum perbaikan JS):

-- 1. Hapus baris patrol_reports yang natural key-nya SAMA PERSIS dengan tombstone.
--    (Seharusnya sudah dihapus, tapi mungkin lolos karena race condition.)
delete from public.patrol_reports pr
where exists (
  select 1 from public.patrol_report_tombstones t
  where t.ship_id = pr.ship_id
    and t.checkpoint_id = pr.checkpoint_id
    and t.shift_key is not distinct from pr.shift_key
);

-- 2. Hapus baris patrol_reports yang STATUS-nya 'pending' dengan ship_id + checkpoint_id
--    yang ADA di tombstone (shift_key berapapun).
--    Baris ini adalah artefak admin-reset yang memakai shift_key salah — tidak akan ada
--    baris pending legitimate untuk checkpoint yang sudah di-tombstone, karena patrol
--    normal hanya menulis baris saat 'completed' (bukan pending).
delete from public.patrol_reports pr
where pr.status = 'pending'
  and exists (
    select 1 from public.patrol_report_tombstones t
    where t.ship_id = pr.ship_id
      and t.checkpoint_id = pr.checkpoint_id
  );
