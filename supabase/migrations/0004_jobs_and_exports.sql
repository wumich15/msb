-- Durable job records, AI usage accounting, exports, and the Math Stack Exchange
-- lookup cache.

create type public.job_type as enum (
  'prepare-reference',
  'respond-to-question',
  'classify-problem',
  'recommend-problems',
  'export-workspace'
);

-- Dispatch state is tracked separately from run state so a reconciliation pass can
-- resend records that committed but whose event delivery failed.
create type public.job_dispatch_state as enum ('PENDING', 'DISPATCHED', 'FAILED_DISPATCH');

create type public.job_run_state as enum (
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'
);

create type public.export_scope as enum ('problem', 'folder', 'account');
create type public.export_state as enum ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- ---------------------------------------------------------------------------
-- jobs
-- ---------------------------------------------------------------------------

create table public.jobs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  job_type public.job_type not null,
  problem_id uuid,
  -- Input record ids and versions; never note bodies or solutions.
  input jsonb not null default '{}'::jsonb,
  -- Delivery may occur more than once; application effects must occur once.
  idempotency_key text not null,
  dispatch_state public.job_dispatch_state not null default 'PENDING',
  dispatched_at timestamptz,
  run_state public.job_run_state not null default 'QUEUED',
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  stage text,
  error_code text,
  error_detail text,
  result jsonb,
  -- The gate compares these against the live session before publishing anything.
  activation_generation integer,
  preparation_generation integer,
  statement_version integer,
  notes_revision integer,
  provider_request_ids text[] not null default '{}',
  needs_billing_reconciliation boolean not null default false,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (user_id, idempotency_key),
  unique (id, user_id)
);

create index jobs_active_idx on public.jobs (user_id, run_state, created_at desc)
  where run_state in ('QUEUED', 'RUNNING');
create index jobs_undispatched_idx on public.jobs (dispatch_state, created_at)
  where dispatch_state <> 'DISPATCHED';
create index jobs_problem_idx on public.jobs (problem_id, job_type, created_at desc);

create trigger jobs_touch before update on public.jobs
  for each row execute function public.touch_updated_at();

-- At most one active tutor generation per problem, so conversation order holds.
create unique index jobs_single_active_response_idx
  on public.jobs (problem_id) where job_type = 'respond-to-question' and run_state in ('QUEUED', 'RUNNING');

-- At most one active preparation job per problem.
create unique index jobs_single_active_preparation_idx
  on public.jobs (problem_id) where job_type = 'prepare-reference' and run_state in ('QUEUED', 'RUNNING');

-- ---------------------------------------------------------------------------
-- ai_usage — per-account budget reserved before dispatch, reconciled after
-- ---------------------------------------------------------------------------

create table public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  usage_date date not null default (now() at time zone 'utc')::date,
  reserved_tokens bigint not null default 0,
  actual_tokens bigint not null default 0,
  reserved_micro_usd bigint not null default 0,
  actual_micro_usd bigint not null default 0,
  job_count integer not null default 0,
  primary key (user_id, usage_date)
);

-- ---------------------------------------------------------------------------
-- exports
-- ---------------------------------------------------------------------------

create table public.exports (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  scope public.export_scope not null,
  scope_id uuid,
  schema_version text not null,
  include_references boolean not null default false,
  snapshot_at timestamptz not null default now(),
  state public.export_state not null default 'QUEUED',
  object_path text,
  byte_size bigint,
  error_code text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index exports_user_idx on public.exports (user_id, created_at desc);

create trigger exports_touch before update on public.exports
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- mse_lookup_cache — shared, keyed by normalized statement and API parameters
-- ---------------------------------------------------------------------------

create table public.mse_lookup_cache (
  cache_key text primary key,
  normalized_query text not null,
  api_params jsonb not null default '{}'::jsonb,
  response jsonb not null,
  outcome text not null check (outcome in ('found', 'no_result', 'unavailable')),
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index mse_lookup_cache_expiry_idx on public.mse_lookup_cache (expires_at);

-- ---------------------------------------------------------------------------
-- enqueue_job — writes the pending record. Callers invoke it inside the same
-- transaction as the state change that triggers the work; dispatch happens after
-- commit, and a reconciliation pass resends anything still PENDING.
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_job(
  p_user_id uuid,
  p_job_type public.job_type,
  p_problem_id uuid,
  p_input jsonb,
  p_idempotency_key text,
  p_activation_generation integer default null,
  p_preparation_generation integer default null,
  p_statement_version integer default null,
  p_notes_revision integer default null,
  p_max_attempts integer default 3,
  p_expires_in interval default interval '1 hour'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  insert into public.jobs (
    user_id, job_type, problem_id, input, idempotency_key,
    activation_generation, preparation_generation, statement_version, notes_revision,
    max_attempts, expires_at
  ) values (
    p_user_id, p_job_type, p_problem_id, coalesce(p_input, '{}'::jsonb), p_idempotency_key,
    p_activation_generation, p_preparation_generation, p_statement_version, p_notes_revision,
    p_max_attempts, now() + p_expires_in
  )
  -- Duplicate delivery of the same triggering action reuses the existing job.
  on conflict (user_id, idempotency_key) do update set updated_at = now()
  returning id into v_job_id;

  return v_job_id;
end;
$$;
