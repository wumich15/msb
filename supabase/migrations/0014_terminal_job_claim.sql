create or replace function public.claim_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare j record;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if j.run_state in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT') then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_TERMINAL', 'run_state', j.run_state);
  end if;
  if j.expires_at is not null and j.expires_at < now() then
    update public.jobs set run_state = 'TIMED_OUT', finished_at = now(), error_code = 'JOB_EXPIRED' where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'JOB_EXPIRED');
  end if;
  if j.attempts >= j.max_attempts then
    update public.jobs set run_state = 'FAILED', finished_at = now(), error_code = 'ATTEMPTS_EXHAUSTED' where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'ATTEMPTS_EXHAUSTED');
  end if;
  update public.jobs set run_state = 'RUNNING', attempts = attempts + 1,
    started_at = coalesce(started_at, now()), dispatch_state = 'DISPATCHED',
    dispatched_at = coalesce(dispatched_at, now()) where id = p_job_id;
  j.run_state := 'RUNNING';
  j.attempts := j.attempts + 1;
  return jsonb_build_object('ok', true, 'job', to_jsonb(j));
end;
$$;

revoke execute on function public.claim_job(uuid) from public, anon, authenticated;
grant execute on function public.claim_job(uuid) to service_role;
