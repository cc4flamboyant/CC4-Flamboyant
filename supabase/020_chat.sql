-- =====================================================================
-- CC4 — chat em grupos
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 019). Pode rodar de novo.
--
-- - A liderança cria grupos e coloca quantas pessoas quiser da instituição de ensino
-- - Quem cria vira administrador do grupo; ele pode tornar outros administradores
-- - Mensagens com texto (emojis e links) e anexos: fotos, vídeos, áudios e documentos
-- - "Só administradores enviam": o grupo fica bloqueado para os outros participantes
-- - Só quem está no grupo lê as mensagens e os anexos (pasta privada "chat")
-- - Cada arquivo até 25 MB e até 500 MB de anexos por instituição de ensino (conferido no banco)
-- - Sem criptografia de ponta a ponta: a direção pode moderar (apagar mensagens)
-- - Ao sair da instituição ou excluir a conta, as mensagens ficam no grupo, sem o nome
--   (como os avisos e eventos)

-- ---------------------------------------------------------------------
-- 1. Funcionalidade e limites
-- ---------------------------------------------------------------------
create or replace function public.chat_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'chat')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.chat_on(uuid) from public, anon;
grant execute on function public.chat_on(uuid) to authenticated;

-- Espaço dos anexos por instituição de ensino (bytes) e tamanho de cada arquivo.
create or replace function public.chat_storage_limit()
returns bigint language sql immutable as $$ select 500::bigint * 1024 * 1024 $$;
create or replace function public.chat_file_limit()
returns bigint language sql immutable as $$ select 25::bigint * 1024 * 1024 $$;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.chat_groups (
  id              uuid primary key default gen_random_uuid(),
  church_id       uuid not null references public.churches on delete cascade,
  name            text not null check (char_length(name) between 2 and 60),
  description     text check (char_length(description) <= 300),
  locked          boolean not null default false, -- só os administradores do grupo enviam
  created_by      uuid default auth.uid() references auth.users on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now()
);
create index if not exists chat_groups_church_idx on public.chat_groups (church_id);

create table if not exists public.chat_members (
  group_id     uuid not null references public.chat_groups on delete cascade,
  member_id    uuid not null references public.members on delete cascade,
  is_admin     boolean not null default false,
  last_read_at timestamptz not null default now(),
  added_at     timestamptz not null default now(),
  primary key (group_id, member_id)
);
create index if not exists chat_members_member_idx on public.chat_members (member_id);

create table if not exists public.chat_messages (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.chat_groups on delete cascade,
  church_id    uuid not null references public.churches on delete cascade,
  author_id    uuid references public.members on delete set null,
  body         text check (char_length(body) <= 4000),
  file_path    text unique,
  file_name    text check (char_length(file_name) <= 200),
  file_type    text check (char_length(file_type) <= 100),
  file_size    bigint check (file_size >= 0),
  file_ready   boolean not null default false, -- o arquivo já chegou à pasta
  push_pending boolean not null default false,
  created_at   timestamptz not null default now(),
  check (nullif(trim(body), '') is not null or file_path is not null)
);
create index if not exists chat_messages_group_idx on public.chat_messages (group_id, created_at desc);
create index if not exists chat_messages_author_idx on public.chat_messages (author_id, created_at desc);
create index if not exists chat_messages_church_idx on public.chat_messages (church_id) where file_path is not null;

-- ---------------------------------------------------------------------
-- 3. Quem está no grupo e quem administra
-- ---------------------------------------------------------------------
-- O cadastro da pessoa no grupo (ativo, com o convite aceito e o chat ligado).
create or replace function public.chat_my_seat(p_group uuid)
returns public.chat_members language sql stable security definer set search_path = '' as $$
  select cm.* from public.chat_members cm
  join public.chat_groups g on g.id = cm.group_id
  join public.members m on m.id = cm.member_id
  where cm.group_id = p_group and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
    and public.chat_on(g.church_id)
$$;

create or replace function public.chat_is_in(p_group uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select (public.chat_my_seat(p_group)).group_id is not null
$$;

-- Administrador do grupo: marcado no grupo, ou administrador da instituição que está no grupo.
create or replace function public.chat_is_admin(p_group uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.is_admin or public.has_role(g.church_id, 'admin')
                   from public.chat_groups g cross join lateral public.chat_my_seat(g.id) s
                   where g.id = p_group and s.group_id is not null), false)
$$;

