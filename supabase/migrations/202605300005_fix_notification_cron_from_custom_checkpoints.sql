/*
Tujuan: Perbaiki cron notifikasi summary agar membaca definisi checkpoint dari
        ships.custom_checkpoints (JSONB) — sumber kebenaran yang dipakai klien —
        bukan dari tabel ship_checkpoints yang TIDAK pernah ditulis aplikasi.
Caller: pg_cron (jadwal notify-checkpoint-pending-shift-1/2/3 dan
        notify-shift-wrapup-shift-1/2/3 dari migration 202605300002).
Dependensi: tabel ships (kolom custom_checkpoints), patrol_reports,
            shift_history_entries, profiles, notifications,
            helper insert_notification_fanout + derive_notification_tone (202605300002).
Main Functions: notify_checkpoint_pending(shift_id, date_key) versi baru,
                notify_shift_wrapup(shift_id, date_key) versi baru.
Side Effects: CREATE OR REPLACE FUNCTION (perilaku sama, hanya ganti sumber definisi
              checkpoint). Tidak menyentuh jadwal cron — cukup ganti body fungsi.

Latar: ship_checkpoints kosong di produksi karena klien menyimpan titik patroli di
ships.custom_checkpoints (lihat perbaikan finalize_shift di 202605290002). Versi lama
notify_checkpoint_pending & notify_shift_wrapup (202605300002) mensyaratkan baris di
ship_checkpoints untuk mengiterasi kapal, sehingga loop tidak pernah jalan dan TIDAK
ADA satu pun notifikasi yang ter-insert (in-app maupun push). Versi ini:
  - iterasi kapal lewat ships.custom_checkpoints (array non-kosong),
  - hitung total/pending checkpoint dari elemen JSONB (dengan ordinality untuk urutan),
  - cocokkan laporan TERUTAMA via nama checkpoint ternormalisasi (tahan beda id
    antar-device), dengan fallback ke id checkpoint runtime klien `${shipId}::slug::index`.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- Fungsi 1: notify_checkpoint_pending (sumber: ships.custom_checkpoints)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.notify_checkpoint_pending(p_shift_id text, p_date_key text)
returns int
language plpgsql
security definer
as $$
declare
  v_shift_key      text;
  v_shift_label    text;
  v_time_range     text;
  v_ship           record;
  v_cp             record;
  v_pending_count  int;
  v_total_count    int;
  v_cp_id          text;
  v_slug           text;
  v_cp_name_key    text;
  v_user_ids       text[];
  v_admin_ids      text[];
  v_admin_lines    text[];
  v_admin_body     text;
  v_base_id        text;
  v_notif_at       timestamptz;
  v_total_inserted int := 0;
begin
  v_shift_key := p_date_key || '|' || p_shift_id;
  v_notif_at  := now();

  v_shift_label := case p_shift_id
    when 'shift-1-active' then 'Shift 1'
    when 'shift-2-active' then 'Shift 2'
    when 'shift-3-active' then 'Shift 3'
    else p_shift_id
  end;
  v_time_range := case p_shift_id
    when 'shift-1-active' then '06:00 - 12:00'
    when 'shift-2-active' then '12:00 - 18:00'
    when 'shift-3-active' then '18:00 - 06:00'
    else ''
  end;

  -- Kumpulkan ID semua admin aktif
  select array_agg(p.id) into v_admin_ids
  from public.profiles p
  where p.enabled = true
    and p.review_state = 'approved'
    and p.role = 'ADMIN';

  v_admin_lines := ARRAY[]::text[];

  -- Iterasi kapal yang punya definisi checkpoint di custom_checkpoints
  for v_ship in
    select s.id, s.name, s.custom_checkpoints
    from public.ships s
    where jsonb_typeof(s.custom_checkpoints) = 'array'
      and jsonb_array_length(s.custom_checkpoints) > 0
    order by s.name
  loop
    v_total_count := jsonb_array_length(v_ship.custom_checkpoints);
    if v_total_count = 0 then continue; end if;

    -- Hitung checkpoint yang BELUM selesai di shift ini.
    -- Cocokkan laporan completed via nama ternormalisasi (utama) atau id runtime (fallback).
    v_pending_count := 0;
    for v_cp in
      select
        elem.value ->> 'name' as cp_name,
        elem.idx              as cp_index
      from jsonb_array_elements(v_ship.custom_checkpoints) with ordinality as elem(value, idx)
    loop
      v_slug := regexp_replace(
                  regexp_replace(lower(coalesce(v_cp.cp_name, '')), '[^a-z0-9]+', '-', 'g'),
                  '(^-|-$)', '', 'g');
      if v_slug = '' then
        v_slug := 'checkpoint-' || v_cp.cp_index;
      end if;
      v_cp_id := v_ship.id || '::' || v_slug || '::' || v_cp.cp_index;
      v_cp_name_key := regexp_replace(lower(btrim(coalesce(v_cp.cp_name, ''))), '\s+', ' ', 'g');

      if not exists (
        select 1 from public.patrol_reports pr
        where pr.shift_key = v_shift_key
          and pr.ship_id   = v_ship.id
          and pr.status    = 'completed'
          and (
            regexp_replace(lower(btrim(pr.checkpoint_name)), '\s+', ' ', 'g') = v_cp_name_key
            or pr.checkpoint_id = v_cp_id
          )
      ) then
        v_pending_count := v_pending_count + 1;
      end if;
    end loop;

    if v_pending_count = 0 then continue; end if;

    -- Tambahkan ke baris summary admin
    v_admin_lines := v_admin_lines
      || format('🚢 %s: %s titik belum dilaporkan', v_ship.name, v_pending_count);

    -- Kumpulkan PIC + Petugas aktif kapal ini
    select array_agg(p.id) into v_user_ids
    from public.profiles p
    where p.enabled = true
      and p.review_state = 'approved'
      and p.ship_assigned = v_ship.name
      and (
        (p.role = 'PETUGAS' and p.status = 'active')
        or p.role = 'PIC'
      );

    if v_user_ids is null or array_length(v_user_ids, 1) = 0 then continue; end if;

    v_base_id := 'checkpoint-pending:' || v_ship.name || ':' || v_shift_key;

    v_total_inserted := v_total_inserted + public.insert_notification_fanout(
      p_base_id    => v_base_id,
      p_user_ids   => v_user_ids,
      p_ship_name  => v_ship.name,
      p_type       => 'checkpoint_pending',
      p_title      => '⚠️ Checkpoint belum tuntas',
      p_body       => format(
        '⚠️ Masih ada %s dari %s titik patroli belum diisi di 🚢 %s. Segera selesaikan sebelum shift berakhir.',
        v_pending_count, v_total_count, v_ship.name
      ),
      p_route      => 'patrol/checkpoint',
      p_shift_key  => v_shift_key,
      p_created_at => v_notif_at
    );
  end loop;

  -- Admin summary: 1 notif yang mencakup semua kapal dengan pending
  if v_admin_ids is not null
    and array_length(v_admin_ids, 1) > 0
    and array_length(v_admin_lines, 1) > 0
  then
    v_admin_body := format(
      '⚠️ Masih terdapat CHECKPOINT PENDING pada %s (%s) —%s%s',
      v_shift_label,
      v_time_range,
      E'\n',
      array_to_string(v_admin_lines, E'\n')
    );
    v_base_id := 'checkpoint-pending-summary:' || v_shift_key;

    v_total_inserted := v_total_inserted + public.insert_notification_fanout(
      p_base_id    => v_base_id,
      p_user_ids   => v_admin_ids,
      p_ship_name  => null,
      p_type       => 'checkpoint_pending_summary',
      p_title      => format('⏳ Checkpoint pending — %s %s', v_shift_label, v_time_range),
      p_body       => v_admin_body,
      p_route      => 'history/list',
      p_shift_key  => v_shift_key,
      p_created_at => v_notif_at
    );
  end if;

  return v_total_inserted;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fungsi 2: notify_shift_wrapup (sumber: ships.custom_checkpoints + shift_history_entries)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.notify_shift_wrapup(p_shift_id text, p_date_key text)
returns int
language plpgsql
security definer
as $$
declare
  v_shift_key      text;
  v_shift_label    text;
  v_time_range     text;
  v_ship           record;
  v_aman           int;
  v_temuan         int;
  v_missed         int;
  v_total          int;
  v_user_ids       text[];
  v_admin_ids      text[];
  v_admin_lines    text[];
  v_admin_body     text;
  v_pic_body       text;
  v_base_id        text;
  v_notif_at       timestamptz;
  v_total_inserted int := 0;
begin
  v_shift_key := p_date_key || '|' || p_shift_id;
  v_notif_at  := now();

  v_shift_label := case p_shift_id
    when 'shift-1-active' then 'Shift 1'
    when 'shift-2-active' then 'Shift 2'
    when 'shift-3-active' then 'Shift 3'
    else p_shift_id
  end;
  v_time_range := case p_shift_id
    when 'shift-1-active' then '06:00 - 12:00'
    when 'shift-2-active' then '12:00 - 18:00'
    when 'shift-3-active' then '18:00 - 06:00'
    else ''
  end;

  -- Kumpulkan ID semua admin aktif
  select array_agg(p.id) into v_admin_ids
  from public.profiles p
  where p.enabled = true
    and p.review_state = 'approved'
    and p.role = 'ADMIN';

  v_admin_lines := ARRAY[]::text[];

  -- Iterasi kapal yang punya definisi checkpoint di custom_checkpoints
  for v_ship in
    select s.id, s.name, s.custom_checkpoints
    from public.ships s
    where jsonb_typeof(s.custom_checkpoints) = 'array'
      and jsonb_array_length(s.custom_checkpoints) > 0
    order by s.name
  loop
    -- Coba baca dari shift_history_entries (sudah difinalisasi finalize_shift)
    select she.aman_count, she.temuan_count, she.missed_count, she.total_count
    into v_aman, v_temuan, v_missed, v_total
    from public.shift_history_entries she
    where she.shift_key = v_shift_key
      and she.ship_id   = v_ship.id;

    if not found then
      -- Fallback: hitung langsung dari patrol_reports (kapal belum ada history entry)
      v_total := jsonb_array_length(v_ship.custom_checkpoints);
      if v_total = 0 then continue; end if;

      -- Hanya lanjut jika ada setidaknya 1 laporan di shift ini
      if not exists (
        select 1 from public.patrol_reports
        where shift_key = v_shift_key and ship_id = v_ship.id
      ) then continue; end if;

      select
        count(*) filter (where pr.status = 'completed' and coalesce(pr.result_type, 'aman') = 'aman'),
        count(*) filter (where pr.status = 'completed' and pr.result_type = 'temuan'),
        greatest(0, v_total - count(*) filter (where pr.status = 'completed'))
      into v_aman, v_temuan, v_missed
      from public.patrol_reports pr
      where pr.shift_key = v_shift_key
        and pr.ship_id   = v_ship.id;
    end if;

    -- Susun ringkasan per kapal
    v_admin_lines := v_admin_lines
      || format('🚢 %s: ✅ %s Aman, ⚠️ %s Temuan, ❌ %s Missed (total %s)',
                v_ship.name, v_aman, v_temuan, v_missed, v_total);

    -- Notif untuk PIC kapal ini
    select array_agg(p.id) into v_user_ids
    from public.profiles p
    where p.enabled = true
      and p.review_state = 'approved'
      and p.role = 'PIC'
      and p.ship_assigned = v_ship.name;

    if v_user_ids is not null and array_length(v_user_ids, 1) > 0 then
      v_pic_body := format(
        '📋 Laporan Ringkasan Patroli %s (%s)%s🚢 %s: ✅ %s Aman, ⚠️ %s Temuan, ❌ %s Missed (total %s)',
        v_shift_label, v_time_range,
        E'\n',
        v_ship.name, v_aman, v_temuan, v_missed, v_total
      );
      v_base_id := 'shift-wrapup:' || v_ship.name || ':' || v_shift_key;

      v_total_inserted := v_total_inserted + public.insert_notification_fanout(
        p_base_id    => v_base_id,
        p_user_ids   => v_user_ids,
        p_ship_name  => v_ship.name,
        p_type       => 'shift_wrap_up',
        p_title      => format('📋 Shift selesai — %s %s', v_shift_label, v_ship.name),
        p_body       => v_pic_body,
        p_route      => 'history/list',
        p_shift_key  => v_shift_key,
        p_created_at => v_notif_at
      );
    end if;
  end loop;

  -- Admin: 1 summary semua kapal
  if v_admin_ids is not null
    and array_length(v_admin_ids, 1) > 0
    and array_length(v_admin_lines, 1) > 0
  then
    v_admin_body := format(
      '📋 Laporan Ringkasan Patroli %s (%s)%s%s',
      v_shift_label,
      v_time_range,
      E'\n',
      array_to_string(v_admin_lines, E'\n')
    );
    v_base_id := 'shift-wrapup-admin:' || v_shift_key;

    v_total_inserted := v_total_inserted + public.insert_notification_fanout(
      p_base_id    => v_base_id,
      p_user_ids   => v_admin_ids,
      p_ship_name  => null,
      p_type       => 'shift_wrap_up',
      p_title      => format('📋 Shift Wrap-Up — %s %s', v_shift_label, v_time_range),
      p_body       => v_admin_body,
      p_route      => 'history/list',
      p_shift_key  => v_shift_key,
      p_created_at => v_notif_at
    );
  end if;

  return v_total_inserted;
end;
$$;
