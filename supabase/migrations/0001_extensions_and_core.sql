-- Math Study Buddy — core study records.
-- Every private record carries user_id, and every child references its parent
-- through a composite (id, user_id) foreign key so ownership is enforced by the
-- database rather than by a client-supplied owner field.

create extension if not exists "pgcrypto" with schema extensions;
create extension if not exists "vector" with schema extensions;
create extension if not exists "pg_trgm" with schema extensions;

-- ---------------------------------------------------------------------------
-- Enumerations
-- ---------------------------------------------------------------------------

create type public.problem_status as enum ('not_started', 'in_progress', 'complete');

create type public.study_event_kind as enum (
  'status_changed',
  'completion_snapshot',
  'checkpoint_snapshot',
  'problem_created',
  'statement_revised'
);

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  ai_disclosure_version integer not null default 0,
  ai_disclosure_accepted_at timestamptz,
  -- "Automatic idea tags and recommendations": independent of per-problem tutoring.
  automatic_recommendations boolean not null default true,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.profiles.automatic_recommendations is
  'Account setting controlling background classification and completion recommendations.';

-- Create a profile row on sign-up so the workspace never has to upsert one.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- folders — a folder is a math project
-- ---------------------------------------------------------------------------

create table public.folders (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target for composite foreign keys from child rows.
  unique (id, user_id)
);

create index folders_user_created_idx on public.folders (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- problems
-- ---------------------------------------------------------------------------

create table public.problems (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  folder_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 300),
  status public.problem_status not null default 'not_started',
  current_statement_version integer not null default 0,
  -- Set when the problem was copied in from a MathNET recommendation.
  imported_mathnet_id uuid,
  imported_source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (id, user_id),
  constraint problems_folder_owned_fkey
    foreign key (folder_id, user_id) references public.folders (id, user_id) on delete cascade
);

create index problems_user_folder_idx on public.problems (user_id, folder_id, updated_at desc);
create index problems_user_status_idx on public.problems (user_id, status, updated_at desc);
create index problems_title_search_idx on public.problems using gin (to_tsvector('english', title));

-- ---------------------------------------------------------------------------
-- problem_versions — immutable statement history
-- ---------------------------------------------------------------------------

create table public.problem_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  problem_id uuid not null,
  version integer not null check (version >= 1),
  statement_markdown text not null,
  statement_hash text not null,
  source_kind text not null default 'user' check (source_kind in ('user', 'mathnet', 'import')),
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (problem_id, version),
  unique (id, user_id),
  constraint problem_versions_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade
);

create index problem_versions_problem_idx on public.problem_versions (problem_id, version desc);

-- Statement versions are immutable: a change creates a new row.
create or replace function public.forbid_problem_version_update()
returns trigger language plpgsql as $$
begin
  raise exception 'problem_versions rows are immutable (problem %, version %)', old.problem_id, old.version
    using errcode = 'restrict_violation';
end;
$$;

create trigger problem_versions_immutable
  before update on public.problem_versions
  for each row execute function public.forbid_problem_version_update();

-- ---------------------------------------------------------------------------
-- notes — exactly one current row per problem, optimistic concurrency
-- ---------------------------------------------------------------------------

create table public.notes (
  problem_id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  markdown text not null default '',
  revision integer not null default 0,
  saved_at timestamptz not null default now(),
  unique (problem_id, user_id),
  constraint notes_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade
);

create index notes_user_idx on public.notes (user_id);

-- ---------------------------------------------------------------------------
-- study_events — append-only transitions and milestone snapshots
-- ---------------------------------------------------------------------------

create table public.study_events (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  problem_id uuid not null,
  kind public.study_event_kind not null,
  from_status public.problem_status,
  to_status public.problem_status,
  statement_version integer,
  notes_revision integer,
  -- Notes are snapshotted at completion and explicit checkpoints only, never per keystroke.
  notes_snapshot text,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint study_events_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade
);

create index study_events_problem_idx on public.study_events (problem_id, created_at desc);
create index study_events_user_idx on public.study_events (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Shared updated_at trigger
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger folders_touch before update on public.folders
  for each row execute function public.touch_updated_at();
create trigger problems_touch before update on public.problems
  for each row execute function public.touch_updated_at();
