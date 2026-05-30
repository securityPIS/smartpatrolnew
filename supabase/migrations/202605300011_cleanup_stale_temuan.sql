-- Bersihkan temuan (result_type='temuan') dari shift-shift LAMA yang masih tersisa
-- di patrol_reports karena bug shift_key: client mengirim shift_key salah saat DELETE
-- sehingga .eq('shift_key', ...) tidak cocok dan baris tidak pernah terhapus.
--
-- Migration ini:
--   1. Menulis tombstone untuk setiap baris temuan yang masih ada (dengan shift_key ASLI
--      dari DB) agar re-upsert dari device manapun tetap diblokir setelah cleanup.
--   2. Menghapus baris temuan tersebut dari patrol_reports.
--
-- Aman dijalankan berkali-kali (idempotent): upsert tombstone on conflict do nothing,
-- delete hanya mengenai baris yang cocok.

-- 1. Tombstone semua sisa temuan pakai shift_key asli dari DB.
insert into public.patrol_report_tombstones
  (client_event_id, shift_key, ship_id, checkpoint_id, ship_name)
select
  coalesce(
    nullif(client_event_id, ''),
    shift_key || '|' || ship_id || '|' || checkpoint_id
  ) as client_event_id,
  shift_key,
  ship_id,
  checkpoint_id,
  ship_name
from public.patrol_reports
where result_type = 'temuan'
on conflict (client_event_id) do nothing;

-- 2. Hapus baris temuan dari patrol_reports.
delete from public.patrol_reports
where result_type = 'temuan';
