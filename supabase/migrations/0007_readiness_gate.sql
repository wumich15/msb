-- The server-enforced readiness gate, chat request creation, tutor publication,
-- and job lifecycle. These are the code invariants behind "no mathematical
-- response before a complete, checked reference exists".

-- ---------------------------------------------------------------------------
-- tutor_gate — the single place the gate conditions are written down
-- ---------------------------------------------------------------------------

create or replace function public.tutor_gate(
  p_problem_id uuid,
  p_user_id uuid,
  p_activation_generation integer default null,
  p_preparation_generation integer default null,
  p_reference_id uuid default null,
  p_reference_revision integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  s record;
  r record;
  v_statement_version integer;
begin
  -- requester owns the problem
  select current_statement_version into v_statement_version
  from public.problems where id = p_problem_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select * into s from public.assistant_sessions
  where problem_id = p_problem_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  -- assistant is enabled
  if not s.enabled then
    return jsonb_build_object('ok', false, 'code', 'SOLUTION_NOT_READY', 'reason', 'assistant_off');
  end if;

  -- this activation has an explicit completed preparation choice
  if s.preparation_choice is null then
    return jsonb_build_object('ok', false, 'code', 'SOLUTION_NOT_READY', 'reason', 'awaiting_choice');
  end if;

  if s.selected_reference_id is null then
    return jsonb_build_object('ok', false, 'code', 'SOLUTION_NOT_READY',
                              'reason', lower(s.preparation_state::text));
  end if;

  -- request generations match the live session
  if p_activation_generation is not null and p_activation_generation <> s.activation_generation then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'activation_generation');
  end if;
  if p_preparation_generation is not null and p_preparation_generation <> s.preparation_generation then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'preparation_generation');
  end if;
  if p_reference_id is not null and
     (p_reference_id <> s.selected_reference_id
      or coalesce(p_reference_revision, -1) <> coalesce(s.selected_reference_revision, -1)) then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'reference_superseded');
  end if;

  select * into r from public.reference_solutions
  where id = s.selected_reference_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'SOLUTION_NOT_READY', 'reason', 'no_reference');
  end if;

  -- reference is READY, unreported, and has a passing check
  if r.state <> 'READY' then
    return jsonb_build_object('ok', false, 'code', 'SOLUTION_NOT_READY', 'reason', lower(r.state::text));
  end if;
  if coalesce((r.check_result ->> 'passed')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'code', 'SOLUTION_NOT_READY', 'reason', 'check_not_passed');
  end if;
  if r.revision <> s.selected_reference_revision then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'reference_revision');
  end if;

  -- the reference belongs to the statement the learner is looking at
  if r.statement_version <> v_statement_version then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'statement_version');
  end if;
  if r.activation_generation <> s.activation_generation
     or r.preparation_generation <> s.preparation_generation then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'generation_mismatch');
  end if;

  return jsonb_build_object(
    'ok', true,
    'reference_id', r.id,
    'reference_revision', r.revision,
    'activation_generation', s.activation_generation,
    'preparation_generation', s.preparation_generation,
    'statement_version', v_statement_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- create_chat_request — gate, then snapshot notes and enqueue, atomically
-- ---------------------------------------------------------------------------

create or replace function public.create_chat_request(
  p_problem_id uuid,
  p_request_id text,
  p_question text,
  p_expected_notes_revision integer,
  p_selected_excerpt text default null,
  p_response_mode public.tutor_response_mode default 'default',
  p_thread_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_gate jsonb;
  v_notes_revision integer;
  v_notes text;
  v_thread uuid;
  v_sequence integer;
  v_message_id uuid;
  v_job_id uuid;
  v_existing record;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  -- Duplicate delivery of the same request is a no-op, not a second turn.
  select id, thread_id into v_existing
  from public.chat_messages
  where user_id = v_user and problem_id = p_problem_id and request_id = p_request_id;
  if found then
    select id into v_job_id from public.jobs
    where user_id = v_user and idempotency_key = 'chat:' || p_request_id;
    return jsonb_build_object('duplicate', true, 'message_id', v_existing.id, 'job_id', v_job_id);
  end if;

  -- Gate first. A rejected pre-ready request creates no assistant message.
  v_gate := public.tutor_gate(p_problem_id, v_user);
  if (v_gate ->> 'ok')::boolean is not true then
    raise exception '%', v_gate ->> 'code'
      using errcode = 'P0006', detail = coalesce(v_gate ->> 'reason', '');
  end if;

  -- Atomically compare the expected notes revision and copy the current notes
  -- into the immutable snapshot in the same transaction.
  select revision, markdown into v_notes_revision, v_notes
  from public.notes where problem_id = p_problem_id and user_id = v_user
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_expected_notes_revision is not null and v_notes_revision <> p_expected_notes_revision then
    raise exception 'NOTES_CONFLICT' using errcode = 'P0003', detail = v_notes_revision::text;
  end if;

  -- One thread per statement version keeps superseded turns out of context.
  select thread_id into v_thread from public.chat_messages
  where problem_id = p_problem_id and statement_version = (v_gate ->> 'statement_version')::integer
  order by created_at limit 1;
  v_thread := coalesce(p_thread_id, v_thread, extensions.gen_random_uuid());

  select coalesce(max(sequence), 0) + 1 into v_sequence
  from public.chat_messages where problem_id = p_problem_id and thread_id = v_thread;

  insert into public.chat_messages (
    user_id, problem_id, thread_id, sequence, role, content, request_id,
    notes_revision, notes_snapshot, selected_excerpt, statement_version,
    activation_generation, preparation_generation, reference_id, reference_revision, response_mode
  ) values (
    v_user, p_problem_id, v_thread, v_sequence, 'user', p_question, p_request_id,
    v_notes_revision, v_notes, p_selected_excerpt, (v_gate ->> 'statement_version')::integer,
    (v_gate ->> 'activation_generation')::integer, (v_gate ->> 'preparation_generation')::integer,
    (v_gate ->> 'reference_id')::uuid, (v_gate ->> 'reference_revision')::integer, p_response_mode
  ) returning id into v_message_id;

  v_job_id := public.enqueue_job(
    v_user, 'respond-to-question', p_problem_id,
    jsonb_build_object('message_id', v_message_id, 'thread_id', v_thread,
                       'response_mode', p_response_mode,
                       'reference_id', v_gate ->> 'reference_id',
                       'reference_revision', (v_gate ->> 'reference_revision')::integer),
    'chat:' || p_request_id,
    (v_gate ->> 'activation_generation')::integer,
    (v_gate ->> 'preparation_generation')::integer,
    (v_gate ->> 'statement_version')::integer,
    v_notes_revision, 2, interval '10 minutes');

  return jsonb_build_object(
    'duplicate', false, 'message_id', v_message_id, 'job_id', v_job_id,
    'thread_id', v_thread, 'sequence', v_sequence, 'notes_revision', v_notes_revision);
end;
$$;

-- ---------------------------------------------------------------------------
-- select_reference — a worker may mark a reference READY only for its own
-- activation and preparation generation. Service role only.
-- ---------------------------------------------------------------------------

create or replace function public.select_reference(
  p_reference_id uuid,
  p_activation_generation integer,
  p_preparation_generation integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  s record;
begin
  select * into r from public.reference_solutions where id = p_reference_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select * into s from public.assistant_sessions where problem_id = r.problem_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  -- A late worker cannot restore READY after a newer statement, activation, or
  -- preparation decision replaced it.
  if not s.enabled
     or s.activation_generation <> p_activation_generation
     or s.preparation_generation <> p_preparation_generation
     or s.statement_version <> r.statement_version then
    update public.reference_solutions set state = 'SUPERSEDED' where id = p_reference_id;
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST');
  end if;

  if coalesce((r.check_result ->> 'passed')::boolean, false) is not true or r.artifact is null then
    return jsonb_build_object('ok', false, 'code', 'SOLUTION_NOT_READY', 'reason', 'check_not_passed');
  end if;

  update public.reference_solutions set state = 'READY' where id = p_reference_id;

  update public.assistant_sessions
     set selected_reference_id = r.id,
         selected_reference_revision = r.revision,
         preparation_state = 'READY',
         preparation_message = null
   where problem_id = r.problem_id;

  return jsonb_build_object('ok', true, 'reference_id', r.id, 'reference_revision', r.revision);
end;
$$;

-- ---------------------------------------------------------------------------
-- publish_tutor_response — the final version-and-generation check plus the write
-- ---------------------------------------------------------------------------

create or replace function public.publish_tutor_response(
  p_job_id uuid,
  p_content text,
  p_response_mode public.tutor_response_mode,
  p_cited_note_excerpt text default null,
  p_spoiler_level text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j record;
  v_gate jsonb;
  v_sequence integer;
  v_thread uuid;
  v_message_id uuid;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if j.run_state = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'cancelled');
  end if;

  -- Recheck eligibility at publication time, not only at request time.
  v_gate := public.tutor_gate(
    j.problem_id, j.user_id, j.activation_generation, j.preparation_generation,
    (j.input ->> 'reference_id')::uuid, (j.input ->> 'reference_revision')::integer);

  if (v_gate ->> 'ok')::boolean is not true then
    update public.jobs
       set run_state = 'CANCELLED', error_code = v_gate ->> 'code', finished_at = now()
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', v_gate ->> 'code', 'reason', v_gate ->> 'reason');
  end if;

  if j.statement_version <> (v_gate ->> 'statement_version')::integer then
    update public.jobs
       set run_state = 'CANCELLED', error_code = 'STALE_REQUEST', finished_at = now()
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'STALE_REQUEST', 'reason', 'statement_version');
  end if;

  v_thread := (j.input ->> 'thread_id')::uuid;
  select coalesce(max(sequence), 0) + 1 into v_sequence
  from public.chat_messages where problem_id = j.problem_id and thread_id = v_thread;

  insert into public.chat_messages (
    user_id, problem_id, thread_id, sequence, role, content, request_id,
    statement_version, activation_generation, preparation_generation,
    reference_id, reference_revision, response_mode, cited_note_excerpt, spoiler_level,
    notes_revision
  ) values (
    j.user_id, j.problem_id, v_thread, v_sequence, 'assistant', p_content,
    'response:' || p_job_id::text,
    j.statement_version, j.activation_generation, j.preparation_generation,
    (j.input ->> 'reference_id')::uuid, (j.input ->> 'reference_revision')::integer,
    p_response_mode, p_cited_note_excerpt, p_spoiler_level, j.notes_revision
  )
  on conflict (user_id, problem_id, request_id) do nothing
  returning id into v_message_id;

  update public.jobs
     set run_state = 'SUCCEEDED', finished_at = now(),
         result = jsonb_build_object('message_id', v_message_id)
   where id = p_job_id;

  return jsonb_build_object('ok', true, 'message_id', v_message_id, 'sequence', v_sequence);
end;
$$;

-- ---------------------------------------------------------------------------
-- Job lifecycle helpers (service role)
-- ---------------------------------------------------------------------------

create or replace function public.claim_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  j record;
begin
  select * into j from public.jobs where id = p_job_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if j.run_state in ('SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT') then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_TERMINAL', 'run_state', j.run_state);
  end if;
  if j.expires_at is not null and j.expires_at < now() then
    update public.jobs set run_state = 'TIMED_OUT', finished_at = now(), error_code = 'JOB_EXPIRED'
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'JOB_EXPIRED');
  end if;
  if j.attempts >= j.max_attempts then
    update public.jobs set run_state = 'FAILED', finished_at = now(), error_code = 'ATTEMPTS_EXHAUSTED'
     where id = p_job_id;
    return jsonb_build_object('ok', false, 'code', 'ATTEMPTS_EXHAUSTED');
  end if;

  update public.jobs
     set run_state = 'RUNNING', attempts = attempts + 1,
         started_at = coalesce(started_at, now()), dispatch_state = 'DISPATCHED',
         dispatched_at = coalesce(dispatched_at, now())
   where id = p_job_id;

  return jsonb_build_object('ok', true, 'job', to_jsonb(j));
end;
$$;

create or replace function public.finish_job(
  p_job_id uuid,
  p_run_state public.job_run_state,
  p_error_code text default null,
  p_error_detail text default null,
  p_result jsonb default null,
  p_provider_request_ids text[] default null,
  p_needs_billing_reconciliation boolean default false
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.jobs
     set run_state = p_run_state,
         error_code = p_error_code,
         error_detail = p_error_detail,
         result = coalesce(p_result, result),
         provider_request_ids = coalesce(provider_request_ids, '{}') ||
                                coalesce(p_provider_request_ids, '{}'),
         needs_billing_reconciliation = needs_billing_reconciliation or p_needs_billing_reconciliation,
         finished_at = case when p_run_state in ('QUEUED', 'RUNNING') then null else now() end
   where id = p_job_id
     -- A late worker may not overwrite a cancellation.
     and run_state <> 'CANCELLED';
$$;

create or replace function public.mark_job_dispatched(p_job_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.jobs
     set dispatch_state = 'DISPATCHED', dispatched_at = now()
   where id = p_job_id and dispatch_state <> 'DISPATCHED';
$$;

-- Closes the gap between a committed state change and a failed event delivery.
create or replace function public.pending_jobs_for_reconciliation(p_older_than interval default interval '30 seconds')
returns setof public.jobs
language sql
security definer
set search_path = public
as $$
  select * from public.jobs
   where dispatch_state <> 'DISPATCHED'
     and run_state = 'QUEUED'
     and created_at < now() - p_older_than
     and (expires_at is null or expires_at > now())
   order by created_at
   limit 100;
$$;

-- ---------------------------------------------------------------------------
-- reserve_ai_budget — reserved atomically before dispatch, reconciled after
-- ---------------------------------------------------------------------------

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
  insert into public.ai_usage (user_id, usage_date) values (p_user_id, (now() at time zone 'utc')::date)
  on conflict (user_id, usage_date) do nothing;

  select * into v_row from public.ai_usage
  where user_id = p_user_id and usage_date = (now() at time zone 'utc')::date
  for update;

  select count(*) into v_active from public.jobs
  where user_id = p_user_id and run_state in ('QUEUED', 'RUNNING')
    and job_type in ('prepare-reference', 'respond-to-question', 'classify-problem', 'recommend-problems');

  if v_active > p_max_concurrent_jobs then
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

create or replace function public.record_ai_usage(
  p_user_id uuid,
  p_reserved_tokens bigint,
  p_actual_tokens bigint,
  p_actual_micro_usd bigint default 0
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.ai_usage
     set reserved_tokens = greatest(0, reserved_tokens - p_reserved_tokens),
         actual_tokens = actual_tokens + p_actual_tokens,
         actual_micro_usd = actual_micro_usd + p_actual_micro_usd
   where user_id = p_user_id and usage_date = (now() at time zone 'utc')::date;
$$;

grant execute on function public.create_chat_request(uuid, text, text, integer, text, public.tutor_response_mode, uuid) to authenticated;
