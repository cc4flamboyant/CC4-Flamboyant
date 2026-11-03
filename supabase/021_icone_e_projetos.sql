-- =====================================================================
-- CC4 — ícone dos grupos do chat e projetos das salas
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 020). Pode rodar de novo.
--
-- Ícone do grupo: o administrador do grupo escolhe uma imagem (o app reduz no aparelho).
--
-- Projetos das salas (funcionalidade "projetos", junto com as salas):
-- - O tutor da sala e a liderança criam os projetos da sala: título, descrição, datas,
--   etapas (com prazo, marcadas como feitas), arquivos e fotos
-- - Veem: o tutor, a liderança e os responsáveis das crianças da sala (os pais de outras
--   salas, não). Todos que veem podem comentar
-- - Projeto novo avisa os pais da sala (central de notificações e celular)
-- - Cada arquivo até 25 MB e até 200 MB de arquivos de projetos por instituição de ensino

-- =====================================================================
-- PARTE 1 — Ícone do grupo do chat
-- =====================================================================
alter table public.chat_groups add column if not exists icon_path text check (char_length(icon_path) <= 300);
grant update (name, description, locked, icon_path) on public.chat_groups to authenticated;

-- O ícone fica na pasta do grupo: <instituição>/<grupo>/icone-<código>.webp
create or replace function public.chat_icon_ok(p_group uuid, p_path text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.chat_groups g where g.id = p_group
                 and p_path ~ ('^' || g.church_id || '/' || g.id || '/icone-[a-z0-9-]{1,40}\.(webp|jpg)$'))
$$;
revoke execute on function public.chat_icon_ok(uuid, text) from public, anon;
grant execute on function public.chat_icon_ok(uuid, text) to authenticated;

create or replace function public.chat_groups_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.icon_path is not null and new.icon_path is distinct from old.icon_path
     and not public.chat_icon_ok(new.id, new.icon_path) then
    raise exception 'Ícone inválido.' using errcode = '22023';
  end if;
  if new.church_id is distinct from old.church_id then
    raise exception 'O grupo não muda de instituição de ensino.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists chat_groups_guard on public.chat_groups;
create trigger chat_groups_guard before update on public.chat_groups
  for each row execute function public.chat_groups_guard();
revoke execute on function public.chat_groups_guard() from public, anon, authenticated;

-- Arquivo do ícone: o administrador do grupo envia; quem está no grupo vê. (Apagar já vale
-- pela regra "chat apaga" do 020: o administrador apaga os arquivos do grupo.)
drop policy if exists "chat icone envia" on storage.objects;
create policy "chat icone envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat'
              and exists (select 1 from public.chat_groups g
                          where g.id::text = (storage.foldername(objects.name))[2]
                            and public.chat_icon_ok(g.id, objects.name) and public.chat_is_admin(g.id)));
drop policy if exists "chat icone ve" on storage.objects;
create policy "chat icone ve" on storage.objects for select to authenticated
  using (bucket_id = 'chat'
         and exists (select 1 from public.chat_groups g
                     where g.id::text = (storage.foldername(objects.name))[2]
                       and public.chat_icon_ok(g.id, objects.name) and public.chat_is_in(g.id)));

-- A lista de grupos passa a trazer o ícone.
drop function if exists public.chat_group_list(uuid);
create function public.chat_group_list(p_church uuid)
returns table (id uuid, name text, description text, locked boolean, is_admin boolean, members integer,
               last_message_at timestamptz, last_author text, last_body text, last_file text, unread integer, icon_path text)
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
         g.icon_path
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
revoke execute on function public.chat_group_list(uuid) from public, anon;
grant execute on function public.chat_group_list(uuid) to authenticated;

-- =====================================================================
-- PARTE 2 — Projetos das salas
-- =====================================================================
-- ---------------------------------------------------------------------
-- 1. Funcionalidade, limites e quem pode o quê
-- ---------------------------------------------------------------------
create or replace function public.projetos_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'projetos')::boolean from public.churches c where c.id = p_church and c.active), false)
     and public.salas_on(p_church)
