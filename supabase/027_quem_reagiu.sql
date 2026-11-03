-- =====================================================================
-- CC4 — quem reagiu (avisos) e reações nas mensagens do chat
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 026). Pode rodar de novo.
--
-- - Avisos: tocar num emoji mostra quem reagiu (antes só aparecia a contagem). Vê quem
--   vê o aviso (os membros, os que estão valendo; a liderança, todos)
-- - Chat: cada participante reage com um emoji por mensagem (como no WhatsApp); quem está
--   no grupo vê quem reagiu. Some sozinha se a mensagem for apagada ou a pessoa sair do grupo

-- ---------------------------------------------------------------------
-- 1. Avisos: quem reagiu
-- ---------------------------------------------------------------------
create or replace function public.announcement_reaction_people(p_announcement uuid)
returns table (emoji text, member_id uuid, name text, mine boolean)
language sql stable security definer set search_path = '' as $$
  select r.emoji, m.id, m.name, m.id = public.my_member_id(a.church_id)
  from public.announcement_reactions r
  join public.announcements a on a.id = r.announcement_id
  join public.members m on m.id = r.member_id
  where r.announcement_id = p_announcement
    and (a.church_id in (select public.my_church_ids('lideranca'))
         or (a.church_id in (select public.my_church_ids('membro'))
             and (a.visible_until is null or a.visible_until >= public.today_br())))
  order by r.created_at
$$;
revoke execute on function public.announcement_reaction_people(uuid) from public, anon;
grant execute on function public.announcement_reaction_people(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Chat: reações nas mensagens
-- ---------------------------------------------------------------------
create table if not exists public.chat_reactions (
  message_id uuid not null references public.chat_messages on delete cascade,
  group_id   uuid not null references public.chat_groups on delete cascade,
  member_id  uuid not null references public.members on delete cascade,
  emoji      text not null check (emoji in ('👍', '❤️', '🎉', '😂', '😮', '😢')),
  created_at timestamptz not null default now(),
  primary key (message_id, member_id)
);
create index if not exists chat_reactions_group_idx on public.chat_reactions (group_id);
create index if not exists chat_reactions_member_idx on public.chat_reactions (member_id);

-- Quem está no grupo lê; gravar, só pela função abaixo.
alter table public.chat_reactions enable row level security;
drop policy if exists "reacoes chat le" on public.chat_reactions;
create policy "reacoes chat le" on public.chat_reactions for select to authenticated using (public.chat_is_in(group_id));
revoke all on public.chat_reactions from anon;
revoke insert, update, delete on public.chat_reactions from authenticated;

-- Reagir (p_emoji) ou tirar a reação (p_emoji nulo). Só quem está no grupo; vale também
-- no grupo bloqueado (reagir não é mandar mensagem).
create or replace function public.chat_set_reaction(p_message uuid, p_emoji text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  x public.chat_messages;
  s public.chat_members;
begin
  select * into x from public.chat_messages where id = p_message;
  if x.id is not null then
    s := public.chat_my_seat(x.group_id);
  end if;
  if x.id is null or s.group_id is null or (x.file_path is not null and not x.file_ready) then
    raise exception 'Mensagem não encontrada.' using errcode = '42501';
  end if;
  if p_emoji is null then
    delete from public.chat_reactions where message_id = p_message and member_id = s.member_id;
  else
    insert into public.chat_reactions (message_id, group_id, member_id, emoji)
    values (p_message, x.group_id, s.member_id, p_emoji)
    on conflict (message_id, member_id) do update set emoji = excluded.emoji, created_at = now();
  end if;
end $$;
revoke execute on function public.chat_set_reaction(uuid, text) from public, anon;
grant execute on function public.chat_set_reaction(uuid, text) to authenticated;

-- Quem sai do grupo: as reações dele somem também.
create or replace function public.chat_reactions_on_leave()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from public.chat_reactions where group_id = old.group_id and member_id = old.member_id;
  return old;
end $$;
drop trigger if exists chat_reactions_on_leave on public.chat_members;
create trigger chat_reactions_on_leave after delete on public.chat_members
  for each row execute function public.chat_reactions_on_leave();
revoke execute on function public.chat_reactions_on_leave() from public, anon, authenticated;

-- As reações aparecem na hora para quem está com a conversa aberta (Realtime, com a regra de leitura acima).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_reactions') then
    alter publication supabase_realtime add table public.chat_reactions;
  end if;
end $$;

notify pgrst, 'reload schema';
