-- Pinned MathNET catalog, its server-only solution data, and recommendation runs.
-- The catalog is shared reference data built offline by scripts/mathnet-import.ts.
-- Private student content is never used to build it.

create type public.recommendation_trigger as enum ('completion', 'manual');
create type public.recommendation_state as enum ('QUEUED', 'RUNNING', 'READY', 'NO_MATCH', 'FAILED');

-- Embedding dimension for the pinned Voyage model. Changing models requires a new
-- migration and a full catalog rebuild: indexed data and queries must agree.
-- voyage-3 / voyage-3-large default output dimension is 1024.

-- ---------------------------------------------------------------------------
-- mathnet_releases — one row per pinned dataset revision
-- ---------------------------------------------------------------------------

create table public.mathnet_releases (
  id uuid primary key default extensions.gen_random_uuid(),
  dataset_id text not null,
  revision text not null,
  schema_version text not null,
  import_manifest jsonb not null default '{}'::jsonb,
  imported_count integer not null default 0,
  eligible_count integer not null default 0,
  -- Exclusions are counted separately: missing language, absent solutions,
  -- diagram-dependent, missing permission.
  exclusion_counts jsonb not null default '{}'::jsonb,
  license text,
  source_url text,
  checksums jsonb not null default '{}'::jsonb,
  index_version integer not null default 1,
  -- Only one release/index version is active; activation is atomic after validation.
  is_active boolean not null default false,
  validated_at timestamptz,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  unique (dataset_id, revision, index_version)
);

create unique index mathnet_releases_single_active_idx
  on public.mathnet_releases (is_active) where is_active;

-- ---------------------------------------------------------------------------
-- mathnet_problems — catalog statements (no solutions here)
-- ---------------------------------------------------------------------------

create table public.mathnet_problems (
  id uuid primary key default extensions.gen_random_uuid(),
  release_id uuid not null references public.mathnet_releases (id) on delete cascade,
  -- Source ids stay strings and are namespaced by release.
  source_id text not null,
  title text,
  statement_markdown text not null,
  language text,
  country text,
  competition text,
  topics text[] not null default '{}',
  problem_type text,
  source_locator jsonb not null default '{}'::jsonb,
  content_hash text not null,
  -- Eligibility for the recommendation pool.
  is_english boolean not null default false,
  is_text_complete boolean not null default false,
  has_images boolean not null default false,
  has_solution boolean not null default false,
  rights_cleared boolean not null default false,
  exclusion_reason text,
  is_eligible boolean not null default false,
  attribution jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (release_id, source_id)
);

create index mathnet_problems_hash_idx on public.mathnet_problems (release_id, content_hash);
create index mathnet_problems_eligible_idx on public.mathnet_problems (release_id, is_eligible);
create index mathnet_problems_fts_idx
  on public.mathnet_problems using gin (to_tsvector('english', coalesce(title, '') || ' ' || statement_markdown));

-- ---------------------------------------------------------------------------
-- mathnet_solution_data — PRIVATE. Solutions and solution-derived idea profiles.
-- ---------------------------------------------------------------------------

create table public.mathnet_solution_data (
  mathnet_problem_id uuid primary key references public.mathnet_problems (id) on delete cascade,
  release_id uuid not null references public.mathnet_releases (id) on delete cascade,
  solutions_markdown text,
  final_answer text,
  idea_ids text[] not null default '{}',
  secondary_idea_ids text[] not null default '{}',
  mechanism text,
  evidence jsonb not null default '[]'::jsonb,
  evidence_kind text not null default 'statement_only',
  confidence real not null default 0,
  -- Lexical document combining statement, topics, idea labels and mechanism.
  search_document tsvector,
  statement_embedding extensions.vector(1024),
  idea_embedding extensions.vector(1024),
  embedding_model text,
  embedding_dimension integer,
  profile_version text,
  created_at timestamptz not null default now()
);

create index mathnet_solution_search_idx on public.mathnet_solution_data using gin (search_document);
create index mathnet_solution_idea_tags_idx on public.mathnet_solution_data using gin (idea_ids);
create index mathnet_statement_embedding_idx
  on public.mathnet_solution_data using hnsw (statement_embedding extensions.vector_cosine_ops);
create index mathnet_idea_embedding_idx
  on public.mathnet_solution_data using hnsw (idea_embedding extensions.vector_cosine_ops);

comment on table public.mathnet_solution_data is
  'Server-only. Solution-derived idea tags may themselves reveal the trick.';

-- ---------------------------------------------------------------------------
-- recommendation_runs
-- ---------------------------------------------------------------------------

create table public.recommendation_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  problem_id uuid not null,
  statement_version integer not null,
  notes_revision integer,
  profile_hash text not null,
  trigger public.recommendation_trigger not null,
  release_id uuid references public.mathnet_releases (id) on delete set null,
  index_version integer not null default 1,
  retrieval_version text not null,
  filters jsonb not null default '{}'::jsonb,
  state public.recommendation_state not null default 'QUEUED',
  -- Ordered candidate ids with fusion and rerank scores.
  candidates jsonb not null default '[]'::jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint recommendation_runs_problem_owned_fkey
    foreign key (problem_id, user_id) references public.problems (id, user_id) on delete cascade,
  unique (id, user_id)
);

create index recommendation_runs_cache_idx
  on public.recommendation_runs (problem_id, statement_version, profile_hash, index_version, retrieval_version, created_at desc);
create index recommendation_runs_user_idx on public.recommendation_runs (user_id, created_at desc);

create table public.recommendation_items (
  id uuid primary key default extensions.gen_random_uuid(),
  run_id uuid not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  mathnet_problem_id uuid not null references public.mathnet_problems (id) on delete cascade,
  rank integer not null,
  fusion_score real,
  relationship text,
  -- Tentative results (no solution evidence) carry no mathematical advice.
  is_tentative boolean not null default false,
  saved_problem_id uuid,
  dismissed_at timestamptz,
  relevance_feedback text,
  created_at timestamptz not null default now(),
  constraint recommendation_items_run_owned_fkey
    foreign key (run_id, user_id) references public.recommendation_runs (id, user_id) on delete cascade,
  unique (run_id, mathnet_problem_id)
);

create index recommendation_items_run_idx on public.recommendation_items (run_id, rank);
create index recommendation_items_user_source_idx on public.recommendation_items (user_id, mathnet_problem_id);
