-- Validate and activate a fully built catalog release in one transaction.
create or replace function public.activate_mathnet_release(p_release_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected integer;
  v_indexed integer;
begin
  select eligible_count into v_expected from public.mathnet_releases
   where id = p_release_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;

  update public.mathnet_solution_data d
     set search_document = to_tsvector('english',
       coalesce(p.statement_markdown, '') || ' ' ||
       coalesce(array_to_string(d.idea_ids, ' '), '') || ' ' ||
       coalesce(d.mechanism, ''))
    from public.mathnet_problems p
   where d.mathnet_problem_id = p.id and d.release_id = p_release_id;

  select count(*) into v_indexed
    from public.mathnet_problems p
    join public.mathnet_solution_data d on d.mathnet_problem_id = p.id
   where p.release_id = p_release_id and p.is_eligible
     and d.statement_embedding is not null and d.idea_embedding is not null
     and d.search_document is not null and coalesce(array_length(d.idea_ids, 1), 0) > 0;

  if v_expected < 100 then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001', detail = 'fewer than 100 eligible fixtures';
  end if;
  if v_indexed <> v_expected then
    raise exception 'INVALID_REQUEST' using errcode = 'P0001',
      detail = format('indexed %s of %s eligible records', v_indexed, v_expected);
  end if;

  update public.mathnet_releases set is_active = false where is_active;
  update public.mathnet_releases set is_active = true, validated_at = now(), activated_at = now()
   where id = p_release_id;
  return jsonb_build_object('ok', true, 'release_id', p_release_id, 'indexed', v_indexed);
end;
$$;

revoke execute on function public.activate_mathnet_release(uuid) from public, anon, authenticated;
grant execute on function public.activate_mathnet_release(uuid) to service_role;
