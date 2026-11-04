-- =====================================================================
-- CC4 — grupo do chat no Início, ordem das salas e do chat, semana da sala e pedidos de oração
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 031). Pode rodar de novo.
--
-- 1. Chat: o administrador do grupo escolhe se o grupo aparece como atalho no Início
--    (só para quem está no grupo)
-- 2. Salas: a liderança organiza a ordem arrastando; cada sala tem a semana (1 a 30),
--    que aparece no cartão da sala
-- 3. Chat: cada pessoa organiza a ordem da própria lista de grupos arrastando
-- 4. Pedidos de oração (como no Igreja Conecta): o membro envia só para a direção
--    (administrador e líderes) ou para a instituição orar junto (passa pela aprovação da
--    direção antes de ir para o mural, por 30 dias, com "Estou orando"). Pode ser anônimo
--    para os membros. Avisos na central (e push) para a direção e para o autor.
--    Funcionalidade "oracao", ligada em Configurar a instituição de ensino.

-- ---------------------------------------------------------------------
-- 1. Grupo do chat no Início
-- ---------------------------------------------------------------------
alter table public.chat_groups add column if not exists show_on_home boolean not null default false;
grant update (show_on_home) on public.chat_groups to authenticated;

-- ---------------------------------------------------------------------
-- 2. Salas: ordem e semana
-- ---------------------------------------------------------------------
alter table public.kids_rooms add column if not exists sort_order integer;
alter table public.kids_rooms add column if not exists week smallint;
alter table public.kids_rooms drop constraint if exists kids_rooms_week_check;
alter table public.kids_rooms add constraint kids_rooms_week_check check (week is null or week between 1 and 30);
grant update (week) on public.kids_rooms to authenticated;

-- A liderança grava a ordem nova (a lista inteira, na ordem em que ficou).
create or replace function public.rooms_reorder(p_church uuid, p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.is_leader(p_church), false) then
    raise exception 'Só a liderança organiza as salas.' using errcode = '42501';
  end if;
  update public.kids_rooms r set sort_order = x.pos
  from unnest(p_ids) with ordinality as x(id, pos)
  where r.id = x.id and r.church_id = p_church;
end $$;
revoke execute on function public.rooms_reorder(uuid, uuid[]) from public, anon;
grant execute on function public.rooms_reorder(uuid, uuid[]) to authenticated;

-- A lista das salas traz a ordem e a semana (mudou o formato: recriada).
drop function if exists public.rooms_list(uuid);
create function public.rooms_list(p_church uuid)
returns table (id uuid, name text, description text, tutor_member_id uuid, tutor_name text, kids integer,
               is_tutor boolean, my_children uuid[], sort_order integer, week smallint)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not coalesce(public.salas_on(p_church) and public.is_member(p_church), false) then
    return;
  end if;
  return query
  select r.id, r.name, r.description, r.tutor_member_id, t.name,
         (select count(*)::integer from public.room_children rc where rc.room_id = r.id),
         public.is_room_tutor(r.id),
         coalesce((select array_agg(rc.child_id) from public.room_children rc
                   where rc.room_id = r.id and rc.child_id in (select public.my_children_ids())), '{}'::uuid[]),
         r.sort_order, r.week
  from public.kids_rooms r
  left join public.members t on t.id = r.tutor_member_id
  where r.church_id = p_church
    and (public.is_leader(p_church) or public.is_room_tutor(r.id)
         or exists (select 1 from public.room_children rc
                    where rc.room_id = r.id and rc.child_id in (select public.my_children_ids())))
  order by r.sort_order nulls last, r.name;
