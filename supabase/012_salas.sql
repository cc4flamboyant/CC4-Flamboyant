-- =====================================================================
-- Meus filhos e salas das crianças
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - O responsável cadastra os filhos no app (com autorização, LGPD); a liderança
--   também cadastra, com o nome e o WhatsApp do responsável
-- - A liderança cria as salas, escolhe o tutor de cada uma (um membro da igreja)
--   e coloca as crianças na sala (cada criança fica em uma sala)
-- - O tutor vê as crianças da sala dele (idade, alergias e cuidados, contato do
--   responsável), marca a presença de cada aula, escreve as anotações do dia
--   (os pais leem) e manda avisos para os pais da sala (até 10 por dia)
-- - Os dados das crianças: só o responsável, o tutor da sala e a liderança
-- - Aulas, presenças e avisos são apagados depois de 12 meses
-- - Funcionalidade "salas" (Configurar a igreja): liga Meus filhos e as salas
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade e tipo de notificação
-- ---------------------------------------------------------------------
create or replace function public.salas_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'salas')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.salas_on(uuid) from public, anon;
grant execute on function public.salas_on(uuid) to authenticated;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'sala'));

-- O próprio cadastro da pessoa na igreja (para ser o responsável ou o tutor).
create or replace function public.my_member_id(p_church uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select m.id from public.members m
  where m.church_id = p_church and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;
revoke execute on function public.my_member_id(uuid) from public, anon;
grant execute on function public.my_member_id(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
-- Criança: ligada ao cadastro do responsável (que usa o app) ou, se a liderança cadastrou,
-- com o nome e o WhatsApp do responsável. Sair da igreja ou excluir a conta apaga os filhos.
create table if not exists public.children (
  id                 uuid primary key default gen_random_uuid(),
  church_id          uuid not null references public.churches on delete cascade,
  name               text not null check (char_length(name) between 2 and 120),
  birth_date         date check (birth_date > '1990-01-01'),
  care_notes         text check (char_length(care_notes) <= 300),   -- alergias e cuidados
  guardian_member_id uuid references public.members on delete cascade,
  guardian_name      text check (char_length(guardian_name) between 2 and 120),
  guardian_phone     text check (guardian_phone ~ '^55[0-9]{10,11}$'),
  consent_at         timestamptz not null default now(),             -- autorização do responsável
  created_by         uuid default auth.uid() references auth.users on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (guardian_member_id is not null or guardian_name is not null)
);
create index if not exists children_church_idx on public.children (church_id, name);
create index if not exists children_guardian_idx on public.children (guardian_member_id);

-- Sala: o tutor é um membro da igreja (sem tutor, só a liderança cuida da sala).
create table if not exists public.kids_rooms (
  id              uuid primary key default gen_random_uuid(),
  church_id       uuid not null references public.churches on delete cascade,
  name            text not null check (char_length(name) between 2 and 40),
  description     text check (char_length(description) <= 200),
  tutor_member_id uuid references public.members on delete set null,
  created_at      timestamptz not null default now(),
  unique (church_id, name)
);
create index if not exists kids_rooms_tutor_idx on public.kids_rooms (tutor_member_id);

-- Criança na sala: uma sala por criança.
create table if not exists public.room_children (
  child_id  uuid primary key references public.children on delete cascade,
  room_id   uuid not null references public.kids_rooms on delete cascade,
  church_id uuid not null references public.churches on delete cascade,
  added_at  timestamptz not null default now(),
  added_by  uuid default auth.uid() references auth.users on delete set null
);
create index if not exists room_children_room_idx on public.room_children (room_id);

-- Aula (um dia da sala): as anotações do dia, que os pais leem.
create table if not exists public.room_sessions (
  id           uuid primary key default gen_random_uuid(),
  room_id      uuid not null references public.kids_rooms on delete cascade,
  church_id    uuid not null references public.churches on delete cascade,
  session_date date not null default public.today_br(),
  notes        text check (char_length(notes) <= 2000),
  created_by   uuid default auth.uid() references auth.users on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (room_id, session_date)
);

create table if not exists public.room_attendance (
  session_id uuid not null references public.room_sessions on delete cascade,
  child_id   uuid not null references public.children on delete cascade,
  marked_by  uuid default auth.uid() references auth.users on delete set null,
  marked_at  timestamptz not null default now(),
  primary key (session_id, child_id)
);
create index if not exists room_attendance_child_idx on public.room_attendance (child_id);

-- Avisos do tutor para os pais da sala (também vão para a central de notificações).
create table if not exists public.room_messages (
  id         uuid primary key default gen_random_uuid(),
  room_id    uuid not null references public.kids_rooms on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  title      text not null check (char_length(title) between 2 and 80),
  body       text check (char_length(body) <= 1000),
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists room_messages_room_idx on public.room_messages (room_id, created_at desc);

-- ---------------------------------------------------------------------
-- 3. Quem pode o quê
-- ---------------------------------------------------------------------
-- Tutor da sala (membro ativo, com a funcionalidade ligada).
create or replace function public.is_room_tutor(p_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.kids_rooms r
    join public.members m on m.id = r.tutor_member_id
    where r.id = p_room and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
      and public.salas_on(r.church_id)
  )
$$;

-- Cuida da sala: a liderança ou o tutor dela.
create or replace function public.can_room(p_room uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((
    select public.salas_on(r.church_id) and (public.is_leader(r.church_id) or public.is_room_tutor(r.id))
    from public.kids_rooms r where r.id = p_room), false)
$$;

-- Filhos da pessoa (em todas as igrejas dela).
create or replace function public.my_children_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select c.id from public.children c
  join public.members m on m.id = c.guardian_member_id
  where m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;

-- Crianças das salas em que a pessoa é tutor.
create or replace function public.my_tutor_children_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select rc.child_id from public.room_children rc
  join public.kids_rooms r on r.id = rc.room_id
  join public.members m on m.id = r.tutor_member_id
  where m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null and public.salas_on(r.church_id)
$$;

revoke execute on function public.is_room_tutor(uuid) from public, anon;
revoke execute on function public.can_room(uuid) from public, anon;
revoke execute on function public.my_children_ids() from public, anon;
revoke execute on function public.my_tutor_children_ids() from public, anon;
grant execute on function public.is_room_tutor(uuid) to authenticated;
grant execute on function public.can_room(uuid) to authenticated;
grant execute on function public.my_children_ids() to authenticated;
grant execute on function public.my_tutor_children_ids() to authenticated;

-- Crianças: o responsável cuida dos próprios filhos; a liderança, de todas; o tutor só lê as da sala.
alter table public.children enable row level security;
drop policy if exists "criancas le" on public.children;
create policy "criancas le" on public.children for select to authenticated
  using (public.salas_on(church_id)
         and ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
              or public.is_leader(church_id)
              or id in (select public.my_tutor_children_ids())));
drop policy if exists "criancas cadastra" on public.children;
create policy "criancas cadastra" on public.children for insert to authenticated
  with check (public.salas_on(church_id)
              and ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
                   or public.is_leader(church_id)));
drop policy if exists "criancas edita" on public.children;
create policy "criancas edita" on public.children for update to authenticated
  using ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
         or public.is_leader(church_id))
  with check ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
              or public.is_leader(church_id));
