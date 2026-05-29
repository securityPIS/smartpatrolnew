-- Perkuat trigger tombstone agar memblokir penulisan ulang patrol_reports berdasarkan
-- DUA kunci: client_event_id ATAU natural key (shift_key + ship_id + checkpoint_id).
--
-- Alasan: checkpoint hasil hydrate cloudState tidak membawa firestoreId, dan
-- client_event_id yang dipakai saat re-upsert bisa berbeda dari nilai yang tersimpan
-- pada baris asli. Dengan hanya mencocokkan client_event_id, re-upsert lolos dan temuan
-- yang sudah dihapus admin hidup kembali. Mencocokkan natural key membuat blokir tahan
-- terhadap perbedaan client_event_id.

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
       or (
         t.ship_id = new.ship_id
         and t.checkpoint_id = new.checkpoint_id
         and t.shift_key is not distinct from new.shift_key
       )
  ) then
    return null;
  end if;
  return new;
end;
$$;

-- Trigger sudah dibuat di 202605300007; di sini hanya mengganti body fungsi.
