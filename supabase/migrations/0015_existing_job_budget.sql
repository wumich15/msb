-- Automatic jobs are committed with their triggering state change, so reserve
-- against the already-existing job and include (rather than pre-count) that job.
create or replace function public.reserve_ai_budget_for_job(
  p_job_id uuid,
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
  j public.jobs;
  v_row public.ai_usage;
  v_active integer;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if j.reserved_tokens > 0 or j.usage_reconciled then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if j.run_state not in ('QUEUED', 'RUNNING') then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST');
  end if;

  insert into public.ai_usage (user_id, usage_date)
    values (j.user_id, (now() at time zone 'utc')::date)
    on conflict (user_id, usage_date) do nothing;
  select * into v_row from public.ai_usage
    where user_id = j.user_id and usage_date = (now() at time zone 'utc')::date for update;
  select count(*) into v_active from public.jobs
    where user_id = j.user_id and run_state in ('QUEUED', 'RUNNING')
      and job_type in ('prepare-reference', 'respond-to-question', 'classify-problem', 'recommend-problems');

  if v_active > p_max_concurrent_jobs then
    return jsonb_build_object('ok', false, 'code', 'AI_LIMIT_REACHED', 'reason', 'concurrent_jobs');
  end if;
  if greatest(v_row.reserved_tokens, v_row.actual_tokens) + p_tokens > p_daily_token_limit then
    return jsonb_build_object('ok', false, 'code', 'AI_LIMIT_REACHED', 'reason', 'daily_tokens');
  end if;

  update public.ai_usage set reserved_tokens = reserved_tokens + p_tokens, job_count = job_count + 1
    where user_id = j.user_id and usage_date = (now() at time zone 'utc')::date;
  update public.jobs set reserved_tokens = p_tokens where id = p_job_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.reserve_ai_budget_for_job(uuid, bigint, bigint, integer) from public, anon, authenticated;
grant execute on function public.reserve_ai_budget_for_job(uuid, bigint, bigint, integer) to service_role;
