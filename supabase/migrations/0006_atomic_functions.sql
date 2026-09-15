-- Compound atomic writes.
--
-- Each function is narrowly scoped, checks ownership explicitly, and raises an
-- exception whose MESSAGE is the application error code (NOTES_CONFLICT,
-- STATEMENT_CONFLICT, STALE_REQUEST, ...) so server code can map it without
-- parsing prose. Raising rolls the whole statement back, which is what keeps a
-- snapshot and its triggering state change in one transaction.

-- ---------------------------------------------------------------------------
-- create_problem — problem, first statement version, notes row, assistant session
-- ---------------------------------------------------------------------------

create or replace function public.create_problem(
  p_folder_id uuid,
  p_title text,
  p_statement text,
  p_source_kind text default 'user',
  p_source_metadata jsonb default '{}'::jsonb,
  p_imported_mathnet_id uuid default null,
  p_imported_source_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_problem_id uuid;
  v_version integer := 0;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.folders where id = p_folder_id and user_id = v_user) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if btrim(coalesce(p_statement, '')) <> '' then
    v_version := 1;
  end if;

  insert into public.problems (user_id, folder_id, title, current_statement_version,
                               imported_mathnet_id, imported_source_id)
  values (v_user, p_folder_id, p_title, v_version, p_imported_mathnet_id, p_imported_source_id)
  returning id into v_problem_id;

  if v_version = 1 then
    insert into public.problem_versions (user_id, problem_id, version, statement_markdown,
                                         statement_hash, source_kind, source_metadata)
    values (v_user, v_problem_id, 1, p_statement,
            encode(extensions.digest(p_statement, 'sha256'), 'hex'),
            coalesce(p_source_kind, 'user'), coalesce(p_source_metadata, '{}'::jsonb));
  end if;

  insert into public.notes (problem_id, user_id) values (v_problem_id, v_user);
  insert into public.assistant_sessions (problem_id, user_id, statement_version)
  values (v_problem_id, v_user, v_version);

  insert into public.study_events (user_id, problem_id, kind, to_status, statement_version)
  values (v_user, v_problem_id, 'problem_created', 'not_started', v_version);

  return v_problem_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- save_notes — optimistic concurrency on revision
-- ---------------------------------------------------------------------------

