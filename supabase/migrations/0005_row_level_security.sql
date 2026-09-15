-- Row-level security.
--
-- Two rules shape this file:
--   1. A user may only ever touch rows whose user_id is their own.
--   2. Assistant state, validation verdicts, job state, usage counters and
--      generated recommendations are written by server/worker roles only.
--      Ownership alone must not let a browser client set READY, forge a job,
--      or bypass a usage limit.
--
-- Tables holding hidden solutions get RLS enabled and NO policy at all, so the
-- browser roles cannot reach them through any supported access path. The service
-- role bypasses RLS and is confined to server code.

alter table public.profiles                enable row level security;
alter table public.folders                 enable row level security;
alter table public.problems                enable row level security;
alter table public.problem_versions        enable row level security;
alter table public.notes                   enable row level security;
alter table public.study_events            enable row level security;
alter table public.assistant_sessions      enable row level security;
alter table public.reference_solutions     enable row level security;
alter table public.chat_messages           enable row level security;
alter table public.problem_idea_profiles   enable row level security;
alter table public.mathnet_releases        enable row level security;
alter table public.mathnet_problems        enable row level security;
alter table public.mathnet_solution_data   enable row level security;
alter table public.recommendation_runs     enable row level security;
alter table public.recommendation_items    enable row level security;
alter table public.jobs                    enable row level security;
alter table public.ai_usage                enable row level security;
alter table public.exports                 enable row level security;
alter table public.mse_lookup_cache        enable row level security;

-- ---------------------------------------------------------------------------
-- Owned records the learner reads and writes directly
-- ---------------------------------------------------------------------------

create policy profiles_select_own on public.profiles
  for select to authenticated using (user_id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy folders_all_own on public.folders
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy problems_all_own on public.problems
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy problem_versions_select_own on public.problem_versions
  for select to authenticated using (user_id = (select auth.uid()));
create policy problem_versions_insert_own on public.problem_versions
  for insert to authenticated with check (user_id = (select auth.uid()));
-- No update/delete policy: statement versions are immutable history.

create policy notes_select_own on public.notes
  for select to authenticated using (user_id = (select auth.uid()));
create policy notes_insert_own on public.notes
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy notes_update_own on public.notes
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy study_events_select_own on public.study_events
  for select to authenticated using (user_id = (select auth.uid()));
create policy study_events_insert_own on public.study_events
  for insert to authenticated with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Read-only for the browser; written by server/worker roles
-- ---------------------------------------------------------------------------

-- The learner sees whether the assistant is on and how preparation is going, but
-- cannot set preparation_state to READY or choose a reference by writing a row.
create policy assistant_sessions_select_own on public.assistant_sessions
  for select to authenticated using (user_id = (select auth.uid()));

-- Conversation is readable; assistant turns are published by the worker only.
create policy chat_messages_select_own on public.chat_messages
  for select to authenticated using (user_id = (select auth.uid()));

create policy jobs_select_own on public.jobs
  for select to authenticated using (user_id = (select auth.uid()));

create policy ai_usage_select_own on public.ai_usage
  for select to authenticated using (user_id = (select auth.uid()));

create policy exports_select_own on public.exports
  for select to authenticated using (user_id = (select auth.uid()));

create policy recommendation_runs_select_own on public.recommendation_runs
  for select to authenticated using (user_id = (select auth.uid()));

create policy recommendation_items_select_own on public.recommendation_items
  for select to authenticated using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- Shared catalog: statements are readable, solutions are not
-- ---------------------------------------------------------------------------

create policy mathnet_releases_select on public.mathnet_releases
  for select to authenticated using (true);

create policy mathnet_problems_select_eligible on public.mathnet_problems
  for select to authenticated using (is_eligible);

-- ---------------------------------------------------------------------------
-- No policies at all (service role only):
--   reference_solutions, problem_idea_profiles, mathnet_solution_data,
--   mse_lookup_cache
-- These hold reference solutions, solution-derived idea tags, and cached
-- third-party answer bodies. They are reachable only through explicit safe
-- projections in server code.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Private export storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;

-- Export objects are stored under "<user_id>/<export_id>.zip". The owning user may
-- read their own objects; only the worker (service role) writes them.
create policy "exports_read_own_objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'exports' and (storage.foldername(name))[1] = (select auth.uid())::text);
