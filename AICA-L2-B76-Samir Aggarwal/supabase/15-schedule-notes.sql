-- =====================================================================
--  FILE 15 : A schedule's notes become each generated task's description
--
--  A daily stock-entry schedule needs its checklist (RM in/out, FG in/out)
--  on every generated task. Previously generation copied only the master
--  task's generic description; now the schedule's own notes win when set.
--
--  Run AFTER 09. Safe to re-run.
-- =====================================================================

create or replace function public.generate_recurring_tasks(
  _period         text,
  _financial_year text,
  _due_date       date default null,
  _recurrence     text default null
)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_created integer := 0;
  v_stage   uuid;
  r         record;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an administrator can generate recurring tasks.';
  end if;

  if _period is null or btrim(_period) = '' then
    raise exception 'A period is required, for example "Apr-2026" or "14-Aug-2026".';
  end if;

  select id into v_stage from public.stages where code = '01';

  for r in
    select ra.id, ra.task_master_id, ra.client_id, ra.assigned_to, ra.created_by,
           ra.notes as schedule_notes,
           tm.name, tm.description, tm.default_priority
    from public.recurring_assignments ra
    join public.task_master tm on tm.id = ra.task_master_id
    where ra.is_active
      and tm.is_active
      and ra.assigned_to is not null
      and (_recurrence is null
           or coalesce(ra.recurrence, tm.recurrence)::text = _recurrence)
  loop
    if exists (
      select 1 from public.tasks t
      where t.task_master_id = r.task_master_id
        and t.client_id is not distinct from r.client_id
        and t.period = _period
        and t.financial_year = _financial_year
    ) then
      continue;
    end if;

    insert into public.tasks (
      title, task_master_id, client_id, assigned_to, assigned_by,
      stage_id, priority, description, financial_year, period,
      start_date, due_date, is_adhoc
    ) values (
      r.name, r.task_master_id, r.client_id, r.assigned_to,
      coalesce(auth.uid(), r.created_by, r.assigned_to),
      v_stage, r.default_priority,
      coalesce(nullif(btrim(r.schedule_notes), ''), r.description),
      _financial_year, _period,
      current_date, _due_date, false
    );

    v_created := v_created + 1;
  end loop;

  return v_created;
end;
$$;

grant execute on function public.generate_recurring_tasks(text, text, date, text) to authenticated;

-- =====================================================================
--  Verify the whole daily pipeline while you are here:
--    select jobname, schedule, active from cron.job;
--       -> recurring-task-generator | 30 2 * * * | t
--    select ra.recurrence, tm.name, p.full_name, c.name
--    from public.recurring_assignments ra
--    join public.task_master tm on tm.id = ra.task_master_id
--    left join public.profiles p on p.id = ra.assigned_to
--    left join public.clients c on c.id = ra.client_id
--    where ra.is_active;
--       -> every row here generates; NO rows = nothing recurs.
-- =====================================================================
