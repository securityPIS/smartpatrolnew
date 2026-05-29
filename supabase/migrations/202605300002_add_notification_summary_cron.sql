/*
Tujuan: Fungsi SQL dan cron job untuk notifikasi summary berkala:
  1. notify_checkpoint_pending(shift_id, date_key)
     – Berjalan 1 jam sebelum shift berakhir
     – Admin: 1 notif summary semua kapal yang punya pending checkpoint
     – PIC & Petugas: 1 notif per kapal dengan hitungan pending
  2. notify_shift_wrapup(shift_id, date_key)
     – Berjalan 2 menit setelah shift berakhir (setelah finalize_shift)
     – Admin: 1 notif ringkasan aman/temuan/missed seluruh kapal
     – PIC: 1 notif ringkasan kapalnya sendiri
Caller: pg_cron (6 job: 3 checkpoint-pending + 3 shift-wrapup)
Dependensi: pg_cron, shift_history_entries (diisi finalize_shift), patrol_reports,
            ship_checkpoints, profiles, notifications.
Side Effects: Upsert ke public.notifications; idempoten via ON CONFLICT DO NOTHING.
*/

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: deriveNotificationTone (paralel dengan fungsi frontend)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.derive_notification_tone(p_type text)
returns text
language sql
immutable
as $$
  select case
    when p_type in ('sos', 'sos_triggered') or p_type like 'sos%' then 'critical'
    when p_type in ('checkpoint_pending', 'checkpoint_pending_summary',
                    'checkpoint_missed', 'registration_pending')
         or p_type like 'incident%' then 'warning'
    when p_type in ('shift_wrap_up', 'shift_started', 'shift_ending_soon',
                    'shift_history_created') then 'info'
    when p_type in ('welcome_to_ship', 'registration_approved') then 'success'
    else 'info'
  end
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: fan-out insert satu baris per penerima
-- Idempoten via ON CONFLICT (id) DO NOTHING — tidak menimpa data yang sudah ada.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.insert_notification_fanout(
  p_base_id     text,
  p_user_ids    text[],
  p_ship_name   text,
  p_type        text,
  p_title       text,
  p_body        text,
  p_route       text,
  p_shift_key   text,
  p_created_at  timestamptz
)
returns int
language plpgsql
security definer
as $$
declare
  v_uid   text;
  v_count int := 0;
  v_tone  text;
  v_payload jsonb;
