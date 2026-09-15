-- Catalog retrieval used by both recommendation entry points. Three independent
-- candidate queries the application runs in parallel, then fuses.

-- Vector retrieval over statement embeddings.
create or replace function public.match_mathnet_by_statement(
  p_release_id uuid,
  p_embedding extensions.vector(1024),
  p_limit integer default 40,
  p_exclude_ids uuid[] default '{}'
)
returns table (mathnet_problem_id uuid, distance real)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select d.mathnet_problem_id, (d.statement_embedding <=> p_embedding)::real as distance
  from public.mathnet_solution_data d
  join public.mathnet_problems p on p.id = d.mathnet_problem_id
  where d.release_id = p_release_id
    and p.is_eligible
    and d.statement_embedding is not null
    and not (d.mathnet_problem_id = any (coalesce(p_exclude_ids, '{}')))
  order by d.statement_embedding <=> p_embedding
  limit p_limit;
$$;

-- Vector retrieval over idea/mechanism embeddings. Weighted above statement
-- similarity so wording alone does not drive a match.
create or replace function public.match_mathnet_by_idea(
  p_release_id uuid,
  p_embedding extensions.vector(1024),
  p_limit integer default 40,
  p_exclude_ids uuid[] default '{}'
)
returns table (mathnet_problem_id uuid, distance real)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select d.mathnet_problem_id, (d.idea_embedding <=> p_embedding)::real as distance
  from public.mathnet_solution_data d
  join public.mathnet_problems p on p.id = d.mathnet_problem_id
  where d.release_id = p_release_id
    and p.is_eligible
    and d.idea_embedding is not null
    and not (d.mathnet_problem_id = any (coalesce(p_exclude_ids, '{}')))
  order by d.idea_embedding <=> p_embedding
  limit p_limit;
$$;

-- Lexical and idea-tag retrieval.
create or replace function public.match_mathnet_by_text(
  p_release_id uuid,
  p_query text,
  p_idea_ids text[] default '{}',
  p_limit integer default 40,
  p_exclude_ids uuid[] default '{}'
)
returns table (mathnet_problem_id uuid, score real)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with q as (select websearch_to_tsquery('english', coalesce(nullif(btrim(p_query), ''), 'mathematics')) as tsq)
  select d.mathnet_problem_id,
         (ts_rank(d.search_document, q.tsq)
          + case when coalesce(array_length(p_idea_ids, 1), 0) > 0
                      and d.idea_ids && p_idea_ids then 0.5 else 0 end)::real as score
  from public.mathnet_solution_data d
  join public.mathnet_problems p on p.id = d.mathnet_problem_id
  cross join q
  where d.release_id = p_release_id
    and p.is_eligible
    and not (d.mathnet_problem_id = any (coalesce(p_exclude_ids, '{}')))
    and (d.search_document @@ q.tsq or (coalesce(array_length(p_idea_ids, 1), 0) > 0 and d.idea_ids && p_idea_ids))
  order by score desc
  limit p_limit;
$$;

-- Everything the learner has already seen: the source problem, saved copies,
-- dismissals, and imported duplicates. Refiltered on every read.
create or replace function public.mathnet_exclusions_for_user(
  p_user_id uuid,
  p_problem_id uuid
)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct x), '{}')
  from (
    select imported_mathnet_id as x from public.problems
     where user_id = p_user_id and imported_mathnet_id is not null
    union
    select mathnet_problem_id from public.recommendation_items
     where user_id = p_user_id and (dismissed_at is not null or saved_problem_id is not null)
    union
    -- Exact and equivalent duplicates of the learner's own statement.
    select mp.id from public.mathnet_problems mp
     join public.problem_versions pv
       on pv.statement_hash = mp.content_hash
     where pv.problem_id = p_problem_id and pv.user_id = p_user_id
  ) s
  where x is not null;
$$;

-- Copy a recommended statement into an owned folder as a new not_started problem.
-- Deduplicates repeated requests through the unique (run_id, mathnet_problem_id).
create or replace function public.save_recommendation_item(
  p_run_id uuid,
  p_item_id uuid,
  p_folder_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid := auth.uid();
  it record;
  mp record;
  v_problem_id uuid;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select * into it from public.recommendation_items
  where id = p_item_id and run_id = p_run_id and user_id = v_user
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if it.saved_problem_id is not null then
    return jsonb_build_object('duplicate', true, 'problem_id', it.saved_problem_id);
  end if;

  if not exists (select 1 from public.folders where id = p_folder_id and user_id = v_user) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Only the statement and attribution are copied. No solution travels with it.
  select id, coalesce(title, 'MathNET problem') as title, statement_markdown,
         source_id, source_locator, attribution
    into mp
  from public.mathnet_problems where id = it.mathnet_problem_id and is_eligible;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  insert into public.problems (user_id, folder_id, title, current_statement_version,
                               imported_mathnet_id, imported_source_id)
  values (v_user, p_folder_id, left(mp.title, 300), 1, mp.id, mp.source_id)
  returning id into v_problem_id;

  insert into public.problem_versions (user_id, problem_id, version, statement_markdown,
                                       statement_hash, source_kind, source_metadata)
  values (v_user, v_problem_id, 1, mp.statement_markdown,
          encode(extensions.digest(mp.statement_markdown, 'sha256'), 'hex'), 'mathnet',
          jsonb_build_object('source_id', mp.source_id, 'locator', mp.source_locator,
                             'attribution', mp.attribution));

  insert into public.notes (problem_id, user_id) values (v_problem_id, v_user);
  insert into public.assistant_sessions (problem_id, user_id, statement_version)
  values (v_problem_id, v_user, 1);
  insert into public.study_events (user_id, problem_id, kind, to_status, statement_version)
  values (v_user, v_problem_id, 'problem_created', 'not_started', 1);

  update public.recommendation_items set saved_problem_id = v_problem_id where id = p_item_id;

  return jsonb_build_object('duplicate', false, 'problem_id', v_problem_id);
end;
$$;

-- Report an issue with a reference: it becomes ineligible until rechecked.
create or replace function public.report_reference(
  p_problem_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  s record;
begin
  if v_user is null then
    raise exception 'UNAUTHENTICATED' using errcode = 'P0001';
  end if;

  select * into s from public.assistant_sessions
  where problem_id = p_problem_id and user_id = v_user for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if s.selected_reference_id is null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.reference_solutions
     set state = 'REPORTED', reported_at = now(), report_reason = left(coalesce(p_reason, ''), 2000)
   where id = s.selected_reference_id and user_id = v_user;

  update public.assistant_sessions
     set selected_reference_id = null,
         selected_reference_revision = null,
         preparation_choice = null,
         preparation_generation = preparation_generation + 1,
         preparation_state = 'AWAITING_SOLUTION',
         preparation_message = 'You reported an issue with the reference. Choose how to prepare a new one.'
   where problem_id = p_problem_id and user_id = v_user;

  update public.jobs
     set run_state = 'CANCELLED', error_code = 'STALE_REQUEST', finished_at = now()
   where problem_id = p_problem_id and job_type = 'respond-to-question'
     and run_state in ('QUEUED', 'RUNNING');

  return jsonb_build_object('reported', true);
end;
$$;

grant execute on function public.save_recommendation_item(uuid, uuid, uuid) to authenticated;
grant execute on function public.report_reference(uuid, text) to authenticated;
