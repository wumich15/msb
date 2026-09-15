-- Existing installations need the completion dependency introduced after 0006.
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
  v_classification_job_id uuid;
  v_auto_recommend boolean;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select status, current_statement_version into v_from, v_statement_version
    from public.problems where id = p_problem_id and user_id = v_user for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if p_expected_statement_version is not null and v_statement_version <> p_expected_statement_version then
    raise exception 'STATEMENT_CONFLICT' using errcode = 'P0004', detail = v_statement_version::text;
  end if;

  select revision, markdown into v_notes_revision, v_notes
    from public.notes where problem_id = p_problem_id and user_id = v_user for update;
  if p_expected_notes_revision is not null and v_notes_revision <> p_expected_notes_revision then
    raise exception 'NOTES_CONFLICT' using errcode = 'P0003', detail = v_notes_revision::text;
  end if;
  if v_from = p_to_status then
    return jsonb_build_object('changed', false, 'status', v_from,
      'statement_version', v_statement_version, 'notes_revision', v_notes_revision);
  end if;

  update public.problems set status = p_to_status,
    completed_at = case when p_to_status = 'complete' then now() else null end
    where id = p_problem_id;
  insert into public.study_events (user_id, problem_id, kind, from_status, to_status,
    statement_version, notes_revision, notes_snapshot)
  values (v_user, p_problem_id, 'status_changed', v_from, p_to_status,
    v_statement_version, v_notes_revision,
    case when p_to_status = 'complete' then v_notes else null end)
  returning id into v_event_id;

  select coalesce(automatic_recommendations, true) into v_auto_recommend
    from public.profiles where user_id = v_user;
  if p_to_status = 'complete' and coalesce(v_auto_recommend, true) then
    v_classification_job_id := public.enqueue_job(
      v_user, 'classify-problem', p_problem_id,
      jsonb_build_object('reason', 'completion', 'event_id', v_event_id),
      'classify:' || p_problem_id::text || ':' || v_event_id::text,
      null, null, v_statement_version, v_notes_revision);
    v_job_id := public.enqueue_job(
      v_user, 'recommend-problems', p_problem_id,
      jsonb_build_object('trigger', 'completion', 'event_id', v_event_id,
        'depends_on_job_id', v_classification_job_id),
      'recommend:' || p_problem_id::text || ':' || v_event_id::text,
      null, null, v_statement_version, v_notes_revision);
  end if;

  return jsonb_build_object('changed', true, 'status', p_to_status, 'from_status', v_from,
    'statement_version', v_statement_version, 'notes_revision', v_notes_revision,
    'event_id', v_event_id, 'classification_job_id', v_classification_job_id,
    'recommendation_job_id', v_job_id);
end;
$$;

revoke execute on function public.change_status(uuid, public.problem_status, integer, integer) from public, anon;
grant execute on function public.change_status(uuid, public.problem_status, integer, integer) to authenticated, service_role;
