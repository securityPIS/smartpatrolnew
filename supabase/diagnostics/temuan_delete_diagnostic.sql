-- ============================================================================
-- DIAGNOSTIK: kenapa temuan yang dihapus admin kembali lagi
-- Jalankan SATU per SATU di Supabase Dashboard -> SQL Editor.
-- Salin hasil tiap query dan kirim ke chat.
-- ============================================================================

-- (1) Apakah TRIGGER anti-resurrection sudah terpasang? (harus ada 1 baris)
select tgname, tgenabled, tgtype
from pg_trigger
where tgrelid = 'public.patrol_reports'::regclass
  and tgname = 'block_tombstoned_patrol_report_trg';

-- (2) Apakah FUNGSI trigger versi DUA-KUNCI (client_event_id OR natural key)?
--     Cari teks 'ship_id' di body fungsi. Kalau TIDAK ada 'ship_id', berarti
--     migration 202605300008 BELUM ke-deploy (masih versi lama satu-kunci).
select pg_get_functiondef('public.block_tombstoned_patrol_report'::regproc);

-- (3) Apakah migration terbaru sudah tercatat? Harus muncul 0007..0010.
select version
from supabase_migrations.schema_migrations
where version >= '202605300006'
order by version;

-- (4) Berapa total baris tombstone, dan apakah ship_name terisi?
select count(*) as total_tombstone,
       count(*) filter (where ship_name is null or ship_name = '') as ship_name_kosong
from public.patrol_report_tombstones;

-- (5) Berapa total temuan (resultType temuan) yang MASIH ada di patrol_reports?
--     Ini yang "balik lagi". Kalau banyak, berarti DELETE tidak pernah berhasil.
select shift_key, ship_id, ship_name, checkpoint_id, status, result_type, photo_url is not null as ada_foto
from public.patrol_reports
where result_type = 'temuan'
order by ship_id, checkpoint_id;

-- (6) Apakah tabel tombstone sudah masuk realtime publication? (harus ada 1 baris)
select schemaname, tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
  and tablename = 'patrol_report_tombstones';

-- (7) Apakah ada baris patrol_reports yang SEHARUSNYA terblokir tombstone tapi masih ada?
--     (natural key cocok tombstone) — kalau ADA, trigger tidak bekerja / belum deploy.
select pr.shift_key, pr.ship_id, pr.checkpoint_id, pr.result_type
from public.patrol_reports pr
join public.patrol_report_tombstones t
  on t.ship_id = pr.ship_id
 and t.checkpoint_id = pr.checkpoint_id
 and t.shift_key is not distinct from pr.shift_key;

-- ============================================================================
-- (8) UJI HAK AKSES ADMIN (RLS). Jalankan sebagai user admin yang login di app.
--     Cara paling akurat: di app, buka DevTools Console dan jalankan
--       const { data } = await window.supabase.auth.getUser(); console.log(data)
--     untuk dapat auth uid. Lalu di SQL Editor cek profil admin tsb:
-- ============================================================================
-- Ganti '<EMAIL_ADMIN>' dengan email admin yang dipakai login.
select id, auth_uid, email, role, enabled, review_state
from public.profiles
where lower(email) = lower('<EMAIL_ADMIN>');
-- Syarat is_admin() = true: role='ADMIN' AND enabled=true AND review_state='approved'.
-- Kalau salah satu tidak terpenuhi, DELETE & tombstone admin DITOLAK RLS diam-diam.