end $$;
revoke execute on function public.rooms_list(uuid) from public, anon;
grant execute on function public.rooms_list(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Chat: a ordem da lista de cada pessoa
-- ---------------------------------------------------------------------
alter table public.chat_members add column if not exists sort_order integer;

create or replace function public.chat_reorder(p_church uuid, p_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.chat_members s set sort_order = x.pos
  from unnest(p_ids) with ordinality as x(id, pos), public.members me
  where s.group_id = x.id and s.member_id = me.id and me.user_id = auth.uid() and me.church_id = p_church;
end $$;
revoke execute on function public.chat_reorder(uuid, uuid[]) from public, anon;
grant execute on function public.chat_reorder(uuid, uuid[]) to authenticated;

-- A lista dos grupos traz a ordem da pessoa e se o grupo vai para o Início (recriada).
drop function if exists public.chat_group_list(uuid);
create function public.chat_group_list(p_church uuid)
returns table (id uuid, name text, description text, locked boolean, is_admin boolean, members integer,
               last_message_at timestamptz, last_author text, last_body text, last_file text, unread integer, icon_path text,
               sort_order integer, show_on_home boolean)
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
         g.icon_path, s.sort_order, g.show_on_home
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

-- ---------------------------------------------------------------------
-- 4. Pedidos de oração (do Igreja Conecta, 009_oracao)
-- ---------------------------------------------------------------------
-- Nível "pastoral" (a direção: administrador e líderes; a secretaria não lê os pedidos).
create or replace function public.my_church_ids(p_level text default 'membro')
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.church_id
  from public.members m
  join public.churches c on c.id = m.church_id
  where m.user_id = auth.uid()
    and m.status = 'ativo'
    and m.consent_at is not null
    and c.active
    and case p_level
          when 'membro' then true
          when 'lideranca' then m.role in ('admin', 'secretaria', 'lider')
          when 'pastoral' then m.role in ('admin', 'lider')
          when 'admin' then m.role = 'admin'
          else false
        end
$$;

create or replace function public.is_pastoral(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_role(p_church, 'admin', 'lider')
$$;

create or replace function public.prayer_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'oracao')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;

create table if not exists public.prayer_requests (
  id           uuid primary key default gen_random_uuid(),
  church_id    uuid not null references public.churches on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users on delete cascade,
  body         text not null check (char_length(body) between 3 and 500),
  audience     text not null check (audience in ('pastores', 'igreja')),  -- só a direção, ou a instituição toda
  anonymous    boolean not null default false,
  -- privado: só para a direção; pendente/aprovado/recusado: para a instituição
  status       text not null check (status in ('privado', 'pendente', 'aprovado', 'recusado')),
  moderated_at timestamptz,
  moderated_by uuid references auth.users on delete set null,
  cared_at     timestamptz,                 -- "já orei / já conversei" (pedidos só para a direção)
  answered_at  timestamptz,                 -- "Deus respondeu", marcado pelo autor
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (audience = 'igreja' or (status = 'privado' and not anonymous)),
  check (audience = 'pastores' or status <> 'privado')
);
create index if not exists prayer_requests_church_idx on public.prayer_requests (church_id, status, created_at desc);
create index if not exists prayer_requests_user_idx on public.prayer_requests (user_id);

-- Quem está orando por cada pedido (ninguém lê pelo app; o mural mostra só o total).
create table if not exists public.prayer_praying (
  request_id uuid not null references public.prayer_requests on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
alter table public.prayer_praying enable row level security;
revoke all on public.prayer_praying from anon, authenticated;

-- O que cada um pode mudar. O autor só marca "Deus respondeu"; a direção modera (aprova,
-- recusa, corrige o texto antes) e marca "já orei".
create or replace function public.prayer_requests_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_pastor boolean;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if (select count(*) from public.prayer_requests p
        where p.user_id = auth.uid() and p.created_at > now() - interval '1 day') >= 10 then
      raise exception 'Você já enviou muitos pedidos hoje. Tente de novo amanhã.' using errcode = '54000';
    end if;
    new.user_id := auth.uid();
    new.status := case when new.audience = 'igreja' then 'pendente' else 'privado' end;
    new.anonymous := new.audience = 'igreja' and new.anonymous;
    new.moderated_at := null;
    new.moderated_by := null;
    new.cared_at := null;
    new.answered_at := null;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;

  v_pastor := public.is_pastoral(old.church_id);
  if (new.church_id, new.user_id, new.audience, new.anonymous, new.created_at)
     is distinct from (old.church_id, old.user_id, old.audience, old.anonymous, old.created_at) then
    raise exception 'Este campo não pode ser alterado.' using errcode = '42501';
  end if;
  if new.answered_at is distinct from old.answered_at and old.user_id <> auth.uid() then
    raise exception 'Só quem fez o pedido marca que Deus respondeu.' using errcode = '42501';
  end if;
  if (new.body, new.status, new.cared_at) is distinct from (old.body, old.status, old.cared_at) and not v_pastor then
    raise exception 'Só a direção (administrador e líderes) modera os pedidos de oração.' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if old.status = 'privado' or new.status not in ('aprovado', 'recusado') then
      raise exception 'Mudança de situação inválida.' using errcode = '42501';
    end if;
    new.moderated_at := now();
    new.moderated_by := auth.uid();
  else
    new.moderated_at := old.moderated_at;
    new.moderated_by := old.moderated_by;
  end if;
  if new.body is distinct from old.body and old.status not in ('pendente', 'recusado') then
    raise exception 'Só dá para corrigir o texto antes de aprovar.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists prayer_requests_guard on public.prayer_requests;
create trigger prayer_requests_guard before insert or update on public.prayer_requests
  for each row execute function public.prayer_requests_guard();

alter table public.prayer_requests enable row level security;
-- Lê a tabela: o autor (os próprios) e a direção (todos da instituição). Os outros membros veem
-- os aprovados só pelo mural (prayer_wall), sem o autor dos anônimos.
drop policy if exists "oracao le" on public.prayer_requests;
create policy "oracao le" on public.prayer_requests for select to authenticated
  using ((user_id = (select auth.uid()) and church_id in (select public.my_church_ids('membro')))
         or church_id in (select public.my_church_ids('pastoral')));
drop policy if exists "oracao membro envia" on public.prayer_requests;
create policy "oracao membro envia" on public.prayer_requests for insert to authenticated
  with check (church_id in (select public.my_church_ids('membro')) and public.prayer_on(church_id));
drop policy if exists "oracao edita" on public.prayer_requests;
create policy "oracao edita" on public.prayer_requests for update to authenticated
  using ((user_id = (select auth.uid()) and church_id in (select public.my_church_ids('membro')))
         or church_id in (select public.my_church_ids('pastoral')))
  with check (church_id in (select public.my_church_ids('membro')));
drop policy if exists "oracao apaga" on public.prayer_requests;
create policy "oracao apaga" on public.prayer_requests for delete to authenticated
  using (user_id = (select auth.uid()) or church_id in (select public.my_church_ids('pastoral')));
revoke all on public.prayer_requests from anon;
revoke update on public.prayer_requests from authenticated;
grant update (body, status, cared_at, answered_at) on public.prayer_requests to authenticated;

-- Mural: os aprovados dos últimos 30 dias, com quantos estão orando.
create or replace function public.prayer_wall(p_church uuid)
returns table (id uuid, body text, author text, anonymous boolean, approved_at timestamptz,
               answered_at timestamptz, praying integer, i_pray boolean, mine boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_pastor boolean := public.is_pastoral(p_church);
begin
  if not public.is_member(p_church) or not public.prayer_on(p_church) then
    return;
  end if;
  return query
  select p.id, p.body,
         case when p.anonymous and not v_pastor and p.user_id <> auth.uid() then null else m.name end,
         p.anonymous, p.moderated_at, p.answered_at,
         (select count(*)::integer from public.prayer_praying x where x.request_id = p.id),
         exists (select 1 from public.prayer_praying x where x.request_id = p.id and x.user_id = auth.uid()),
         p.user_id = auth.uid()
  from public.prayer_requests p
  left join public.members m on m.church_id = p.church_id and m.user_id = p.user_id
  where p.church_id = p_church and p.status = 'aprovado' and p.moderated_at > now() - interval '30 days'
  order by p.moderated_at desc
  limit 200;
end $$;

-- Liga ou desliga o "Estou orando" e devolve o total.
create or replace function public.prayer_toggle(p_request uuid)
returns table (praying integer, i_pray boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_church uuid;
begin
  select p.church_id into v_church from public.prayer_requests p
  where p.id = p_request and p.status = 'aprovado' and p.moderated_at > now() - interval '30 days';
  if v_church is null or not public.is_member(v_church) or not public.prayer_on(v_church) then
    raise exception 'Pedido não encontrado.' using errcode = '42501';
  end if;
  delete from public.prayer_praying x where x.request_id = p_request and x.user_id = auth.uid();
  if not found then
    insert into public.prayer_praying (request_id, user_id) values (p_request, auth.uid());
  end if;
  return query
  select (select count(*)::integer from public.prayer_praying x where x.request_id = p_request),
         exists (select 1 from public.prayer_praying x where x.request_id = p_request and x.user_id = auth.uid());
end $$;

revoke execute on function public.prayer_wall(uuid) from public, anon;
revoke execute on function public.prayer_toggle(uuid) from public, anon;
grant execute on function public.prayer_wall(uuid) to authenticated;
grant execute on function public.prayer_toggle(uuid) to authenticated;
revoke execute on function public.is_pastoral(uuid) from public, anon;
grant execute on function public.is_pastoral(uuid) to authenticated;
revoke execute on function public.prayer_on(uuid) from public, anon;
grant execute on function public.prayer_on(uuid) to authenticated;

-- Avisos na central (e push, pelo envio dos lembretes). O texto do pedido não vai na
-- notificação (aparece na tela de bloqueio do celular).
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'sala', 'galeria', 'oracao'));

create or replace function public.prayer_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    select m.user_id, new.church_id, 'oracao',
           case when new.status = 'privado' then 'Novo pedido de oração' else 'Pedido de oração para aprovar' end,
           case when new.status = 'privado' then 'Só para a direção. Toque para ler.' else 'Para o mural da instituição. Toque para ler e aprovar.' end,
           '#/oracao/moderar', 'oracao:' || new.id, true
    from public.members m
    where m.church_id = new.church_id and m.role in ('admin', 'lider') and m.status = 'ativo'
      and m.user_id is not null and m.consent_at is not null and m.user_id <> new.user_id
    on conflict do nothing;
  elsif new.status is distinct from old.status and new.status in ('aprovado', 'recusado') then
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
    values (new.user_id, new.church_id, 'oracao',
            case when new.status = 'aprovado' then 'Seu pedido de oração está no mural' else 'Seu pedido de oração não foi para o mural' end,
            case when new.status = 'aprovado' then 'Todos já podem orar com você.' else 'A direção recebeu o pedido e vai orar por você.' end,
            '#/oracao/meus', 'oracao-' || new.status || ':' || new.id, true)
    on conflict do nothing;
  end if;
  return null;
end $$;
revoke execute on function public.prayer_notify() from public, anon, authenticated;
drop trigger if exists prayer_notify on public.prayer_requests;
create trigger prayer_notify after insert or update of status on public.prayer_requests
  for each row execute function public.prayer_notify();

-- Sair da instituição: apaga também os pedidos de oração dela.
create or replace function public.leave_church(p_church uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  perform public.assert_not_last_admin(auth.uid(), p_church);
  delete from public.prayer_praying x using public.prayer_requests p
   where x.request_id = p.id and x.user_id = auth.uid() and p.church_id = p_church;
  delete from public.prayer_requests where user_id = auth.uid() and church_id = p_church;
  delete from public.notifications where user_id = auth.uid() and church_id = p_church;
  delete from public.members where user_id = auth.uid() and church_id = p_church;
end $$;

-- As instituições de teste ligam os pedidos de oração.
update public.churches set features = features || '{"oracao": true}'::jsonb
where slug in ('teste-a', 'teste-b');

-- "Baixar meus dados" com os pedidos de oração (o resto igual ao 028).
create or replace function public.export_my_data()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'exportado_em', now(),
    'aviso', 'Dados que o app guarda sobre você. Dados de outras pessoas não aparecem aqui.',
    'conta', (
      select jsonb_build_object(
        'email', u.email,
        'criada_em', u.created_at,
        'ultimo_acesso', u.last_sign_in_at,
        'entrou_com', coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb),
        'administrador_da_plataforma', exists (select 1 from public.platform_admins p where p.user_id = u.id))
      from auth.users u where u.id = v_user),
    'igrejas', coalesce((
      select jsonb_agg(jsonb_build_object(
        'igreja', c.name,
        'endereco_no_app', '/i/' || c.slug || '/',
        'papel', m.role,
        'situacao', m.status,
        'convite_aceito_em', m.consent_at,
        'cadastrado_em', m.created_at,
        'cadastro', jsonb_build_object(
          'nome', m.name,
          'email', m.email,
          'telefone', m.phone,
          'nascimento', m.birth_date,
          'casamento', m.wedding_date,
          'batismo', m.baptism_date,
          'foto', m.photo_path,
          'mostra_aniversario_aos_membros', m.show_birthday,
          'mostra_casamento_aos_membros', m.show_wedding,
          'mostra_batismo_aos_membros', m.show_baptism,
          'mostra_telefone_aos_membros', m.show_phone,
          'membro_desde', m.member_since,
          'qr_da_carteirinha_gerado_em', m.card_token_at,
          'publica_na_galeria', m.gallery_publisher),
        'tutor_das_salas', coalesce((
          select jsonb_agg(r.name order by r.name) from public.kids_rooms r where r.tutor_member_id = m.id), '[]'::jsonb),
        'mensagens_enviadas', coalesce((
          select jsonb_agg(jsonb_build_object('tipo', l.kind, 'canal', l.channel, 'data', l.target_date, 'situacao', l.status)
                           order by l.target_date desc)
          from public.message_log l where l.member_id = m.id), '[]'::jsonb))
        order by c.name)
      from public.members m join public.churches c on c.id = m.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'filhos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'igreja', ch.name, 'nome', c.name, 'nascimento', c.birth_date, 'alergias_e_cuidados', c.care_notes,
        'autorizado_em', c.consent_at,
        'sala', (select r.name from public.room_children rc join public.kids_rooms r on r.id = rc.room_id where rc.child_id = c.id),
        'presencas', coalesce((
          select jsonb_agg(s.session_date order by s.session_date desc)
          from public.room_attendance a join public.room_sessions s on s.id = a.session_id
          where a.child_id = c.id), '[]'::jsonb)) order by c.name)
      from public.children c
      join public.members m on m.id = c.guardian_member_id
      join public.churches ch on ch.id = c.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'pedidos_para_tirar_fotos_da_galeria', coalesce((
      select jsonb_agg(jsonb_build_object('motivo', r.reason, 'pedido_em', r.created_at) order by r.created_at desc)
      from public.gallery_removal_requests r where r.user_id = v_user), '[]'::jsonb),
    'notificacoes', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'tipo', n.kind, 'titulo', n.title, 'texto', n.body,
                                          'criada_em', n.created_at, 'lida_em', n.read_at) order by n.created_at desc)
      from public.notifications n join public.churches c on c.id = n.church_id
      where n.user_id = v_user), '[]'::jsonb),
    'aparelhos_com_notificacao', coalesce((
      select jsonb_agg(jsonb_build_object('servico', split_part(split_part(ps.endpoint, '://', 2), '/', 1), 'ativado_em', ps.created_at))
      from public.push_subscriptions ps where ps.user_id = v_user), '[]'::jsonb),
    'reacoes_aos_avisos', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'aviso', a.title, 'reacao', r.emoji, 'em', r.created_at) order by r.created_at)
      from public.announcement_reactions r
      join public.members me on me.id = r.member_id and me.user_id = v_user
      join public.announcements a on a.id = r.announcement_id
      join public.churches c on c.id = a.church_id), '[]'::jsonb),
    'grupos_de_conversa', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'grupo', g.name, 'administrador', cm.is_admin, 'desde', cm.added_at) order by cm.added_at)
      from public.chat_members cm
      join public.members me on me.id = cm.member_id and me.user_id = v_user
      join public.chat_groups g on g.id = cm.group_id
      join public.churches c on c.id = g.church_id), '[]'::jsonb),
    'mensagens_enviadas_no_chat', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'grupo', g.name, 'texto', x.body, 'arquivo', x.file_name, 'em', x.created_at) order by x.created_at)
      from public.chat_messages x
      join public.members me on me.id = x.author_id and me.user_id = v_user
      join public.chat_groups g on g.id = x.group_id
      join public.churches c on c.id = g.church_id), '[]'::jsonb),
    'reacoes_no_chat', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'grupo', g.name, 'reacao', r.emoji, 'em', r.created_at) order by r.created_at)
      from public.chat_reactions r
      join public.members me on me.id = r.member_id and me.user_id = v_user
      join public.chat_groups g on g.id = r.group_id
      join public.churches c on c.id = g.church_id), '[]'::jsonb),
    'pedidos_de_oracao', coalesce((
      select jsonb_agg(jsonb_build_object('instituicao', c.name, 'pedido', p.body,
                                          'para', case when p.audience = 'igreja' then 'a instituição' else 'a direção' end,
                                          'anonimo', p.anonymous, 'situacao', p.status, 'enviado_em', p.created_at,
                                          'deus_respondeu_em', p.answered_at) order by p.created_at desc)
      from public.prayer_requests p join public.churches c on c.id = p.church_id
      where p.user_id = v_user), '[]'::jsonb),
    'orando_por', (select count(*) from public.prayer_praying x where x.user_id = v_user),
    'comentarios_em_projetos', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'projeto', p.title, 'comentario', x.body, 'em', x.created_at) order by x.created_at)
      from public.project_comments x
      join public.members me on me.id = x.author_id and me.user_id = v_user
      join public.room_projects p on p.id = x.project_id
      join public.churches c on c.id = p.church_id), '[]'::jsonb),
    'publicado_por_voce', jsonb_build_object(
      'eventos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', e.title, 'inicio', e.starts_at, 'criado_em', e.created_at))
        from public.events e join public.churches c on c.id = e.church_id where e.created_by = v_user), '[]'::jsonb),
      'avisos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', a.title, 'criado_em', a.created_at))
        from public.announcements a join public.churches c on c.id = a.church_id where a.created_by = v_user), '[]'::jsonb),
      'albuns_da_galeria', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'album', g.title, 'data', g.album_date, 'criado_em', g.created_at))
        from public.gallery_albums g join public.churches c on c.id = g.church_id where g.created_by = v_user), '[]'::jsonb),
      'fotos_enviadas', (select count(*) from public.gallery_photos p where p.created_by = v_user),
      'anotacoes_de_aula', (select count(*) from public.room_sessions s where s.created_by = v_user),
      'avisos_para_os_pais', (select count(*) from public.room_messages x where x.created_by = v_user),
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;
revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;

notify pgrst, 'reload schema';