revoke execute on function public.chat_my_seat(uuid) from public, anon;
revoke execute on function public.chat_is_in(uuid) from public, anon;
revoke execute on function public.chat_is_admin(uuid) from public, anon;
grant execute on function public.chat_my_seat(uuid) to authenticated;
grant execute on function public.chat_is_in(uuid) to authenticated;
grant execute on function public.chat_is_admin(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 4. Regras de acesso (gravar, só pelas funções do item 6)
-- ---------------------------------------------------------------------
alter table public.chat_groups enable row level security;
drop policy if exists "grupos le" on public.chat_groups;
create policy "grupos le" on public.chat_groups for select to authenticated using (public.chat_is_in(id));
drop policy if exists "grupos edita" on public.chat_groups;
create policy "grupos edita" on public.chat_groups for update to authenticated
  using (public.chat_is_admin(id)) with check (public.chat_is_admin(id));
drop policy if exists "grupos apaga" on public.chat_groups;
create policy "grupos apaga" on public.chat_groups for delete to authenticated using (public.chat_is_admin(id));
revoke all on public.chat_groups from anon;
revoke insert, update on public.chat_groups from authenticated;
grant update (name, description, locked) on public.chat_groups to authenticated;

alter table public.chat_members enable row level security;
drop policy if exists "participantes le" on public.chat_members;
create policy "participantes le" on public.chat_members for select to authenticated using (public.chat_is_in(group_id));
revoke all on public.chat_members from anon;
revoke insert, update, delete on public.chat_members from authenticated;

-- Mensagens: quem está no grupo lê (as com arquivo, só depois que o arquivo chegou, menos as
-- da própria pessoa). Apagam o autor e os administradores do grupo.
alter table public.chat_messages enable row level security;
drop policy if exists "mensagens le" on public.chat_messages;
create policy "mensagens le" on public.chat_messages for select to authenticated
  using (public.chat_is_in(group_id)
         and (file_path is null or file_ready or author_id = public.my_member_id(church_id)));
drop policy if exists "mensagens apaga" on public.chat_messages;
create policy "mensagens apaga" on public.chat_messages for delete to authenticated
  using (public.chat_is_in(group_id)
         and (author_id = public.my_member_id(church_id) or public.chat_is_admin(group_id)));
revoke all on public.chat_messages from anon;
revoke insert, update on public.chat_messages from authenticated;

-- Mensagens novas aparecem na hora para quem está com a conversa aberta (Realtime, com as
-- mesmas regras de leitura acima).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 5. Arquivos: pasta privada "chat", em <instituição>/<grupo>/<mensagem>.<ext>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat', 'chat', false, 26214400, array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-m4a',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "chat participantes veem" on storage.objects;
create policy "chat participantes veem" on storage.objects for select to authenticated
  using (bucket_id = 'chat'
         and exists (select 1 from public.chat_messages x where x.file_path = name and public.chat_is_in(x.group_id)));
-- Só o arquivo de uma mensagem já registrada, pelo autor, uma vez.
drop policy if exists "chat autor envia" on storage.objects;
create policy "chat autor envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat'
              and exists (select 1 from public.chat_messages x
                          where x.file_path = name and not x.file_ready
                            and x.author_id = public.my_member_id(x.church_id) and public.chat_is_in(x.group_id)));
-- Apagam: o autor da mensagem, e os administradores do grupo (qualquer arquivo do grupo).
drop policy if exists "chat apaga" on storage.objects;
create policy "chat apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'chat'
         and (exists (select 1 from public.chat_messages x
                      where x.file_path = name and x.author_id = public.my_member_id(x.church_id))
              or exists (select 1 from public.chat_groups g
                         where g.id::text = (storage.foldername(name))[2]
                           and g.church_id::text = (storage.foldername(name))[1]
                           and public.chat_is_admin(g.id))));

-- ---------------------------------------------------------------------
-- 6. Funções das telas
-- ---------------------------------------------------------------------
-- Grupos da pessoa, com a última mensagem e quantas ainda não leu.
create or replace function public.chat_group_list(p_church uuid)
returns table (id uuid, name text, description text, locked boolean, is_admin boolean, members integer,
               last_message_at timestamptz, last_author text, last_body text, last_file text, unread integer)
language sql stable security definer set search_path = '' as $$
  select g.id, g.name, g.description, g.locked,
         s.is_admin or public.has_role(g.church_id, 'admin'),
         (select count(*)::integer from public.chat_members x where x.group_id = g.id),
         g.last_message_at,
         (select coalesce(m.name, 'Ex-membro') from public.members m where m.id = l.author_id),
         left(l.body, 120), l.file_name,
         (select count(*)::integer from public.chat_messages u
          where u.group_id = g.id and u.created_at > s.last_read_at
            and u.author_id is distinct from s.member_id and (u.file_path is null or u.file_ready))
  from public.chat_groups g
  join public.chat_members s on s.group_id = g.id
  join public.members me on me.id = s.member_id and me.user_id = auth.uid() and me.status = 'ativo' and me.consent_at is not null
  left join lateral (
    select x.author_id, x.body, x.file_name from public.chat_messages x
    where x.group_id = g.id and (x.file_path is null or x.file_ready)
    order by x.created_at desc limit 1
  ) l on true
  where g.church_id = p_church and public.chat_on(p_church)
  order by g.last_message_at desc
