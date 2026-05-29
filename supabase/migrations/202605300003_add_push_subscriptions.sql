/*
Tujuan: Web push notification berbasis FCM HTTP v1 untuk browser/PWA (tanpa Capacitor).
  - Tabel push_subscriptions menyimpan FCM registration token per user/device
  - Trigger AFTER INSERT pada notifications memanggil edge function send-push via pg_net
    sehingga notifikasi terkirim sebagai web push walau aplikasi/tab ditutup
Caller: Supabase migration runner; trigger dipicu setiap baris notifications baru.
Dependensi: pg_net, private.app_config (functions_url, cron_secret), edge function send-push,
            fungsi public.current_profile_id().
Side Effects: CREATE TABLE push_subscriptions; CREATE TRIGGER pada public.notifications.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SETUP (otomatis oleh workflow GitHub Actions):
  - private.app_config(functions_url, cron_secret) sudah diisi step "Konfigurasi database settings"
  - Edge function secret FCM_SERVICE_ACCOUNT & CRON_SECRET di-set workflow
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
*/

create extension if not exists pg_net;

-- ─────────────────────────────────────────────
-- 1. Tabel push_subscriptions
-- ─────────────────────────────────────────────
create table if not exists public.push_subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null references public.profiles(id) on delete cascade,
  fcm_token   text not null unique,
  user_agent  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id);

drop trigger if exists set_push_subscriptions_updated_at on public.push_subscriptions;
create trigger set_push_subscriptions_updated_at
  before update on public.push_subscriptions
  for each row execute function public.set_updated_at();

-- ─────────────────────────────────────────────
-- 2. RLS: user hanya boleh kelola token miliknya; admin & service penuh
-- ─────────────────────────────────────────────
alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions_owner_select" on public.push_subscriptions;
create policy "push_subscriptions_owner_select" on public.push_subscriptions
for select to authenticated
using (public.is_admin() or user_id = public.current_profile_id());

drop policy if exists "push_subscriptions_owner_insert" on public.push_subscriptions;
create policy "push_subscriptions_owner_insert" on public.push_subscriptions
for insert to authenticated
with check (user_id = public.current_profile_id());

drop policy if exists "push_subscriptions_owner_update" on public.push_subscriptions;
create policy "push_subscriptions_owner_update" on public.push_subscriptions
for update to authenticated
using (user_id = public.current_profile_id())
with check (user_id = public.current_profile_id());

drop policy if exists "push_subscriptions_owner_delete" on public.push_subscriptions;
create policy "push_subscriptions_owner_delete" on public.push_subscriptions
for delete to authenticated
using (public.is_admin() or user_id = public.current_profile_id());

-- ─────────────────────────────────────────────
-- 3. Fungsi pemicu: kirim 1 notifikasi (1 baris fan-out) ke edge function send-push
--    Hanya untuk baris yang benar-benar ter-insert (ON CONFLICT DO NOTHING tidak memicu),
--    punya target_user_id, dan belum dibaca.
-- ─────────────────────────────────────────────
create or replace function public.dispatch_push_for_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_functions_url text;
  v_cron_secret   text;
begin
  if new.target_user_id is null or new.read = true then
    return new;
  end if;

  select value into v_functions_url from private.app_config where key = 'functions_url';
  select value into v_cron_secret   from private.app_config where key = 'cron_secret';

  v_functions_url := coalesce(nullif(trim(v_functions_url), ''), '');
  v_cron_secret   := coalesce(v_cron_secret, '');

  if v_functions_url = '' then
    -- Config belum di-set; jangan gagalkan insert notifikasi.
    return new;
  end if;

  perform net.http_post(
    url     := v_functions_url || '/send-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'x-cron-secret', v_cron_secret
    ),
    body    := jsonb_build_object(
      'notificationId', new.id,
      'userId',         new.target_user_id,
      'type',           new.type,
      'title',          new.title,
      'body',           new.body,
      'shipName',       coalesce(new.ship_name, ''),
      'payload',        coalesce(new.payload, '{}'::jsonb)
    )
  );

  return new;
exception when others then
  -- Web push bersifat best-effort: jangan pernah menggagalkan insert notifikasi.
  raise notice '[send-push] gagal dispatch untuk notifikasi %: %', new.id, sqlerrm;
  return new;
end;
$$;

drop trigger if exists dispatch_push_after_insert on public.notifications;
create trigger dispatch_push_after_insert
  after insert on public.notifications
  for each row execute function public.dispatch_push_for_notification();
