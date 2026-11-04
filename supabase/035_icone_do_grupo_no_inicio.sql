-- =====================================================================
-- CC4 — ícone do atalho do grupo do chat no Início
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 034). Pode rodar de novo.
--
-- - No "Editar grupo", com "Mostrar no Início" marcado, o administrador escolhe o ícone do atalho
-- - Guarda só o nome de um ícone da lista do app; sem escolha, fica o balão do chat
-- - Quem grava é o administrador do grupo (a mesma regra do nome e da descrição)

alter table public.chat_groups add column if not exists home_icon text;

alter table public.chat_groups drop constraint if exists chat_groups_home_icon_ok;
alter table public.chat_groups add constraint chat_groups_home_icon_ok check (
  home_icon is null or home_icon in (
    'chat', 'users', 'megaphone', 'bell', 'calendar', 'clipboard', 'book', 'project',
    'child', 'heart', 'cake', 'image', 'camera', 'chart', 'pin', 'sun'
  )
);

grant update (home_icon) on public.chat_groups to authenticated;

-- A lista dos grupos traz também o ícone do atalho (recriada).
drop function if exists public.chat_group_list(uuid);
create function public.chat_group_list(p_church uuid)
returns table (id uuid, name text, description text, locked boolean, is_admin boolean, members integer,
               last_message_at timestamptz, last_author text, last_body text, last_file text, unread integer, icon_path text,
               sort_order integer, show_on_home boolean, home_icon text)
language sql stable security definer set search_path = '' as $$
  select g.id, g.name, g.description, g.locked,
         s.is_admin or public.has_role(g.church_id, 'admin'),
         (select count(*)::integer from public.chat_members x where x.group_id = g.id),
         g.last_message_at,
         (select coalesce(m.name, 'Ex-membro') from public.members m where m.id = l.author_id),
         left(l.body, 120), l.file_name,
         (select count(*)::integer from public.chat_messages u
          where u.group_id = g.id and u.created_at > s.last_read_at
            and u.author_id is distinct from s.member_id and (u.file_path is null or u.file_ready)),
         g.icon_path, s.sort_order, g.show_on_home, g.home_icon
  from public.chat_groups g
  join public.chat_members s on s.group_id = g.id
  join public.members me on me.id = s.member_id and me.user_id = auth.uid() and me.status = 'ativo' and me.consent_at is not null
  left join lateral (
    select x.author_id, x.body, x.file_name from public.chat_messages x
    where x.group_id = g.id and (x.file_path is null or x.file_ready)
    order by x.created_at desc limit 1
  ) l on true
  where g.church_id = p_church and public.chat_on(p_church)
  order by s.sort_order nulls first, g.last_message_at desc
$$;
revoke execute on function public.chat_group_list(uuid) from public, anon;
grant execute on function public.chat_group_list(uuid) to authenticated;
