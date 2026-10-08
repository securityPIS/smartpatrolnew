/*
Tujuan: Jadwal penugasan petugas security per kapal per bulan (halaman Jadwal Penugasan).
Caller: SPA admin (upsert ships.personnel_monthly_plan, RPC apply_personnel_monthly_plan) dan pg_cron harian.
Dependensi: tabel ships & profiles, helper public.is_admin(), pg_cron (opsional).
Main Functions:
  - ships.personnel_monthly_plan jsonb: { "applied": "YYYY-MM", "months": { "YYYY-MM": [{userId,startDate,endDate}] } }
  - apply_personnel_monthly_plan(p_today):
      1. Pergantian bulan: kapal dengan applied < bulan berjalan mendapat susunan baru
         (rencana eksplisit > "Next Assignment" lama > warisan bulan lalu yang periodenya belum selesai),
         eksklusif lintas kapal. Susunan bulan lalu disimpan sebagai riwayat (months[bulan lalu]).
      2. Mulai tugas terjadwal: personnel_next_month dengan startDate <= hari ini pindah ke personnel.
      3. Rekonsiliasi profiles PETUGAS yang tersentuh (status active/off-duty + ship_assigned),
         sumber kebenaran akses operasional (resolve-operational-access).
  - cron 'apply-personnel-monthly-plan' tiap 00:05 WIB.
Aturan yang sama diimplementasikan di src/utils/personnelSchedule.js (buildFleetRoster) — jaga tetap sinkron.
Side Effects: Update ships.personnel*, profiles.status/ship_assigned, insert client_mutations (memicu refetch klien).
*/

alter table public.ships
  add column if not exists personnel_monthly_plan jsonb not null default '{}'::jsonb;

create or replace function public.personnel_plan_date_or_blank(p_value text)
returns text
language sql
immutable
as $$
  select case
    when p_value ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$' then p_value
    else ''
  end
$$;

