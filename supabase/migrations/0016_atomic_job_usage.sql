-- Close a durable job reservation and record measured usage exactly once.
create or replace function public.reconcile_job_usage(
  p_job_id uuid,
  p_actual_tokens bigint,
  p_actual_micro_usd bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare j public.jobs;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'NOT_FOUND'); end if;
  if j.usage_reconciled then return jsonb_build_object('ok', true, 'duplicate', true); end if;

  insert into public.ai_usage (user_id, usage_date)
    values (j.user_id, (now() at time zone 'utc')::date)
    on conflict (user_id, usage_date) do nothing;
  update public.ai_usage set
      reserved_tokens = greatest(0, reserved_tokens - j.reserved_tokens),
      actual_tokens = actual_tokens + greatest(0, p_actual_tokens),
      actual_micro_usd = actual_micro_usd + greatest(0, p_actual_micro_usd)
    where user_id = j.user_id and usage_date = (now() at time zone 'utc')::date;
  update public.jobs set usage_reconciled = true where id = p_job_id;
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.reconcile_job_usage(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reconcile_job_usage(uuid, bigint, bigint) to service_role;
