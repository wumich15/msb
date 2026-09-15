-- Close privilege and direct-write gaps discovered during the MVP audit.

alter table public.jobs
  add column if not exists reserved_tokens bigint not null default 0,
  add column if not exists usage_reconciled boolean not null default false;

-- PostgreSQL grants EXECUTE to PUBLIC by default, including SECURITY DEFINER
-- functions. Start from no browser execution and explicitly expose only RPCs
-- that derive ownership from auth.uid().
revoke execute on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
grant execute on all functions in schema public to service_role;

grant execute on function public.create_problem(uuid, text, text, text, jsonb, uuid, text) to authenticated;
grant execute on function public.save_notes(uuid, integer, text) to authenticated;
grant execute on function public.save_statement(uuid, integer, text) to authenticated;
grant execute on function public.change_status(uuid, public.problem_status, integer, integer) to authenticated;
grant execute on function public.set_preparation_choice(uuid, public.preparation_choice, integer, text) to authenticated;
grant execute on function public.set_assistant_enabled(uuid, boolean) to authenticated;
grant execute on function public.create_chat_request(uuid, text, text, integer, text, public.tutor_response_mode, uuid) to authenticated;
grant execute on function public.save_recommendation_item(uuid, uuid, uuid) to authenticated;
grant execute on function public.report_reference(uuid, text) to authenticated;

-- Browser clients may read owned records but all invariant-bearing writes go
-- through the RPCs or authenticated server routes above.
drop policy if exists folders_all_own on public.folders;
create policy folders_select_own on public.folders
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists problems_all_own on public.problems;
create policy problems_select_own on public.problems
  for select to authenticated using (user_id = (select auth.uid()));

drop policy if exists problem_versions_insert_own on public.problem_versions;
drop policy if exists notes_insert_own on public.notes;
drop policy if exists notes_update_own on public.notes;
drop policy if exists study_events_insert_own on public.study_events;

-- The reservation happens before enqueue. When the account already has the
-- configured number of active AI jobs, reject instead of admitting one extra.
create or replace function public.reserve_ai_budget(
  p_user_id uuid,
  p_tokens bigint,
  p_daily_token_limit bigint,
  p_max_concurrent_jobs integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.ai_usage;
  v_active integer;
begin
  if not exists (select 1 from public.profiles where user_id = p_user_id) then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND', 'reason', 'account');
  end if;

  insert into public.ai_usage (user_id, usage_date)
  values (p_user_id, (now() at time zone 'utc')::date)
  on conflict (user_id, usage_date) do nothing;

  select * into v_row from public.ai_usage
   where user_id = p_user_id and usage_date = (now() at time zone 'utc')::date
   for update;

  select count(*) into v_active from public.jobs
   where user_id = p_user_id and run_state in ('QUEUED', 'RUNNING')
     and job_type in ('prepare-reference', 'respond-to-question', 'classify-problem', 'recommend-problems');

  if v_active >= p_max_concurrent_jobs then
    return jsonb_build_object('ok', false, 'code', 'AI_LIMIT_REACHED', 'reason', 'concurrent_jobs');
  end if;
  if greatest(v_row.reserved_tokens, v_row.actual_tokens) + p_tokens > p_daily_token_limit then
    return jsonb_build_object('ok', false, 'code', 'AI_LIMIT_REACHED', 'reason', 'daily_tokens');
  end if;

  update public.ai_usage
     set reserved_tokens = reserved_tokens + p_tokens, job_count = job_count + 1
   where user_id = p_user_id and usage_date = (now() at time zone 'utc')::date;

  return jsonb_build_object('ok', true, 'reserved_tokens', v_row.reserved_tokens + p_tokens);
end;
$$;

revoke execute on function public.reserve_ai_budget(uuid, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.reserve_ai_budget(uuid, bigint, bigint, integer) to service_role;

create index if not exists jobs_unreconciled_reservation_idx
  on public.jobs (updated_at)
  where reserved_tokens > 0 and not usage_reconciled;