create or replace function public.save_notes(
  p_problem_id uuid,
  p_expected_revision integer,
  p_markdown text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_current integer;
  v_new integer;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select revision into v_current
  from public.notes where problem_id = p_problem_id and user_id = v_user
  for update;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_current <> p_expected_revision then
    -- Never silently replace another tab's changes; the caller keeps its draft.
    raise exception 'NOTES_CONFLICT' using errcode = 'P0003', detail = v_current::text;
  end if;

  v_new := v_current + 1;
  update public.notes
     set markdown = p_markdown, revision = v_new, saved_at = now()
   where problem_id = p_problem_id and user_id = v_user;

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- save_statement — new immutable version; invalidates tutor eligibility at once
-- ---------------------------------------------------------------------------

create or replace function public.save_statement(
  p_problem_id uuid,
  p_expected_version integer,
  p_statement text
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  v_current integer;
  v_new integer;
  v_prev_hash text;
  v_hash text := encode(extensions.digest(p_statement, 'sha256'), 'hex');
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select current_statement_version into v_current
  from public.problems where id = p_problem_id and user_id = v_user
  for update;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_current <> p_expected_version then
    raise exception 'STATEMENT_CONFLICT' using errcode = 'P0004', detail = v_current::text;
  end if;

  -- An identical statement is not a new version, so ordinary re-saves do not
  -- invalidate a prepared reference.
  select statement_hash into v_prev_hash
  from public.problem_versions
  where problem_id = p_problem_id and version = v_current;

  if v_prev_hash is not null and v_prev_hash = v_hash then
    return v_current;
  end if;

  v_new := v_current + 1;

  insert into public.problem_versions (user_id, problem_id, version, statement_markdown, statement_hash)
  values (v_user, p_problem_id, v_new, p_statement, v_hash);

  update public.problems set current_statement_version = v_new where id = p_problem_id;

  -- Suppress old output and invalidate the reference selection immediately.
  update public.reference_solutions
     set state = 'SUPERSEDED'
   where problem_id = p_problem_id and state in ('PENDING', 'CHECKING', 'READY');

  update public.jobs
     set run_state = 'CANCELLED', error_code = 'STALE_REQUEST', finished_at = now()
   where problem_id = p_problem_id
     and job_type in ('prepare-reference', 'respond-to-question')
     and run_state in ('QUEUED', 'RUNNING');

  update public.assistant_sessions
     set statement_version = v_new,
         selected_reference_id = null,
         selected_reference_revision = null,
         preparation_state = case when enabled then 'STALE'::public.preparation_state
                                  else 'OFF'::public.preparation_state end,
         preparation_message = case when enabled
           then 'The statement changed, so the saved reference no longer applies.'
           else null end
   where problem_id = p_problem_id;

  insert into public.study_events (user_id, problem_id, kind, statement_version)
  values (v_user, p_problem_id, 'statement_revised', v_new);

  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- change_status — compares expected versions, snapshots notes, appends the event
-- ---------------------------------------------------------------------------

create or replace function public.change_status(
  p_problem_id uuid,
  p_to_status public.problem_status,
  p_expected_statement_version integer,
  p_expected_notes_revision integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_from public.problem_status;
  v_statement_version integer;
  v_notes_revision integer;
  v_notes text;
  v_event_id uuid;
  v_job_id uuid;
  v_auto_recommend boolean;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select status, current_statement_version into v_from, v_statement_version
  from public.problems where id = p_problem_id and user_id = v_user
  for update;

  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_expected_statement_version is not null and v_statement_version <> p_expected_statement_version then
    raise exception 'STATEMENT_CONFLICT' using errcode = 'P0004', detail = v_statement_version::text;
  end if;

  select revision, markdown into v_notes_revision, v_notes
  from public.notes where problem_id = p_problem_id and user_id = v_user
  for update;

  select automatic_recommendations into v_auto_recommend
  from public.profiles where user_id = v_user;
  v_auto_recommend := coalesce(v_auto_recommend, true);

  if p_expected_notes_revision is not null and v_notes_revision <> p_expected_notes_revision then
    raise exception 'NOTES_CONFLICT' using errcode = 'P0003', detail = v_notes_revision::text;
  end if;

  -- A repeated identical update creates no duplicate event.
  if v_from = p_to_status then
    return jsonb_build_object('changed', false, 'status', v_from,
                              'statement_version', v_statement_version,
                              'notes_revision', v_notes_revision);
  end if;

  update public.problems
     set status = p_to_status,
         completed_at = case when p_to_status = 'complete' then now() else null end
   where id = p_problem_id;

  insert into public.study_events (user_id, problem_id, kind, from_status, to_status,
                                   statement_version, notes_revision, notes_snapshot)
  values (v_user, p_problem_id, 'status_changed', v_from, p_to_status,
          v_statement_version, v_notes_revision,
          case when p_to_status = 'complete' then v_notes else null end)
  returning id into v_event_id;

  -- Completion enqueues recommendations once, in this same transaction. Failure
  -- of that job must never undo completion, so it is a separate durable record.
  if p_to_status = 'complete' and v_auto_recommend then
    v_job_id := public.enqueue_job(
      v_user, 'recommend-problems', p_problem_id,
      jsonb_build_object('trigger', 'completion', 'event_id', v_event_id),
      'recommend:' || p_problem_id::text || ':' || v_event_id::text,
      null, null, v_statement_version, v_notes_revision);

    perform public.enqueue_job(
      v_user, 'classify-problem', p_problem_id,
      jsonb_build_object('reason', 'completion', 'event_id', v_event_id),
      'classify:' || p_problem_id::text || ':' || v_event_id::text,
      null, null, v_statement_version, v_notes_revision);
  end if;

  -- Reopening a completed problem restores spoiler protections in the UI; the
  -- stored profiles stay, but they are no longer shown.
  return jsonb_build_object(
    'changed', true, 'status', p_to_status, 'from_status', v_from,
    'statement_version', v_statement_version, 'notes_revision', v_notes_revision,
    'event_id', v_event_id, 'recommendation_job_id', v_job_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- set_preparation_choice — records an explicit provide/find/reuse decision
-- ---------------------------------------------------------------------------

create or replace function public.set_preparation_choice(
  p_problem_id uuid,
  p_choice public.preparation_choice,
  p_expected_statement_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_statement_version integer;
  v_enabled boolean;
  v_activation integer;
  v_preparation integer;
  v_state public.preparation_state;
  v_job_id uuid;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select current_statement_version into v_statement_version
  from public.problems where id = p_problem_id and user_id = v_user;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_expected_statement_version is not null and v_statement_version <> p_expected_statement_version then
    raise exception 'STATEMENT_CONFLICT' using errcode = 'P0004', detail = v_statement_version::text;
  end if;

  select enabled, activation_generation into v_enabled, v_activation
  from public.assistant_sessions where problem_id = p_problem_id and user_id = v_user
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not v_enabled then
    raise exception 'STALE_REQUEST' using errcode = 'P0005', detail = 'assistant disabled';
  end if;

  -- Every provide/find/reuse/retry action replaces the current preparation
  -- decision, so the generation advances and the old selection is cleared.
  v_state := case p_choice
    when 'find' then 'SEARCHING_MSE'::public.preparation_state
    when 'provide' then 'VALIDATING'::public.preparation_state
    else 'VALIDATING'::public.preparation_state
  end;

  update public.assistant_sessions
     set preparation_generation = preparation_generation + 1,
         preparation_choice = p_choice,
         preparation_state = v_state,
         preparation_message = null,
         selected_reference_id = null,
         selected_reference_revision = null,
         statement_version = v_statement_version
   where problem_id = p_problem_id and user_id = v_user
  returning preparation_generation into v_preparation;

  -- Older preparation work for this problem can no longer select a reference.
  update public.jobs
     set run_state = 'CANCELLED', error_code = 'STALE_REQUEST', finished_at = now()
   where problem_id = p_problem_id and job_type = 'prepare-reference'
     and run_state in ('QUEUED', 'RUNNING');

  update public.reference_solutions
     set state = 'SUPERSEDED'
   where problem_id = p_problem_id
     and preparation_generation < v_preparation
     and state in ('PENDING', 'CHECKING');

  -- The preparation job is bound to this exact generation. Only a matching
  -- generation may later select a reference.
  v_job_id := public.enqueue_job(
    v_user, 'prepare-reference', p_problem_id,
    jsonb_build_object('choice', p_choice),
    'prepare:' || p_problem_id::text || ':' || v_activation::text || ':' || v_preparation::text,
    v_activation, v_preparation, v_statement_version, null, 3, interval '15 minutes');

  return jsonb_build_object(
    'activation_generation', v_activation,
    'preparation_generation', v_preparation,
    'preparation_state', v_state,
    'statement_version', v_statement_version,
    'job_id', v_job_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- set_assistant_enabled — off-to-on bumps the activation generation
-- ---------------------------------------------------------------------------

create or replace function public.set_assistant_enabled(
  p_problem_id uuid,
  p_enabled boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_was boolean;
  v_statement_version integer;
  v_activation integer;
  v_preparation integer;
  v_state public.preparation_state;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select current_statement_version into v_statement_version
  from public.problems where id = p_problem_id and user_id = v_user;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  select enabled into v_was
  from public.assistant_sessions where problem_id = p_problem_id and user_id = v_user
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_enabled and not v_was then
    -- Every activation asks again. No choice is carried over silently.
    update public.assistant_sessions
       set enabled = true,
           activation_generation = activation_generation + 1,
           preparation_generation = preparation_generation + 1,
           preparation_choice = null,
           preparation_state = 'AWAITING_SOLUTION',
           preparation_message = null,
           selected_reference_id = null,
           selected_reference_revision = null,
           statement_version = v_statement_version
     where problem_id = p_problem_id and user_id = v_user
    returning activation_generation, preparation_generation, preparation_state
      into v_activation, v_preparation, v_state;
  elsif not p_enabled then
    update public.assistant_sessions
       set enabled = false,
           preparation_state = 'OFF',
           preparation_choice = null,
           preparation_message = null,
           selected_reference_id = null,
           selected_reference_revision = null
     where problem_id = p_problem_id and user_id = v_user
    returning activation_generation, preparation_generation, preparation_state
      into v_activation, v_preparation, v_state;

    -- Switching tutoring off cancels and suppresses tutor activity.
    update public.jobs
       set run_state = 'CANCELLED', error_code = 'STALE_REQUEST', finished_at = now()
     where problem_id = p_problem_id
       and job_type in ('prepare-reference', 'respond-to-question')
       and run_state in ('QUEUED', 'RUNNING');

    update public.reference_solutions
       set state = 'CANCELLED'
     where problem_id = p_problem_id and state in ('PENDING', 'CHECKING');
  else
    select activation_generation, preparation_generation, preparation_state
      into v_activation, v_preparation, v_state
    from public.assistant_sessions where problem_id = p_problem_id and user_id = v_user;
  end if;

  return jsonb_build_object(
    'enabled', p_enabled,
    'activation_generation', v_activation,
    'preparation_generation', v_preparation,
    'preparation_state', v_state,
    'statement_version', v_statement_version);
end;
$$;

grant execute on function public.create_problem(uuid, text, text, text, jsonb, uuid, text) to authenticated;
grant execute on function public.save_notes(uuid, integer, text) to authenticated;
grant execute on function public.save_statement(uuid, integer, text) to authenticated;
grant execute on function public.change_status(uuid, public.problem_status, integer, integer) to authenticated;
grant execute on function public.set_preparation_choice(uuid, public.preparation_choice, integer) to authenticated;
grant execute on function public.set_assistant_enabled(uuid, boolean) to authenticated;
