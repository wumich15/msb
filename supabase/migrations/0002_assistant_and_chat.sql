-- Assistant preparation state, private reference solutions, tutoring conversation,
-- and server-only idea profiles.

-- ---------------------------------------------------------------------------
-- Enumerations for the preparation state machine (spec section 5)
-- ---------------------------------------------------------------------------

create type public.preparation_state as enum (
  'OFF',
  'AWAITING_SOLUTION',
  'SEARCHING_MSE',
  'SELF_SOLVING',
  'VALIDATING',
  'READY',
  'BLOCKED',
  'STALE'
);

create type public.preparation_choice as enum ('provide', 'find', 'reuse');

create type public.reference_state as enum (
  'PENDING',
  'CHECKING',
  'READY',
  'REJECTED',
  'REPORTED',
  'SUPERSEDED',
  'CANCELLED'
);

create type public.reference_provenance as enum ('user_supplied', 'math_stack_exchange', 'ai_generated');

create type public.chat_role as enum ('user', 'assistant');

create type public.tutor_response_mode as enum (
  'default',
  'stronger_hint',
  'full_solution',
  'discuss_note_question',
  'operational'
);

-- ---------------------------------------------------------------------------
-- assistant_sessions — one current row per problem
-- ---------------------------------------------------------------------------

create table public.assistant_sessions (
  problem_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  -- Incremented on every off-to-on activation.
  activation_generation integer not null default 0,
  -- Incremented whenever a provide/find/reuse/retry/report action replaces or
  -- invalidates the current preparation decision.
  preparation_generation integer not null default 0,
  preparation_choice public.preparation_choice,
  preparation_state public.preparation_state not null default 'OFF',
  preparation_message text,
  -- Only a reference whose id AND revision match may be used by the gate.
  selected_reference_id uuid,
  selected_reference_revision integer,
  statement_version integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (problem_id, user_id),
  constraint assistant_sessions_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade,
  constraint assistant_sessions_reference_pair
    check ((selected_reference_id is null) = (selected_reference_revision is null))
);

create index assistant_sessions_user_idx on public.assistant_sessions (user_id);

create trigger assistant_sessions_touch before update on public.assistant_sessions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- reference_solutions — PRIVATE, server-only. Never exposed to a browser client.
-- ---------------------------------------------------------------------------

create table public.reference_solutions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  problem_id uuid not null,
  -- References are tied to an immutable statement version.
  statement_version integer not null,
  -- Bumped by a repair attempt; the gate compares id AND revision.
  revision integer not null default 1,
  activation_generation integer not null,
  preparation_generation integer not null,
  state public.reference_state not null default 'PENDING',
  provenance public.reference_provenance not null,
  -- Exactly as the learner pasted it, before extraction into the structured
  -- artifact. Kept so a rejected submission can be shown back to them.
  submitted_text text,
  -- Structured artifact: statement restatement, assumptions, notation, worked
  -- steps, boundary cases, conclusion. See src/lib/ai/schemas.ts.
  artifact jsonb,
  -- Separate checking result: statement match, step coverage, cases, conclusion,
  -- unresolved gaps, pass/fail.
  check_result jsonb,
  source_urls jsonb not null default '[]'::jsonb,
  attribution jsonb not null default '{}'::jsonb,
  model_versions jsonb not null default '{}'::jsonb,
  prompt_versions jsonb not null default '{}'::jsonb,
  reported_at timestamptz,
  report_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, revision),
  constraint reference_solutions_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade,
  -- READY is only meaningful with both a worked artifact and a passing check.
  constraint reference_solutions_ready_requires_artifact
    check (state <> 'READY' or (artifact is not null and check_result is not null))
);

create index reference_solutions_problem_idx
  on public.reference_solutions (problem_id, statement_version, created_at desc);
create index reference_solutions_ready_idx
  on public.reference_solutions (problem_id, state) where state = 'READY';

create trigger reference_solutions_touch before update on public.reference_solutions
  for each row execute function public.touch_updated_at();

comment on table public.reference_solutions is
  'Server-only. No row-level security policy is granted to browser roles; access
   goes through explicit safe projections in server code.';

-- ---------------------------------------------------------------------------
-- chat_messages
-- ---------------------------------------------------------------------------

create table public.chat_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  problem_id uuid not null,
  thread_id uuid not null,
  sequence integer not null,
  role public.chat_role not null,
  content text not null,
  -- Unique per user/problem so duplicate delivery cannot duplicate a turn.
  request_id text,
  -- For user turns: the exact notes revision the question was asked against.
  notes_revision integer,
  notes_snapshot text,
  selected_excerpt text,
  statement_version integer not null,
  activation_generation integer not null default 0,
  preparation_generation integer not null default 0,
  reference_id uuid,
  reference_revision integer,
  response_mode public.tutor_response_mode not null default 'default',
  cited_note_excerpt text,
  spoiler_level text,
  -- Operational messages (setup prompts, status, errors) carry no mathematics.
  is_operational boolean not null default false,
  created_at timestamptz not null default now(),
  constraint chat_messages_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade
);

-- One active tutor response per problem is enforced in the jobs table; this keeps
-- conversation order stable and makes duplicate delivery a no-op.
create unique index chat_messages_request_idx
  on public.chat_messages (user_id, problem_id, request_id) where request_id is not null;
create unique index chat_messages_sequence_idx
  on public.chat_messages (problem_id, thread_id, sequence);
create index chat_messages_order_idx
  on public.chat_messages (problem_id, created_at, sequence);
create index chat_messages_statement_version_idx
  on public.chat_messages (problem_id, statement_version);

-- ---------------------------------------------------------------------------
-- problem_idea_profiles — PRIVATE. Solution-derived tags can reveal the trick.
-- ---------------------------------------------------------------------------

create table public.problem_idea_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  problem_id uuid not null,
  statement_version integer not null,
  notes_revision integer,
  -- Controlled vocabulary ids from data/idea-taxonomy.json.
  idea_ids text[] not null default '{}',
  secondary_idea_ids text[] not null default '{}',
  mechanism text,
  object_roles jsonb not null default '[]'::jsonb,
  prerequisites text[] not null default '{}',
  evidence jsonb not null default '[]'::jsonb,
  evidence_kind text not null default 'statement_only'
    check (evidence_kind in ('statement_only', 'user_supplied_work', 'checked_reference')),
  estimated_difficulty text,
  confidence real not null default 0 check (confidence >= 0 and confidence <= 1),
  -- Statement-only profiles are provisional; a checked reference makes them final.
  is_provisional boolean not null default true,
  -- Tags safe to show before completion (derived from the learner's own notes).
  safe_tags text[] not null default '{}',
  input_hash text not null,
  classifier_version text not null,
  created_at timestamptz not null default now(),
  constraint problem_idea_profiles_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade
);

create unique index problem_idea_profiles_cache_idx
  on public.problem_idea_profiles (problem_id, input_hash, classifier_version);
create index problem_idea_profiles_latest_idx
  on public.problem_idea_profiles (problem_id, created_at desc);
create index problem_idea_profiles_idea_idx
  on public.problem_idea_profiles using gin (idea_ids);