$$;

create or replace function public.project_storage_limit()
returns bigint language sql immutable as $$ select 200::bigint * 1024 * 1024 $$;

-- Cuida dos projetos da sala: o tutor dela e a liderança.
create or replace function public.can_room_projects(p_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select public.projetos_on(r.church_id) and public.can_room(r.id)
                   from public.kids_rooms r where r.id = p_room), false)
$$;

-- Vê os projetos da sala: quem cuida dela e os responsáveis das crianças da sala.
create or replace function public.sees_room_projects(p_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select public.projetos_on(r.church_id)
                          and (public.can_room(r.id)
                               or exists (select 1 from public.room_children rc
                                          where rc.room_id = r.id and rc.child_id in (select public.my_children_ids())))
                   from public.kids_rooms r where r.id = p_room), false)
$$;

revoke execute on function public.projetos_on(uuid) from public, anon;
revoke execute on function public.can_room_projects(uuid) from public, anon;
revoke execute on function public.sees_room_projects(uuid) from public, anon;
grant execute on function public.projetos_on(uuid) to authenticated;
grant execute on function public.can_room_projects(uuid) to authenticated;
grant execute on function public.sees_room_projects(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.room_projects (
  id          uuid primary key default gen_random_uuid(),
  room_id     uuid not null references public.kids_rooms on delete cascade,
  church_id   uuid not null references public.churches on delete cascade,
  title       text not null check (char_length(title) between 2 and 120),
  description text check (char_length(description) <= 4000),
  starts_on   date,
  due_on      date,
  created_by  uuid default auth.uid() references auth.users on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (due_on is null or starts_on is null or due_on >= starts_on)
);
create index if not exists room_projects_room_idx on public.room_projects (room_id, created_at desc);
create index if not exists room_projects_church_idx on public.room_projects (church_id);

create table if not exists public.project_steps (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.room_projects on delete cascade,
  title      text not null check (char_length(title) between 1 and 200),
  due_on     date,
  done_at    timestamptz,
  done_by    uuid references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists project_steps_project_idx on public.project_steps (project_id, created_at);

create table if not exists public.project_files (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.room_projects on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  path       text not null unique,
  file_name  text not null check (char_length(file_name) <= 200),
  file_type  text check (char_length(file_type) <= 100),
  file_size  bigint not null check (file_size >= 0),
  ready      boolean not null default false,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists project_files_project_idx on public.project_files (project_id, created_at);
create index if not exists project_files_church_idx on public.project_files (church_id);

create table if not exists public.project_comments (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.room_projects on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  author_id  uuid references public.members on delete set null,
  body       text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists project_comments_project_idx on public.project_comments (project_id, created_at);
create index if not exists project_comments_author_idx on public.project_comments (author_id);

-- ---------------------------------------------------------------------
-- 3. Regras de acesso
-- ---------------------------------------------------------------------
-- O projeto fica na instituição da sala (e não muda de sala).
create or replace function public.room_projects_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.room_id is distinct from old.room_id or new.church_id is distinct from old.church_id) then
    raise exception 'O projeto não muda de sala.' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    new.church_id := (select r.church_id from public.kids_rooms r where r.id = new.room_id);
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists room_projects_guard on public.room_projects;
create trigger room_projects_guard before insert or update on public.room_projects
  for each row execute function public.room_projects_guard();
revoke execute on function public.room_projects_guard() from public, anon, authenticated;

alter table public.room_projects enable row level security;
drop policy if exists "projetos le" on public.room_projects;
create policy "projetos le" on public.room_projects for select to authenticated using (public.sees_room_projects(room_id));
drop policy if exists "projetos cria" on public.room_projects;
create policy "projetos cria" on public.room_projects for insert to authenticated with check (public.can_room_projects(room_id));
drop policy if exists "projetos edita" on public.room_projects;
create policy "projetos edita" on public.room_projects for update to authenticated
  using (public.can_room_projects(room_id)) with check (public.can_room_projects(room_id));
drop policy if exists "projetos apaga" on public.room_projects;
create policy "projetos apaga" on public.room_projects for delete to authenticated using (public.can_room_projects(room_id));
revoke all on public.room_projects from anon;
revoke update on public.room_projects from authenticated;
grant update (title, description, starts_on, due_on) on public.room_projects to authenticated;

-- Sala do projeto (para as regras das etapas, arquivos e comentários).
create or replace function public.project_room(p_project uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select p.room_id from public.room_projects p where p.id = p_project
$$;
revoke execute on function public.project_room(uuid) from public, anon;
grant execute on function public.project_room(uuid) to authenticated;

-- Etapas: quem vê o projeto lê; quem cuida dos projetos da sala cria, marca e apaga.
alter table public.project_steps enable row level security;
drop policy if exists "etapas le" on public.project_steps;
create policy "etapas le" on public.project_steps for select to authenticated
  using (public.sees_room_projects(public.project_room(project_id)));
drop policy if exists "etapas cria" on public.project_steps;
create policy "etapas cria" on public.project_steps for insert to authenticated
  with check (public.can_room_projects(public.project_room(project_id)) and done_at is null and done_by is null);
drop policy if exists "etapas edita" on public.project_steps;
create policy "etapas edita" on public.project_steps for update to authenticated
  using (public.can_room_projects(public.project_room(project_id)))
  with check (public.can_room_projects(public.project_room(project_id)));
drop policy if exists "etapas apaga" on public.project_steps;
create policy "etapas apaga" on public.project_steps for delete to authenticated
  using (public.can_room_projects(public.project_room(project_id)));
revoke all on public.project_steps from anon;
revoke update on public.project_steps from authenticated;
grant update (title, due_on, done_at) on public.project_steps to authenticated;

-- Quem marcou a etapa como feita (o app não escolhe).
create or replace function public.project_steps_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is distinct from old.project_id then
    raise exception 'A etapa não muda de projeto.' using errcode = '42501';
  end if;
  if new.done_at is distinct from old.done_at then
    new.done_at := case when new.done_at is null then null else now() end;
    new.done_by := case when new.done_at is null then null else auth.uid() end;
  end if;
  return new;
end $$;
drop trigger if exists project_steps_guard on public.project_steps;
create trigger project_steps_guard before update on public.project_steps
  for each row execute function public.project_steps_guard();
revoke execute on function public.project_steps_guard() from public, anon, authenticated;

-- Arquivos: quem vê o projeto lê (depois que o arquivo chegou); registrar, só pela função.
-- Apagam: quem cuida dos projetos da sala.
alter table public.project_files enable row level security;
drop policy if exists "arquivos projeto le" on public.project_files;
create policy "arquivos projeto le" on public.project_files for select to authenticated
  using (public.sees_room_projects(public.project_room(project_id)) and (ready or created_by = auth.uid()));
drop policy if exists "arquivos projeto apaga" on public.project_files;
create policy "arquivos projeto apaga" on public.project_files for delete to authenticated
  using (public.can_room_projects(public.project_room(project_id)));
revoke all on public.project_files from anon;
revoke insert, update on public.project_files from authenticated;

-- Comentários: quem vê o projeto lê; escrever, só pela função. Apagam o autor e quem cuida da sala.
alter table public.project_comments enable row level security;
drop policy if exists "comentarios le" on public.project_comments;
create policy "comentarios le" on public.project_comments for select to authenticated
  using (public.sees_room_projects(public.project_room(project_id)));
drop policy if exists "comentarios apaga" on public.project_comments;
create policy "comentarios apaga" on public.project_comments for delete to authenticated
  using (author_id = public.my_member_id(church_id) or public.can_room_projects(public.project_room(project_id)));
revoke all on public.project_comments from anon;
revoke insert, update on public.project_comments from authenticated;

-- ---------------------------------------------------------------------
-- 4. Arquivos: pasta privada "projetos", em <instituição>/<projeto>/<arquivo>.<ext>
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('projetos', 'projetos', false, 26214400, array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp',
  'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-m4a',
  'application/pdf', 'text/plain', 'text/csv', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "projetos veem" on storage.objects;
create policy "projetos veem" on storage.objects for select to authenticated
  using (bucket_id = 'projetos'
         and exists (select 1 from public.project_files f
                     where f.path = name and public.sees_room_projects(public.project_room(f.project_id))));
drop policy if exists "projetos envia" on storage.objects;
create policy "projetos envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'projetos'
              and exists (select 1 from public.project_files f
                          where f.path = name and not f.ready and f.created_by = auth.uid()
                            and public.can_room_projects(public.project_room(f.project_id))));
drop policy if exists "projetos apaga arquivo" on storage.objects;
create policy "projetos apaga arquivo" on storage.objects for delete to authenticated
  using (bucket_id = 'projetos'
         and exists (select 1 from public.room_projects p
                     where p.id::text = (storage.foldername(name))[2]
                       and p.church_id::text = (storage.foldername(name))[1]
                       and public.can_room_projects(p.room_id)));

-- ---------------------------------------------------------------------
-- 5. Funções das telas
-- ---------------------------------------------------------------------
-- Projetos que a pessoa vê, com a sala e o andamento das etapas.
create or replace function public.projects_list(p_church uuid)
returns table (id uuid, room_id uuid, room_name text, title text, starts_on date, due_on date,
               steps integer, steps_done integer, files integer, comments integer, can_edit boolean, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.id, p.room_id, r.name, p.title, p.starts_on, p.due_on,
         (select count(*)::integer from public.project_steps s where s.project_id = p.id),
         (select count(*)::integer from public.project_steps s where s.project_id = p.id and s.done_at is not null),
         (select count(*)::integer from public.project_files f where f.project_id = p.id and f.ready),
         (select count(*)::integer from public.project_comments c where c.project_id = p.id),
         public.can_room_projects(p.room_id), p.created_at
  from public.room_projects p
  join public.kids_rooms r on r.id = p.room_id
  where p.church_id = p_church and public.sees_room_projects(p.room_id)
  order by coalesce(p.due_on, p.created_at::date) desc, p.created_at desc
$$;

-- Comentários com o nome de quem escreveu (os pais não leem o cadastro dos outros).
create or replace function public.project_comment_list(p_project uuid)
returns table (id uuid, author_id uuid, author_name text, body text, created_at timestamptz, mine boolean, can_delete boolean)
language sql stable security definer set search_path = '' as $$
  select c.id, c.author_id, coalesce(m.name, 'Ex-membro'), c.body, c.created_at,
         m.user_id is not distinct from auth.uid() and m.id is not null,
         (m.user_id is not distinct from auth.uid() and m.id is not null) or public.can_room_projects(p.room_id)
  from public.project_comments c
  join public.room_projects p on p.id = c.project_id
  left join public.members m on m.id = c.author_id
  where c.project_id = p_project and public.sees_room_projects(p.room_id)
  order by c.created_at
$$;

-- Comentar (quem vê o projeto). Contra abuso: até 30 comentários por hora por pessoa.
create or replace function public.project_comment(p_project uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  p public.room_projects;
  v_me uuid;
  v_id uuid;
begin
  select * into p from public.room_projects where id = p_project;
  if p.id is null or not public.sees_room_projects(p.room_id) then
    raise exception 'Projeto não encontrado.' using errcode = '42501';
  end if;
  v_me := public.my_member_id(p.church_id);
  if v_me is null then
    raise exception 'Projeto não encontrado.' using errcode = '42501';
  end if;
  if nullif(trim(p_body), '') is null then
    raise exception 'Escreva o comentário.' using errcode = '22023';
  end if;
  if (select count(*) from public.project_comments c where c.author_id = v_me and c.created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Muitos comentários em pouco tempo. Espere um pouco.' using errcode = '54000';
  end if;
  insert into public.project_comments (project_id, church_id, author_id, body)
  values (p.id, p.church_id, v_me, trim(left(p_body, 2000)))
  returning id into v_id;
  return v_id;
end $$;

-- Registra um arquivo do projeto (antes de enviar) e devolve o caminho. Confere o espaço.
create or replace function public.project_add_file(p_project uuid, p_name text, p_type text, p_size bigint, p_ext text)
returns table (file_id uuid, path text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  p public.room_projects;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  select * into p from public.room_projects x where x.id = p_project;
  if p.id is null or not public.can_room_projects(p.room_id) then
    raise exception 'Só o tutor da sala e a liderança enviam arquivos.' using errcode = '42501';
  end if;
  if coalesce(p_size, 0) <= 0 or p_size > public.chat_file_limit() then
    raise exception 'O arquivo passa de 25 MB. Para vídeos maiores, mande o link (YouTube, Google Drive) na descrição.';
  end if;
  perform pg_advisory_xact_lock(hashtext('projetos:' || p.church_id::text));
  if coalesce((select sum(f.file_size) from public.project_files f where f.church_id = p.church_id), 0) + p_size
     > public.project_storage_limit() then
    raise exception 'O espaço dos arquivos de projetos acabou (200 MB). Apague arquivos de projetos antigos.';
  end if;
  v_path := p.church_id || '/' || p.id || '/' || v_id || '.' || case when p_ext ~ '^[a-z0-9]{1,8}$' then p_ext else 'bin' end;
  insert into public.project_files (id, project_id, church_id, path, file_name, file_type, file_size)
  values (v_id, p.id, p.church_id, v_path, left(trim(coalesce(nullif(p_name, ''), 'arquivo')), 200), left(p_type, 100), p_size);
  return query select v_id, v_path;
end $$;

-- O arquivo chegou à pasta: aparece para quem vê o projeto (com o tamanho de verdade).
create or replace function public.project_file_ready(p_file uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  f public.project_files;
  v_size bigint;
begin
  select * into f from public.project_files where id = p_file;
  if f.id is null or f.created_by is distinct from auth.uid() then
    raise exception 'Arquivo não encontrado.' using errcode = '42501';
  end if;
  select (o.metadata->>'size')::bigint into v_size from storage.objects o where o.bucket_id = 'projetos' and o.name = f.path;
  if v_size is null then
    raise exception 'O arquivo ainda não chegou. Tente de novo.';
  end if;
  update public.project_files set ready = true, file_size = v_size where id = p_file;
end $$;

-- Projeto novo: avisa os pais da sala (só o título; o texto fica no app).
create or replace function public.room_projects_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select distinct m.user_id, new.church_id, 'sala',
         left('Sala ' || r.name || ': novo projeto', 120), left(new.title, 200),
         '#/projetos/' || new.id, 'projeto:' || new.id, true
  from public.kids_rooms r
  join public.room_children rc on rc.room_id = r.id
  join public.children c on c.id = rc.child_id
  join public.members m on m.id = c.guardian_member_id
  where r.id = new.room_id and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
    and m.user_id is distinct from auth.uid()
  on conflict do nothing;
  return null;
end $$;
drop trigger if exists room_projects_notify on public.room_projects;
create trigger room_projects_notify after insert on public.room_projects
  for each row execute function public.room_projects_notify();
revoke execute on function public.room_projects_notify() from public, anon, authenticated;

revoke execute on function public.projects_list(uuid) from public, anon;
revoke execute on function public.project_comment_list(uuid) from public, anon;
revoke execute on function public.project_comment(uuid, text) from public, anon;
revoke execute on function public.project_add_file(uuid, text, text, bigint, text) from public, anon;
revoke execute on function public.project_file_ready(uuid) from public, anon;
grant execute on function public.projects_list(uuid) to authenticated;
grant execute on function public.project_comment_list(uuid) to authenticated;
grant execute on function public.project_comment(uuid, text) to authenticated;
grant execute on function public.project_add_file(uuid, text, text, bigint, text) to authenticated;
grant execute on function public.project_file_ready(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 6. "Baixar meus dados" passa a trazer os comentários nos projetos
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

-- ---------------------------------------------------------------------
-- 7. Dados de teste: as instituições de teste ligam os projetos
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"projetos": true}'::jsonb
where slug in ('teste-a', 'teste-b');