begin
  v_tone := public.derive_notification_tone(p_type);

  v_payload := jsonb_build_object(
    'id',         p_base_id,
    'baseId',     p_base_id,
    'type',       p_type,
    'title',      p_title,
    'message',    p_body,
    'senderName', 'Sistem',
    'senderRole', 'SYSTEM',
    'route',      p_route,
    'shipName',   coalesce(p_ship_name, ''),
    'shiftKey',   coalesce(p_shift_key, ''),
    'dedupeKey',  p_base_id,
    'createdAt',  to_char(p_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );

  foreach v_uid in array p_user_ids loop
    insert into public.notifications (
      id, target_user_id, ship_name,
      type, title, body, tone, read, payload, created_at
    ) values (
      p_base_id || '::' || v_uid,
      v_uid,
      p_ship_name,
      p_type,
      p_title,
      p_body,
      v_tone,
      false,
      v_payload,
      p_created_at
    )
    on conflict (id) do nothing;

    if found then v_count := v_count + 1; end if;
  end loop;

  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Fungsi 1: notify_checkpoint_pending
-- Dipanggil 1 jam sebelum shift berakhir.
-- Admin mendapat 1 summary notif (semua kapal yang punya pending).
-- PIC & Petugas aktif setiap kapal mendapat 1 notif (kapalnya saja).
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
  v_pending_count  int;
  v_total_count    int;
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

  -- Iterasi semua kapal yang punya checkpoint aktif
  for v_ship in
    select s.id, s.name
    from public.ships s
    where exists (
      select 1 from public.ship_checkpoints sc
      where sc.ship_id = s.id and sc.active = true
    )
    order by s.name
  loop
    -- Total checkpoint aktif kapal ini
    select count(*) into v_total_count
    from public.ship_checkpoints
    where ship_id = v_ship.id and active = true;

    if v_total_count = 0 then continue; end if;

    -- Checkpoint yang BELUM selesai di shift ini
    select count(*) into v_pending_count
    from public.ship_checkpoints sc
    where sc.ship_id = v_ship.id
      and sc.active = true
      and not exists (
        select 1 from public.patrol_reports pr
        where pr.shift_key   = v_shift_key
          and pr.ship_id     = sc.ship_id
          and pr.checkpoint_id = sc.id
          and pr.status      = 'completed'
      );

    if v_pending_count = 0 then continue; end if;

    -- Tambahkan ke baris summary admin
    v_admin_lines := v_admin_lines
      || format('%s: %s/%s titik belum selesai', v_ship.name, v_pending_count, v_total_count);

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
      p_title      => 'Checkpoint belum tuntas',
      p_body       => format(
        'Masih ada %s dari %s titik patroli belum diisi di %s. Segera selesaikan sebelum shift berakhir.',
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
      'CHECKPOINT PENDING %s (%s) — 1 jam sebelum shift berakhir:%s%s',
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
      p_title      => format('Checkpoint pending — %s %s', v_shift_label, v_time_range),
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
-- Fungsi 2: notify_shift_wrapup
-- Dipanggil 2 menit setelah shift berakhir (setelah finalize_shift selesai).
-- Membaca shift_history_entries; fallback ke patrol_reports bila belum terisi.
-- Admin mendapat 1 notif summary semua kapal.
-- PIC mendapat 1 notif ringkasan kapalnya.
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
  v_entry          record;
  v_aman           int;
  v_temuan         int;
  v_missed         int;
  v_total          int;
  v_user_ids       text[];
  v_admin_ids      text[];
  v_pic_lines      text[];
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

  -- Iterasi semua kapal
  for v_ship in
    select s.id, s.name
    from public.ships s
    where exists (
      select 1 from public.ship_checkpoints sc
      where sc.ship_id = s.id and sc.active = true
    )
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
      select count(*) into v_total
      from public.ship_checkpoints
      where ship_id = v_ship.id and active = true;

      if v_total = 0 then continue; end if;

      -- Hanya lanjut jika ada setidaknya 1 laporan di shift ini
      if not exists (
        select 1 from public.patrol_reports
        where shift_key = v_shift_key and ship_id = v_ship.id
      ) then continue; end if;

      select
        count(*) filter (where pr.status = 'completed' and coalesce(pr.result_type, 'aman') = 'aman'),
        count(*) filter (where pr.status = 'completed' and pr.result_type = 'temuan'),
        (v_total - count(*) filter (where pr.status = 'completed'))
      into v_aman, v_temuan, v_missed
      from public.patrol_reports pr
      where pr.shift_key = v_shift_key
        and pr.ship_id   = v_ship.id;
    end if;

    -- Susun ringkasan per kapal
    v_admin_lines := v_admin_lines
      || format('%s: %s Aman, %s Temuan, %s Missed (total %s)',
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
        'REKAP %s (%s) — %s%s%s Aman  |  %s Temuan  |  %s Missed%sDari total %s titik patroli.',
        v_shift_label, v_time_range, v_ship.name,
        E'\n',
        v_aman, v_temuan, v_missed,
        E'\n',
        v_total
      );
      v_base_id := 'shift-wrapup:' || v_ship.name || ':' || v_shift_key;

      v_total_inserted := v_total_inserted + public.insert_notification_fanout(
        p_base_id    => v_base_id,
        p_user_ids   => v_user_ids,
        p_ship_name  => v_ship.name,
        p_type       => 'shift_wrap_up',
        p_title      => format('Shift selesai — %s %s', v_shift_label, v_ship.name),
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
      'SHIFT WRAP-UP %s (%s)%s%s',
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
      p_title      => format('Shift Wrap-Up — %s %s', v_shift_label, v_time_range),
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
-- pg_cron jobs
-- Semua waktu UTC. WIB = UTC+7.
--
-- Checkpoint pending (1 jam sebelum shift berakhir):
--   Shift 1: 11:00 WIB → 04:00 UTC
--   Shift 2: 17:00 WIB → 10:00 UTC
--   Shift 3: 05:00 WIB → 22:00 UTC (hari sebelumnya UTC)
--
-- Shift wrap-up (2 menit setelah shift berakhir, setelah finalize_shift):
--   Shift 1: 12:02 WIB → 05:02 UTC
--   Shift 2: 18:02 WIB → 11:02 UTC
--   Shift 3: 06:02 WIB → 23:02 UTC
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  perform cron.unschedule(jobname)
  from cron.job
  where jobname in (
    'notify-checkpoint-pending-shift-1',
    'notify-checkpoint-pending-shift-2',
    'notify-checkpoint-pending-shift-3',
    'notify-shift-wrapup-shift-1',
    'notify-shift-wrapup-shift-2',
    'notify-shift-wrapup-shift-3'
  );
exception when others then null;
end $$;

-- Checkpoint pending — Shift 1 (04:00 UTC)
select cron.schedule(
  'notify-checkpoint-pending-shift-1',
  '0 4 * * *',
  $$select public.notify_checkpoint_pending(
    'shift-1-active',
    to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD')
  )$$
);

-- Checkpoint pending — Shift 2 (10:00 UTC)
select cron.schedule(
  'notify-checkpoint-pending-shift-2',
  '0 10 * * *',
  $$select public.notify_checkpoint_pending(
    'shift-2-active',
    to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD')
  )$$
);

-- Checkpoint pending — Shift 3 (22:00 UTC; saat 05:00 WIB esok, date_key = hari ini WIB - 1)
select cron.schedule(
  'notify-checkpoint-pending-shift-3',
  '0 22 * * *',
  $$select public.notify_checkpoint_pending(
    'shift-3-active',
    to_char((now() at time zone 'Asia/Jakarta')::date - 1, 'YYYY-MM-DD')
  )$$
);

-- Shift wrap-up — Shift 1 (05:02 UTC)
select cron.schedule(
  'notify-shift-wrapup-shift-1',
  '2 5 * * *',
  $$select public.notify_shift_wrapup(
    'shift-1-active',
    to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD')
  )$$
);

-- Shift wrap-up — Shift 2 (11:02 UTC)
select cron.schedule(
  'notify-shift-wrapup-shift-2',
  '2 11 * * *',
  $$select public.notify_shift_wrapup(
    'shift-2-active',
    to_char(now() at time zone 'Asia/Jakarta', 'YYYY-MM-DD')
  )$$
);

-- Shift wrap-up — Shift 3 (23:02 UTC; date_key = hari WIB - 1, sama dengan finalize-shift-3)
select cron.schedule(
  'notify-shift-wrapup-shift-3',
  '2 23 * * *',
  $$select public.notify_shift_wrapup(
    'shift-3-active',
    to_char((now() at time zone 'Asia/Jakarta')::date - 1, 'YYYY-MM-DD')
  )$$
);
