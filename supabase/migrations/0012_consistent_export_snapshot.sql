-- One statement gives exports a true MVCC-consistent snapshot instead of a set
-- of independent PostgREST reads that can observe different revisions.
create or replace function public.read_export_snapshot(
  p_user_id uuid,
  p_scope public.export_scope,
  p_scope_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with scoped_problems as materialized (
    select p.* from public.problems p
     where p.user_id = p_user_id
       and (p_scope = 'account'
         or (p_scope = 'problem' and p.id = p_scope_id)
         or (p_scope = 'folder' and p.folder_id = p_scope_id))
  ), scoped_ids as materialized (select id from scoped_problems)
  select jsonb_build_object(
    'snapshotAt', now(),
    'folders', coalesce((select jsonb_agg(to_jsonb(f) order by f.created_at)
      from public.folders f where f.user_id = p_user_id
        and f.id in (select folder_id from scoped_problems)), '[]'::jsonb),
    'problems', coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at)
      from scoped_problems p), '[]'::jsonb),
    'statements', coalesce((select jsonb_agg(to_jsonb(v) order by v.problem_id, v.version)
      from public.problem_versions v where v.user_id = p_user_id and v.problem_id in (select id from scoped_ids)), '[]'::jsonb),
    'notes', coalesce((select jsonb_agg(to_jsonb(n) order by n.problem_id)
      from public.notes n where n.user_id = p_user_id and n.problem_id in (select id from scoped_ids)), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at)
      from public.study_events e where e.user_id = p_user_id and e.problem_id in (select id from scoped_ids)), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at)
      from public.chat_messages m where m.user_id = p_user_id and m.problem_id in (select id from scoped_ids)), '[]'::jsonb),
    'ideaProfiles', coalesce((select jsonb_agg(to_jsonb(i) order by i.created_at)
      from public.problem_idea_profiles i where i.user_id = p_user_id and i.problem_id in (select id from scoped_ids)), '[]'::jsonb),
    'recommendations', coalesce((select jsonb_agg(jsonb_build_object(
        'problemId', r.problem_id, 'sourceId', mp.source_id, 'title', mp.title,
        'relationship', ri.relationship,
        'sourceUrl', coalesce(mp.source_locator ->> 'explorer_url', mp.source_locator ->> 'url'),
        'attribution', mp.attribution) order by r.problem_id, ri.rank)
      from public.recommendation_items ri
      join public.recommendation_runs r on r.id = ri.run_id and r.user_id = ri.user_id
      join public.mathnet_problems mp on mp.id = ri.mathnet_problem_id
      where ri.user_id = p_user_id and r.problem_id in (select id from scoped_ids)), '[]'::jsonb)
  );
$$;

revoke execute on function public.read_export_snapshot(uuid, public.export_scope, uuid) from public, anon, authenticated;
grant execute on function public.read_export_snapshot(uuid, public.export_scope, uuid) to service_role;