drop policy if exists "criancas apaga" on public.children;
create policy "criancas apaga" on public.children for delete to authenticated
  using ((guardian_member_id is not null and guardian_member_id = public.my_member_id(church_id))
         or public.is_leader(church_id));
revoke all on public.children from anon;
revoke update on public.children from authenticated;
grant update (name, birth_date, care_notes, guardian_name, guardian_phone, updated_at) on public.children to authenticated;

-- security definer: confere o responsável mesmo sem ler o cadastro dos outros.
create or replace function public.children_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.guardian_member_id is not null
     and not exists (select 1 from public.members m where m.id = new.guardian_member_id and m.church_id = new.church_id) then
    raise exception 'O responsável precisa ser do cadastro da mesma instituição de ensino.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.church_id <> old.church_id or new.guardian_member_id is distinct from old.guardian_member_id) then
    raise exception 'Não dá para trocar a instituição de ensino nem o responsável.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists children_guard on public.children;
create trigger children_guard before insert or update on public.children
  for each row execute function public.children_guard();
revoke execute on function public.children_guard() from public, anon, authenticated;

-- Salas: os membros veem (para saber a sala do filho e o tutor); a liderança cria, muda e apaga.
alter table public.kids_rooms enable row level security;
drop policy if exists "salas le" on public.kids_rooms;
create policy "salas le" on public.kids_rooms for select to authenticated
  using (church_id in (select public.my_church_ids()) and public.salas_on(church_id));
