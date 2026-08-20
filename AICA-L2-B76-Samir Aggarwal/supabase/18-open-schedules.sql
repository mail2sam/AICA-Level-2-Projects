-- =====================================================================
--  FILE 18 : Staff may create their own recurring schedules
--
--  The Add Task dialog now offers "Repeats: daily/weekly/monthly…", which
--  creates a schedule — but schedules were admin-only to write. Consistent
--  with open assignment: anyone may CREATE a schedule (recorded as its
--  creator, unfakeably); editing and deleting stay with the creator or an
--  admin.
--
--  Run any time. Safe to re-run.
-- =====================================================================

drop policy if exists ra_admin_write on public.recurring_assignments;

drop policy if exists ra_insert on public.recurring_assignments;
create policy ra_insert on public.recurring_assignments
  for insert to authenticated
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists ra_update on public.recurring_assignments;
create policy ra_update on public.recurring_assignments
  for update to authenticated
  using (created_by = auth.uid() or public.is_admin())
  with check (created_by = auth.uid() or public.is_admin());

drop policy if exists ra_delete on public.recurring_assignments;
create policy ra_delete on public.recurring_assignments
  for delete to authenticated
  using (created_by = auth.uid() or public.is_admin());

-- Verify:
--   select policyname from pg_policies
--   where tablename = 'recurring_assignments' order by 1;
--   -> ra_delete, ra_insert, ra_select, ra_update