$$;

-- Participantes do grupo (nome e foto), para quem está nele.
create or replace function public.chat_group_members(p_group uuid)
returns table (member_id uuid, name text, photo_path text, is_admin boolean, is_me boolean, inst_admin boolean)
language sql stable security definer set search_path = '' as $$
  select m.id, m.name, m.photo_path, cm.is_admin or m.role = 'admin', m.user_id = auth.uid(), m.role = 'admin'
  from public.chat_members cm
  join public.members m on m.id = cm.member_id
  where cm.group_id = p_group and public.chat_is_in(p_group)
  order by cm.is_admin or m.role = 'admin' desc, m.name
$$;

-- Pessoas que podem entrar no grupo (ativas, que já usam o app e ainda não estão nele).
-- Sem grupo (p_group nulo): para criar um grupo, só a liderança.
create or replace function public.chat_candidates(p_church uuid, p_group uuid default null)
returns table (member_id uuid, name text, role text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.chat_on(p_church) then
    return;
  end if;
  if p_group is null then
    if not public.is_leader(p_church) then return; end if;
  elsif not coalesce(public.chat_is_admin(p_group), false)
        or not exists (select 1 from public.chat_groups g where g.id = p_group and g.church_id = p_church) then
    return;
  end if;
  return query
  select m.id, m.name, m.role from public.members m
  where m.church_id = p_church and m.status = 'ativo' and m.user_id is not null and m.consent_at is not null
    and (p_group is null or not exists (select 1 from public.chat_members cm where cm.group_id = p_group and cm.member_id = m.id))
  order by m.name;
end $$;

-- Cria o grupo: quem cria entra como administrador; os outros, como participantes.
create or replace function public.chat_create_group(p_church uuid, p_name text, p_description text, p_locked boolean, p_members uuid[])
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := public.my_member_id(p_church);
  v_id uuid;
begin
  if v_me is null or not coalesce(public.chat_on(p_church), false) or not coalesce(public.is_leader(p_church), false) then
    raise exception 'Só a liderança cria grupos de conversa.' using errcode = '42501';
  end if;
  if (select count(*) from public.chat_groups g where g.church_id = p_church and g.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Muitos grupos criados em pouco tempo. Tente de novo mais tarde.';
  end if;
  insert into public.chat_groups (church_id, name, description, locked)
  values (p_church, trim(p_name), nullif(trim(p_description), ''), coalesce(p_locked, false))
  returning id into v_id;
  insert into public.chat_members (group_id, member_id, is_admin) values (v_id, v_me, true);
  insert into public.chat_members (group_id, member_id)
  select v_id, m.id from public.members m
  where m.id = any (coalesce(p_members, '{}')) and m.id <> v_me
    and m.church_id = p_church and m.status = 'ativo' and m.user_id is not null and m.consent_at is not null
  on conflict do nothing;
  return v_id;
end $$;

-- Coloca pessoas no grupo (administrador do grupo). Devolve quantas entraram.
create or replace function public.chat_add_members(p_group uuid, p_members uuid[])
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
  v_n integer;
begin
  select g.church_id into v_church from public.chat_groups g where g.id = p_group;
  if v_church is null or not coalesce(public.chat_is_admin(p_group), false) then
    raise exception 'Só os administradores do grupo colocam pessoas.' using errcode = '42501';
  end if;
  insert into public.chat_members (group_id, member_id)
  select p_group, m.id from public.members m
  where m.id = any (coalesce(p_members, '{}'))
    and m.church_id = v_church and m.status = 'ativo' and m.user_id is not null and m.consent_at is not null
  on conflict do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Tira alguém do grupo (administrador) ou sai do grupo (a própria pessoa).
-- O grupo não fica sem administrador: se o último sair, o participante mais antigo assume.
create or replace function public.chat_remove_member(p_group uuid, p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_mine boolean;
begin
  select m.user_id = auth.uid() into v_mine from public.members m
  join public.chat_members cm on cm.member_id = m.id and cm.group_id = p_group
  where m.id = p_member;
  if v_mine is null
     or not ((v_mine and coalesce(public.chat_is_in(p_group), false)) or coalesce(public.chat_is_admin(p_group), false)) then
    raise exception 'Só os administradores do grupo tiram pessoas.' using errcode = '42501';
  end if;
  delete from public.chat_members where group_id = p_group and member_id = p_member;
  if not exists (select 1 from public.chat_members where group_id = p_group and is_admin) then
    update public.chat_members set is_admin = true
    where (group_id, member_id) = (select group_id, member_id from public.chat_members
                                   where group_id = p_group order by added_at limit 1);
  end if;
end $$;

-- Torna (ou deixa de ser) administrador do grupo.
create or replace function public.chat_set_admin(p_group uuid, p_member uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(public.chat_is_admin(p_group), false) then
    raise exception 'Só os administradores do grupo escolhem os administradores.' using errcode = '42501';
  end if;
  if not coalesce(p_on, false)
     and not exists (select 1 from public.chat_members where group_id = p_group and is_admin and member_id <> p_member) then
    raise exception 'O grupo precisa de pelo menos um administrador.';
  end if;
  update public.chat_members set is_admin = coalesce(p_on, false) where group_id = p_group and member_id = p_member;
end $$;

-- Envia uma mensagem (texto e, se houver, um arquivo). Devolve a mensagem; com arquivo, o
-- caminho para enviar o arquivo à pasta e depois chamar chat_file_ready.
create or replace function public.chat_send(p_group uuid, p_body text, p_file_name text default null,
                                            p_file_type text default null, p_file_size bigint default null, p_ext text default null)
returns table (id uuid, file_path text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  g public.chat_groups;
  s public.chat_members;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_body text := nullif(trim(p_body), '');
  v_now timestamptz := now();
begin
  select * into g from public.chat_groups x where x.id = p_group;
  s := public.chat_my_seat(p_group);
  if g.id is null or s.group_id is null then
    raise exception 'Você não está neste grupo.' using errcode = '42501';
  end if;
  if g.locked and not coalesce(public.chat_is_admin(p_group), false) then
    raise exception 'Só os administradores do grupo enviam mensagens.' using errcode = '42501';
  end if;
  if v_body is null and p_file_name is null then
    raise exception 'Escreva a mensagem ou escolha um arquivo.';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'A mensagem passou de 4.000 letras.';
  end if;
  -- Contra abuso: até 30 mensagens por minuto por pessoa.
  if (select count(*) from public.chat_messages x where x.author_id = s.member_id and x.created_at > v_now - interval '1 minute') >= 30 then
    raise exception 'Muitas mensagens em pouco tempo. Espere um pouco.';
  end if;
  if p_file_name is not null then
    if coalesce(p_file_size, 0) <= 0 or p_file_size > public.chat_file_limit() then
      raise exception 'O arquivo passa de 25 MB. Para vídeos maiores, mande o link (YouTube, Google Drive).';
    end if;
    perform pg_advisory_xact_lock(hashtext('chat:' || g.church_id::text));
    if coalesce((select sum(x.file_size) from public.chat_messages x where x.church_id = g.church_id and x.file_path is not null), 0)
       + p_file_size > public.chat_storage_limit() then
      raise exception 'O espaço dos anexos do chat acabou (500 MB). Peça para a direção apagar conversas ou arquivos antigos.';
    end if;
    v_path := g.church_id || '/' || g.id || '/' || v_id || '.' ||
              case when p_ext ~ '^[a-z0-9]{1,8}$' then p_ext else 'bin' end;
  end if;
  insert into public.chat_messages (id, group_id, church_id, author_id, body, file_path, file_name, file_type, file_size, push_pending, created_at)
  values (v_id, g.id, g.church_id, s.member_id, v_body, v_path, left(trim(p_file_name), 200), left(p_file_type, 100), p_file_size,
          v_path is null, v_now);
  update public.chat_groups x set last_message_at = v_now where x.id = g.id;
  update public.chat_members x set last_read_at = v_now where x.group_id = g.id and x.member_id = s.member_id;
  return query select v_id, v_path, v_now;
end $$;

-- O arquivo chegou à pasta: a mensagem aparece para o grupo (com o tamanho de verdade).
create or replace function public.chat_file_ready(p_message uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  x public.chat_messages;
  v_size bigint;
begin
  select * into x from public.chat_messages where id = p_message;
  if x.id is null or x.file_path is null or x.author_id is distinct from public.my_member_id(x.church_id) then
    raise exception 'Mensagem não encontrada.' using errcode = '42501';
  end if;
  select (o.metadata->>'size')::bigint into v_size from storage.objects o where o.bucket_id = 'chat' and o.name = x.file_path;
  if v_size is null then
    raise exception 'O arquivo ainda não chegou. Tente de novo.';
  end if;
  update public.chat_messages set file_ready = true, file_size = v_size, push_pending = not file_ready, created_at = now()
  where id = p_message;
  update public.chat_groups set last_message_at = now() where id = x.group_id;
end $$;

-- Marca as mensagens do grupo como lidas.
create or replace function public.chat_mark_read(p_group uuid)
returns void language sql security definer set search_path = '' as $$
  update public.chat_members cm set last_read_at = now()
  from public.members m
  where cm.group_id = p_group and m.id = cm.member_id and m.user_id = auth.uid() and public.chat_is_in(p_group)
$$;

-- Quanto do espaço dos anexos a instituição já usou (para a liderança).
create or replace function public.chat_storage_used(p_church uuid)
returns bigint language sql stable security definer set search_path = '' as $$
  select case when public.is_leader(p_church)
              then coalesce((select sum(x.file_size) from public.chat_messages x where x.church_id = p_church and x.file_path is not null), 0)
         end
$$;

-- Aviso no celular da mensagem nova (Edge Function enviar-push, com a senha ENVIO_SECRET):
-- uma vez por mensagem, até 10 minutos depois. Só diz quem escreveu, não o texto.
create or replace function public.claim_chat_push(p_secret text, p_message uuid)
returns table (church_slug text, group_id uuid, group_name text, author_name text, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  x public.chat_messages;
begin
  perform public.envio_check_secret(p_secret);
  update public.chat_messages m set push_pending = false
  where m.id = p_message and m.push_pending and m.created_at > now() - interval '10 minutes'
  returning m.* into x;
  if x.id is null then
    return;
  end if;
  return query
  select c.slug, g.id, g.name, coalesce(a.name, 'Ex-membro'), ps.endpoint, ps.p256dh, ps.auth
  from public.chat_groups g
  join public.churches c on c.id = g.church_id and c.active and not c.is_test
  join public.chat_members cm on cm.group_id = g.id and cm.member_id is distinct from x.author_id
  join public.members m on m.id = cm.member_id and m.status = 'ativo' and m.consent_at is not null
  join public.push_subscriptions ps on ps.user_id = m.user_id
  left join public.members a on a.id = x.author_id
  where g.id = x.group_id and public.chat_on(g.church_id);
end $$;

revoke execute on function public.chat_group_list(uuid) from public, anon;
revoke execute on function public.chat_group_members(uuid) from public, anon;
revoke execute on function public.chat_candidates(uuid, uuid) from public, anon;
revoke execute on function public.chat_create_group(uuid, text, text, boolean, uuid[]) from public, anon;
revoke execute on function public.chat_add_members(uuid, uuid[]) from public, anon;
revoke execute on function public.chat_remove_member(uuid, uuid) from public, anon;
revoke execute on function public.chat_set_admin(uuid, uuid, boolean) from public, anon;
revoke execute on function public.chat_send(uuid, text, text, text, bigint, text) from public, anon;
revoke execute on function public.chat_file_ready(uuid) from public, anon;
revoke execute on function public.chat_mark_read(uuid) from public, anon;
revoke execute on function public.chat_storage_used(uuid) from public, anon;
grant execute on function public.chat_group_list(uuid) to authenticated;
grant execute on function public.chat_group_members(uuid) to authenticated;
grant execute on function public.chat_candidates(uuid, uuid) to authenticated;
grant execute on function public.chat_create_group(uuid, text, text, boolean, uuid[]) to authenticated;
grant execute on function public.chat_add_members(uuid, uuid[]) to authenticated;
grant execute on function public.chat_remove_member(uuid, uuid) to authenticated;
grant execute on function public.chat_set_admin(uuid, uuid, boolean) to authenticated;
grant execute on function public.chat_send(uuid, text, text, text, bigint, text) to authenticated;
grant execute on function public.chat_file_ready(uuid) to authenticated;
grant execute on function public.chat_mark_read(uuid) to authenticated;
grant execute on function public.chat_storage_used(uuid) to authenticated;
-- Como claim_notification_push: a senha ENVIO_SECRET é conferida dentro da função.
revoke execute on function public.claim_chat_push(text, uuid) from public;
grant execute on function public.claim_chat_push(text, uuid) to anon;

-- ---------------------------------------------------------------------
-- 7. "Baixar meus dados" passa a trazer os grupos e as mensagens enviadas
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 8. Dados de teste: as instituições de teste ligam o chat
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"chat": true}'::jsonb
where slug in ('teste-a', 'teste-b');