drop policy if exists "salas lideranca cria" on public.kids_rooms;
create policy "salas lideranca cria" on public.kids_rooms for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')) and public.salas_on(church_id));
drop policy if exists "salas lideranca edita" on public.kids_rooms;
create policy "salas lideranca edita" on public.kids_rooms for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "salas lideranca apaga" on public.kids_rooms;
create policy "salas lideranca apaga" on public.kids_rooms for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
revoke all on public.kids_rooms from anon;
revoke update on public.kids_rooms from authenticated;
grant update (name, description, tutor_member_id) on public.kids_rooms to authenticated;

-- O tutor precisa ser um membro da mesma igreja; a sala não muda de igreja.
create or replace function public.kids_rooms_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.tutor_member_id is not null
     and not exists (select 1 from public.members m where m.id = new.tutor_member_id and m.church_id = new.church_id) then
    raise exception 'O tutor precisa ser do cadastro da mesma instituição de ensino.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.church_id <> old.church_id then
    raise exception 'A sala não muda de instituição de ensino.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists kids_rooms_guard on public.kids_rooms;
create trigger kids_rooms_guard before insert or update on public.kids_rooms
  for each row execute function public.kids_rooms_guard();
revoke execute on function public.kids_rooms_guard() from public, anon, authenticated;

-- Criança na sala: a liderança, o tutor da sala e o responsável veem. Gravar, só por room_assign.
alter table public.room_children enable row level security;
drop policy if exists "sala criancas le" on public.room_children;
create policy "sala criancas le" on public.room_children for select to authenticated
  using (public.can_room(room_id) or child_id in (select public.my_children_ids()));
revoke all on public.room_children from anon;
revoke insert, update, delete on public.room_children from authenticated;

-- Aulas: quem cuida da sala e os pais das crianças da sala. Gravar, só pelas funções.
alter table public.room_sessions enable row level security;
drop policy if exists "aulas le" on public.room_sessions;
create policy "aulas le" on public.room_sessions for select to authenticated
  using (public.can_room(room_id)
         or room_id in (select rc.room_id from public.room_children rc where rc.child_id in (select public.my_children_ids())));
revoke all on public.room_sessions from anon;
revoke insert, update, delete on public.room_sessions from authenticated;

-- Presenças: quem cuida da sala e o responsável (só as dos próprios filhos).
alter table public.room_attendance enable row level security;
drop policy if exists "presencas sala le" on public.room_attendance;
create policy "presencas sala le" on public.room_attendance for select to authenticated
  using (child_id in (select public.my_children_ids())
         or session_id in (select s.id from public.room_sessions s where public.can_room(s.room_id)));
revoke all on public.room_attendance from anon;
revoke insert, update, delete on public.room_attendance from authenticated;

-- Avisos da sala: quem cuida da sala e os pais das crianças da sala.
alter table public.room_messages enable row level security;
drop policy if exists "avisos sala le" on public.room_messages;
create policy "avisos sala le" on public.room_messages for select to authenticated
  using (public.can_room(room_id)
         or room_id in (select rc.room_id from public.room_children rc where rc.child_id in (select public.my_children_ids())));
revoke all on public.room_messages from anon;
revoke insert, update, delete on public.room_messages from authenticated;