create or replace function public.apply_personnel_monthly_plan(p_today date default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := coalesce(p_today, (now() at time zone 'Asia/Jakarta')::date);
  v_today_key text := to_char(coalesce(p_today, (now() at time zone 'Asia/Jakarta')::date), 'YYYY-MM-DD');
  v_cur text := to_char(coalesce(p_today, (now() at time zone 'Asia/Jakarta')::date), 'YYYY-MM');
  v_cur_start_key text;
  v_cur_end_key text;
  v_prev_month text;
  v_oldest_kept text;
  v_changed integer := 0;
  v_touched text[] := '{}';
  v_ship record;
  v_months jsonb;
  v_snapshot jsonb;
  v_new_personnel jsonb;
  v_new_next jsonb;
  v_new_schedules jsonb;
  v_rows integer := 0;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Hanya admin yang dapat menerapkan jadwal penugasan.' using errcode = '42501';
  end if;

  -- Notice "drop table if exists" tidak perlu membanjiri log cron.
  perform set_config('client_min_messages', 'warning', true);

  -- Cegah dua eksekusi (cron + admin) saling tumpuk.
  perform pg_advisory_xact_lock(hashtext('apply_personnel_monthly_plan'));

  v_cur_start_key := to_char(date_trunc('month', v_today), 'YYYY-MM-DD');
  v_cur_end_key := to_char(date_trunc('month', v_today) + interval '1 month' - interval '1 day', 'YYYY-MM-DD');
  v_prev_month := to_char(date_trunc('month', v_today) - interval '1 month', 'YYYY-MM');
  v_oldest_kept := to_char(date_trunc('month', v_today) - interval '12 months', 'YYYY-MM');

  -- ───────────── 1. Pergantian bulan ─────────────
  drop table if exists _sp_rolling;
  create temp table _sp_rolling on commit drop as
    select s.id, s.name, s.personnel, s.personnel_next_month, s.personnel_schedules,
           case when jsonb_typeof(s.personnel_monthly_plan -> 'months') = 'object'
                then s.personnel_monthly_plan -> 'months' else '{}'::jsonb end as months
    from public.ships s
    where (s.personnel_monthly_plan ->> 'applied') ~ '^\d{4}-\d{2}$'
      and (s.personnel_monthly_plan ->> 'applied') < v_cur;

  if exists (select 1 from _sp_rolling) then
    perform 1 from public.ships s where s.id in (select r.id from _sp_rolling r) for update;

    drop table if exists _sp_candidates;
    create temp table _sp_candidates (
      ship_id text, ship_name text, user_id text, start_date text, end_date text, prio int, ord bigint
    ) on commit drop;

    -- Prioritas 1: rencana eksplisit bulan berjalan.
    insert into _sp_candidates
    select r.id, r.name, e.value ->> 'userId',
           public.personnel_plan_date_or_blank(e.value ->> 'startDate'),
           public.personnel_plan_date_or_blank(e.value ->> 'endDate'),
           1, e.ordinality
    from _sp_rolling r
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(r.months -> v_cur) = 'array' then r.months -> v_cur else '[]'::jsonb end
    ) with ordinality as e(value, ordinality)
    where coalesce(e.value ->> 'userId', '') <> '';

    -- Prioritas 2: "Next Assignment" lama yang mulai paling lambat akhir bulan ini.
    insert into _sp_candidates
    select r.id, r.name, u.value,
           public.personnel_plan_date_or_blank(r.personnel_schedules -> u.value ->> 'startDate'),
           case when (r.personnel_schedules -> u.value ->> 'isTBC') = 'true' then ''
                else public.personnel_plan_date_or_blank(r.personnel_schedules -> u.value ->> 'endDate') end,
           2, u.ordinality
    from _sp_rolling r
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(r.personnel_next_month) = 'array' then r.personnel_next_month else '[]'::jsonb end
    ) with ordinality as u(value, ordinality)
    where public.personnel_plan_date_or_blank(r.personnel_schedules -> u.value ->> 'startDate') <= v_cur_end_key;

    -- Prioritas 3: warisan bulan lalu (kapal tanpa rencana eksplisit), kecuali periode sudah selesai.
    insert into _sp_candidates
    select r.id, r.name, u.value, '',
           case when (r.personnel_schedules -> u.value ->> 'isTBC') = 'true' then ''
                else public.personnel_plan_date_or_blank(r.personnel_schedules -> u.value ->> 'endDate') end,
           3, u.ordinality
    from _sp_rolling r
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(r.personnel) = 'array' then r.personnel else '[]'::jsonb end
    ) with ordinality as u(value, ordinality)
    where jsonb_typeof(r.months -> v_cur) is distinct from 'array';

    delete from _sp_candidates c
    where c.prio = 3 and c.end_date <> '' and c.end_date < v_cur_start_key;

    -- Petugas yang sedang bertugas di kapal yang tidak ikut pergantian tetap di sana.
    delete from _sp_candidates c
    where exists (
      select 1 from public.ships s
      where s.id not in (select r.id from _sp_rolling r)
        and jsonb_typeof(s.personnel) = 'array'
        and s.personnel ? c.user_id
    );

    drop table if exists _sp_picked;
    create temp table _sp_picked on commit drop as
      select distinct on (c.user_id) c.*
      from _sp_candidates c
      order by c.user_id, c.prio, c.ship_name, c.ord;

    for v_ship in select * from _sp_rolling loop
      select coalesce(jsonb_agg(p.user_id order by p.prio, p.ord), '[]'::jsonb)
        into v_new_personnel
      from _sp_picked p
      where p.ship_id = v_ship.id and (p.start_date = '' or p.start_date <= v_today_key);

      -- Next Assignment lama untuk bulan-bulan berikutnya tetap dipertahankan.
      with future_legacy as (
        select u.value as user_id, u.ordinality
        from jsonb_array_elements_text(
          case when jsonb_typeof(v_ship.personnel_next_month) = 'array' then v_ship.personnel_next_month else '[]'::jsonb end
        ) with ordinality as u(value, ordinality)
        where public.personnel_plan_date_or_blank(v_ship.personnel_schedules -> u.value ->> 'startDate') > v_cur_end_key
          and not exists (select 1 from _sp_picked p where p.ship_id = v_ship.id and p.user_id = u.value)
      ),
      scheduled as (
        select p.user_id, p.prio, p.ord from _sp_picked p
        where p.ship_id = v_ship.id and p.start_date > v_today_key
      )
      select
        coalesce((select jsonb_agg(s.user_id order by s.prio, s.ord) from scheduled s), '[]'::jsonb)
          || coalesce((select jsonb_agg(f.user_id order by f.ordinality) from future_legacy f), '[]'::jsonb),
        coalesce((
          select jsonb_object_agg(f.user_id, v_ship.personnel_schedules -> f.user_id)
          from future_legacy f where v_ship.personnel_schedules ? f.user_id
        ), '{}'::jsonb)
          || coalesce((
            select jsonb_object_agg(p.user_id, jsonb_build_object(
              'startDate', p.start_date, 'endDate', p.end_date, 'isTBC', false))
            from _sp_picked p where p.ship_id = v_ship.id
          ), '{}'::jsonb)
      into v_new_next, v_new_schedules;

      -- Riwayat: susunan yang berjalan sampai akhir bulan lalu.
      select coalesce(jsonb_agg(jsonb_build_object(
               'userId', u.value,
               'startDate', public.personnel_plan_date_or_blank(v_ship.personnel_schedules -> u.value ->> 'startDate'),
               'endDate', case when (v_ship.personnel_schedules -> u.value ->> 'isTBC') = 'true' then ''
                               else public.personnel_plan_date_or_blank(v_ship.personnel_schedules -> u.value ->> 'endDate') end
             ) order by u.ordinality), '[]'::jsonb)
        into v_snapshot
      from jsonb_array_elements_text(
        case when jsonb_typeof(v_ship.personnel) = 'array' then v_ship.personnel else '[]'::jsonb end
      ) with ordinality as u(value, ordinality);

      select coalesce(jsonb_object_agg(m.key, m.value), '{}'::jsonb)
        into v_months
      from jsonb_each(v_ship.months) m
      where m.key >= v_oldest_kept and m.key <> v_prev_month;
      v_months := v_months || jsonb_build_object(v_prev_month, v_snapshot);

      update public.ships s
      set personnel = v_new_personnel,
          personnel_next_month = v_new_next,
          personnel_schedules = v_new_schedules,
          personnel_monthly_plan = jsonb_build_object('applied', v_cur, 'months', v_months)
      where s.id = v_ship.id;

      v_changed := v_changed + 1;
      v_touched := v_touched
        || array(select jsonb_array_elements_text(case when jsonb_typeof(v_ship.personnel) = 'array' then v_ship.personnel else '[]'::jsonb end))
        || array(select jsonb_array_elements_text(v_new_personnel))
        || array(select jsonb_array_elements_text(v_new_next));
    end loop;
  end if;

  -- ───────────── 2. Mulai tugas terjadwal (harian) ─────────────
  drop table if exists _sp_due;
  create temp table _sp_due on commit drop as
    select s.id as ship_id, s.name as ship_name, u.value as user_id, u.ordinality as ord
    from public.ships s
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(s.personnel_next_month) = 'array' then s.personnel_next_month else '[]'::jsonb end
    ) with ordinality as u(value, ordinality)
    where public.personnel_plan_date_or_blank(s.personnel_schedules -> u.value ->> 'startDate') <> ''
      and public.personnel_plan_date_or_blank(s.personnel_schedules -> u.value ->> 'startDate') <= v_today_key;

  if exists (select 1 from _sp_due) then
    drop table if exists _sp_due_winner;
    create temp table _sp_due_winner on commit drop as
      select distinct on (d.user_id) d.* from _sp_due d order by d.user_id, d.ship_name, d.ord;

    with affected as (
      select s.id,
        coalesce((
          select jsonb_agg(u.value order by u.ordinality)
          from jsonb_array_elements_text(case when jsonb_typeof(s.personnel) = 'array' then s.personnel else '[]'::jsonb end)
            with ordinality as u(value, ordinality)
          where not exists (select 1 from _sp_due_winner w where w.user_id = u.value and w.ship_id <> s.id)
        ), '[]'::jsonb) as kept_personnel,
        coalesce((
          select jsonb_agg(w.user_id order by w.ord) from _sp_due_winner w
          where w.ship_id = s.id
            and not (case when jsonb_typeof(s.personnel) = 'array' then s.personnel else '[]'::jsonb end) ? w.user_id
        ), '[]'::jsonb) as added_personnel,
        coalesce((
          select jsonb_agg(u.value order by u.ordinality)
          from jsonb_array_elements_text(case when jsonb_typeof(s.personnel_next_month) = 'array' then s.personnel_next_month else '[]'::jsonb end)
            with ordinality as u(value, ordinality)
          where not exists (select 1 from _sp_due d where d.ship_id = s.id and d.user_id = u.value)
        ), '[]'::jsonb) as kept_next
      from public.ships s
      where s.id in (select d.ship_id from _sp_due d)
         or exists (
           select 1 from _sp_due_winner w
           where w.ship_id <> s.id and jsonb_typeof(s.personnel) = 'array' and s.personnel ? w.user_id
         )
    )
    update public.ships s
    set personnel = a.kept_personnel || a.added_personnel,
        personnel_next_month = a.kept_next
    from affected a
    where s.id = a.id
      and (s.personnel is distinct from a.kept_personnel || a.added_personnel
           or s.personnel_next_month is distinct from a.kept_next);

    get diagnostics v_rows = row_count;
    if v_rows > 0 then
      v_changed := v_changed + v_rows;
      v_touched := v_touched || array(select d.user_id from _sp_due d);
    end if;
  end if;

  -- ───────────── 3. Rekonsiliasi akses operasional PETUGAS ─────────────
  if coalesce(array_length(v_touched, 1), 0) > 0 then
    update public.profiles p
    set status = 'active', ship_assigned = t.ship_name
    from (
      select distinct on (u.value) u.value as user_id, s.name as ship_name
      from public.ships s
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(s.personnel) = 'array' then s.personnel else '[]'::jsonb end
      ) as u(value)
      where u.value = any(v_touched)
      order by u.value, s.name
    ) t
    where p.id = t.user_id
      and p.role = 'PETUGAS'
      and p.status <> 'disabled'
      and (p.status <> 'active' or p.ship_assigned is distinct from t.ship_name);

    update public.profiles p
    set status = 'off-duty', ship_assigned = null
    where p.id = any(v_touched)
      and p.role = 'PETUGAS'
      and p.status = 'active'
      and not exists (
        select 1 from public.ships s
        where jsonb_typeof(s.personnel) = 'array' and s.personnel ? p.id
      );
  end if;

  if v_changed > 0 then
    insert into public.client_mutations (client_event_id, mutation_type, client_updated_at_ms, payload)
    values (
      'personnel-plan-' || v_today_key || '-' || floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
      'state-sync',
      floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
      jsonb_build_object('reason', 'personnel-plan-applied', 'ships', v_changed, 'month', v_cur)
    )
    on conflict (client_event_id) do nothing;
  end if;

  return v_changed;
end;
$$;

revoke all on function public.apply_personnel_monthly_plan(date) from public;
revoke all on function public.apply_personnel_monthly_plan(date) from anon;
grant execute on function public.apply_personnel_monthly_plan(date) to authenticated;

-- pg_cron: 00:05 WIB = 17:05 UTC. Dibungkus agar migration tetap jalan bila pg_cron tidak tersedia.
do $$
begin
  perform cron.unschedule(jobname) from cron.job where jobname = 'apply-personnel-monthly-plan';
  perform cron.schedule(
    'apply-personnel-monthly-plan',
    '5 17 * * *',
    $cron$select public.apply_personnel_monthly_plan()$cron$
  );
exception when others then
  raise notice 'pg_cron tidak tersedia, jadwal apply-personnel-monthly-plan dilewati: %', sqlerrm;
end $$;
