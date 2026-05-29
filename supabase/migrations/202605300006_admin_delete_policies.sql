-- Izinkan admin menghapus baris patrol_reports (temuan patroli yang dihapus admin harus
-- benar-benar hilang dari DB agar tidak muncul kembali saat realtime subscription re-fetch).
drop policy if exists "patrol_reports_admin_delete" on public.patrol_reports;
create policy "patrol_reports_admin_delete" on public.patrol_reports
for delete to authenticated
using (public.is_admin());

-- Izinkan admin menghapus baris sos_alerts (hapus SOS dari tampilan admin harus
-- menghapus record di DB agar tidak muncul kembali lewat realtime).
drop policy if exists "sos_alerts_admin_delete" on public.sos_alerts;
create policy "sos_alerts_admin_delete" on public.sos_alerts
for delete to authenticated
using (public.is_admin());