-- ---------------------------------------------------------------------
-- 4. Funções das telas
-- ---------------------------------------------------------------------
-- Coloca a criança numa sala (ou tira, com p_room nulo). Só a liderança.
create or replace function public.room_assign(p_child uuid, p_room uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select c.church_id into v_church from public.children c where c.id = p_child;
  if v_church is null or not coalesce(public.salas_on(v_church) and public.is_leader(v_church), false) then
    raise exception 'Só a liderança coloca as crianças nas salas.' using errcode = '42501';
  end if;
  if p_room is null then
    delete from public.room_children where child_id = p_child;
    return;
  end if;
  if not exists (select 1 from public.kids_rooms r where r.id = p_room and r.church_id = v_church) then
    raise exception 'Sala não encontrada.' using errcode = '22023';
  end if;
  insert into public.room_children (child_id, room_id, church_id)
  values (p_child, p_room, v_church)
  on conflict (child_id) do update
    set room_id = excluded.room_id, added_at = now(), added_by = auth.uid();
end $$;

-- Crianças da sala para o tutor e a liderança: idade, cuidados, responsável e a presença do dia.
create or replace function public.room_roster(p_room uuid, p_day date default null)
returns table (id uuid, name text, birth_date date, care_notes text, guardian text, phone text, has_app boolean, present boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.can_room(p_room) then
    return;
  end if;
  return query
  select c.id, c.name, c.birth_date, c.care_notes,
         coalesce(m.name, c.guardian_name), coalesce(m.phone, c.guardian_phone),
         m.user_id is not null and m.consent_at is not null,
         exists (select 1 from public.room_attendance a
                 join public.room_sessions s on s.id = a.session_id
                 where a.child_id = c.id and s.room_id = p_room and s.session_date = coalesce(p_day, public.today_br()))
  from public.room_children rc
  join public.children c on c.id = rc.child_id
  left join public.members m on m.id = c.guardian_member_id
  where rc.room_id = p_room
  order by c.name;
end $$;

-- Abre (ou acha) a aula do dia e grava as anotações (nulo = não mexe nas anotações).
create or replace function public.room_session_save(p_room uuid, p_day date, p_notes text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
  v_id uuid;
begin
  if not public.can_room(p_room) then
    raise exception 'Só o tutor da sala e a liderança registram as aulas.' using errcode = '42501';
  end if;
  if p_day is null or p_day > public.today_br() + 1 or p_day < public.today_br() - 365 then
    raise exception 'Data da aula inválida.' using errcode = '22023';
  end if;
  select r.church_id into v_church from public.kids_rooms r where r.id = p_room;
  insert into public.room_sessions (room_id, church_id, session_date, notes)
  values (p_room, v_church, p_day, nullif(trim(left(p_notes, 2000)), ''))
  on conflict (room_id, session_date) do update
    set notes = case when p_notes is null then public.room_sessions.notes else nullif(trim(left(p_notes, 2000)), '') end,
        updated_at = now()
  returning id into v_id;
  return v_id;
end $$;

-- Marca (ou desmarca) a presença de uma criança da sala na aula do dia.
create or replace function public.room_mark(p_room uuid, p_day date, p_child uuid, p_present boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_session uuid;
begin
  if not public.can_room(p_room) then
    raise exception 'Só o tutor da sala e a liderança marcam a presença.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.room_children rc where rc.room_id = p_room and rc.child_id = p_child) then
    raise exception 'A criança não está nesta sala.' using errcode = '22023';
  end if;
  v_session := public.room_session_save(p_room, p_day, null);
  if coalesce(p_present, false) then
    insert into public.room_attendance (session_id, child_id) values (v_session, p_child) on conflict do nothing;
  else
    delete from public.room_attendance where session_id = v_session and child_id = p_child;
  end if;
end $$;

-- Aviso para os pais da sala: fica na sala e vai para a central (com push). Até 10 por sala por dia.
create or replace function public.room_notify(p_room uuid, p_title text, p_body text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
  v_name text;
  v_msg uuid;
  v_count integer;
begin
  if not public.can_room(p_room) then
    raise exception 'Só o tutor da sala e a liderança avisam os pais.' using errcode = '42501';
  end if;
  if char_length(trim(coalesce(p_title, ''))) < 2 then
    raise exception 'Escreva o título do aviso.' using errcode = '22023';
  end if;
  if (select count(*) from public.room_messages m
      where m.room_id = p_room and (m.created_at at time zone 'America/Sao_Paulo')::date = public.today_br()) >= 10 then
    raise exception 'Limite de 10 avisos por dia nesta sala.' using errcode = '54000';
  end if;
  select r.church_id, r.name into v_church, v_name from public.kids_rooms r where r.id = p_room;
  insert into public.room_messages (room_id, church_id, title, body)
  values (p_room, v_church, trim(left(p_title, 80)), nullif(trim(left(p_body, 1000)), ''))
  returning id into v_msg;
  -- O texto não vai na notificação (aparece na tela de bloqueio): só o título.
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select distinct m.user_id, v_church, 'sala', left('Sala ' || v_name || ': ' || trim(p_title), 120),
         'Toque para ler o aviso.', '#/filhos/sala/' || p_room, 'sala:' || v_msg, true
  from public.room_children rc
  join public.children c on c.id = rc.child_id
  join public.members m on m.id = c.guardian_member_id
  where rc.room_id = p_room and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
    and m.user_id <> auth.uid()
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Salas que a pessoa vê, com o nome do tutor: a liderança, todas; o tutor, as dele; os pais, as dos filhos.
-- (Os membros não leem o cadastro dos outros; o nome do tutor vem por aqui.)
create or replace function public.rooms_list(p_church uuid)
returns table (id uuid, name text, description text, tutor_member_id uuid, tutor_name text, kids integer,
               is_tutor boolean, my_children uuid[])
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
                   where rc.room_id = r.id and rc.child_id in (select public.my_children_ids())), '{}'::uuid[])
  from public.kids_rooms r
  left join public.members t on t.id = r.tutor_member_id
  where r.church_id = p_church
    and (public.is_leader(p_church) or public.is_room_tutor(r.id)
         or exists (select 1 from public.room_children rc
                    where rc.room_id = r.id and rc.child_id in (select public.my_children_ids())))
  order by r.name;
end $$;
revoke execute on function public.rooms_list(uuid) from public, anon;
grant execute on function public.rooms_list(uuid) to authenticated;

revoke execute on function public.room_assign(uuid, uuid) from public, anon;
revoke execute on function public.room_roster(uuid, date) from public, anon;
revoke execute on function public.room_session_save(uuid, date, text) from public, anon;
revoke execute on function public.room_mark(uuid, date, uuid, boolean) from public, anon;
revoke execute on function public.room_notify(uuid, text, text) from public, anon;
grant execute on function public.room_assign(uuid, uuid) to authenticated;
grant execute on function public.room_roster(uuid, date) to authenticated;
grant execute on function public.room_session_save(uuid, date, text) to authenticated;
grant execute on function public.room_mark(uuid, date, uuid, boolean) to authenticated;
grant execute on function public.room_notify(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Limpeza (envio diário, com a senha ENVIO_SECRET): LGPD
-- ---------------------------------------------------------------------
create or replace function public.clean_kids(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_a integer;
  v_b integer;
begin
  perform public.envio_check_secret(p_secret);
  delete from public.room_sessions where session_date < public.today_br() - interval '12 months';
  get diagnostics v_a = row_count;
  delete from public.room_messages where created_at < now() - interval '12 months';
  get diagnostics v_b = row_count;
  return v_a + v_b;
end $$;
revoke execute on function public.clean_kids(text) from public;
grant execute on function public.clean_kids(text) to anon;
-- Sair da igreja e excluir a conta apagam o cadastro, e com ele os filhos (on delete cascade).

-- ---------------------------------------------------------------------
-- 6. Dados de teste: as igrejas de teste ligam as salas
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"salas": true}'::jsonb
where slug in ('teste-a', 'teste-b');
