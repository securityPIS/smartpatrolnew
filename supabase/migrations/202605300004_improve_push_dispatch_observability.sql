/*
Tujuan: Membuat kegagalan dispatch web push TIDAK lagi senyap.
Latar:  dispatch_push_for_notification() (migration 202605300003) langsung
        `return new` tanpa log saat private.app_config.functions_url kosong,
        sehingga "in-app masuk tapi push tidak terkirim" sulit didiagnosis.
Caller: Supabase migration runner.
Dependensi: migration 202605300003 (tabel push_subscriptions + trigger),
            pg_net, private.app_config (functions_url, cron_secret).
Main Functions: Ganti fungsi trigger agar menulis RAISE NOTICE pada tiap cabang
        (config belum di-set / dispatch terkirim), seperti pola trigger resign-cron.
Side Effects: CREATE OR REPLACE FUNCTION (perilaku identik, hanya menambah log).
*/

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
    -- Config belum di-set; jangan gagalkan insert notifikasi, tapi JANGAN senyap:
    -- inilah sebab umum "in-app masuk tapi push tidak muncul".
    raise notice '[send-push] private.app_config.functions_url belum dikonfigurasi — push untuk notifikasi % dilewati.', new.id;
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

  raise notice '[send-push] dispatch dikirim untuk notifikasi % (target %).', new.id, new.target_user_id;
  return new;
exception when others then
  -- Web push bersifat best-effort: jangan pernah menggagalkan insert notifikasi.
  raise notice '[send-push] gagal dispatch untuk notifikasi %: %', new.id, sqlerrm;
  return new;
end;
$$;

-- Trigger sudah ada (migration 202605300003); cukup pastikan terpasang ke fungsi terbaru.
drop trigger if exists dispatch_push_after_insert on public.notifications;
create trigger dispatch_push_after_insert
  after insert on public.notifications
  for each row execute function public.dispatch_push_for_notification();
