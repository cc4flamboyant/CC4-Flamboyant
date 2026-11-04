-- =====================================================================
-- CC4 — aniversários das crianças no Início, na lista do mês e na Agenda
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 032). Pode rodar de novo.
--
-- - As crianças (cadastro dos filhos) aparecem junto com os membros aniversariantes
-- - Por cuidado com dados de crianças, cada pessoa vê só as crianças com quem tem ligação:
--   o responsável vê os próprios filhos; o tutor, as crianças da sala dele; a liderança, todas.
--   Os outros membros não veem.
-- - Só com "Aniversários" e "Salas" ligados

create or replace function public.kids_birthdays_between(p_church uuid, p_from date, p_to date)
returns table (child_id uuid, name text, on_date date, years integer, room_name text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_leader boolean := coalesce(public.is_leader(p_church), false);
  v_features jsonb;
begin
  if not coalesce(public.is_member(p_church), false) then
    return;
  end if;
  if p_to < p_from or p_to - p_from > 62 then
    raise exception 'Período inválido (até 62 dias).';
  end if;
  select features into v_features from public.churches where id = p_church;
  if not (coalesce((v_features->>'aniversarios')::boolean, false) and coalesce((v_features->>'salas')::boolean, false)) then
    return;
  end if;
  return query
  select k.id, k.name, d::date,
         (extract(year from d) - extract(year from k.birth_date))::integer,
         r.name
  from public.children k
  left join public.room_children rc on rc.child_id = k.id
  left join public.kids_rooms r on r.id = rc.room_id
  join generate_series(p_from, p_to, interval '1 day') as d on public.is_birthday(k.birth_date, d::date)
  where k.church_id = p_church
    and (v_leader
         or k.id in (select public.my_children_ids())
         or (r.id is not null and public.is_room_tutor(r.id)))
  order by d, k.name;
end $$;
revoke execute on function public.kids_birthdays_between(uuid, date, date) from public, anon;
grant execute on function public.kids_birthdays_between(uuid, date, date) to authenticated;
