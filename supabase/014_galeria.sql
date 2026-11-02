-- =====================================================================
-- CC4 — galeria de fotos (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Álbuns de fotos, vistos só pelos membros da igreja (pasta privada)
-- - Publicam: a liderança e os membros que o administrador marcar ("Publica na galeria")
-- - Limite de 300 fotos por igreja, conferido no banco; cada arquivo até
--   400 KB (o app reduz as fotos no aparelho, com uma miniatura para a grade)
-- - Só dá para enviar o arquivo de uma foto que o banco registrou antes
--   (gallery_add_photo): o limite não é contornado pelo app
-- - "Pedir para tirar esta foto": avisa quem publica
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Funcionalidade, tipo de notificação, limite e a equipe que publica
-- ---------------------------------------------------------------------
create or replace function public.gallery_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'galeria')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.gallery_on(uuid) from public, anon;
grant execute on function public.gallery_on(uuid) to authenticated;

create or replace function public.gallery_limit()
returns integer language sql immutable as $$ select 300 $$;

alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo', 'sala', 'galeria'));

-- Quem publica além da liderança: o administrador marca no cadastro do membro (gallery_set_publisher).
alter table public.members add column if not exists gallery_publisher boolean not null default false;

create or replace function public.my_gallery_churches()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.church_id
  from public.members m
  where m.gallery_publisher and m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;

-- O administrador marca (ou desmarca) quem publica na galeria.
create or replace function public.gallery_set_publisher(p_member uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select m.church_id into v_church from public.members m where m.id = p_member;
  if v_church is null or not coalesce(public.has_role(v_church, 'admin'), false) then
    raise exception 'Só o administrador da igreja escolhe quem publica na galeria.' using errcode = '42501';
  end if;
  update public.members set gallery_publisher = coalesce(p_on, false) where id = p_member;
end $$;
revoke execute on function public.gallery_set_publisher(uuid, boolean) from public, anon;
grant execute on function public.gallery_set_publisher(uuid, boolean) to authenticated;

-- Publica na galeria: a liderança ou a equipe marcada, com a funcionalidade ligada.
create or replace function public.can_gallery(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.gallery_on(p_church)
     and (public.is_leader(p_church) or p_church in (select public.my_gallery_churches()))
$$;

-- Campo calculado do cadastro (members.gallery_team): o app mostra os botões de publicar.
create or replace function public.gallery_team(m public.members)
returns boolean language sql stable security definer set search_path = '' as $$
  select m.user_id = auth.uid() and m.church_id in (select public.my_gallery_churches())
$$;

revoke execute on function public.my_gallery_churches() from public, anon;
revoke execute on function public.can_gallery(uuid) from public, anon;
revoke execute on function public.gallery_team(public.members) from public, anon;
grant execute on function public.my_gallery_churches() to authenticated;
grant execute on function public.can_gallery(uuid) to authenticated;
grant execute on function public.gallery_team(public.members) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Tabelas
-- ---------------------------------------------------------------------
create table if not exists public.gallery_albums (
  id             uuid primary key default gen_random_uuid(),
  church_id      uuid not null references public.churches on delete cascade,
  title          text not null check (char_length(title) between 2 and 80),
  album_date     date not null default public.today_br(),
  description    text check (char_length(description) <= 500),
  cover_photo_id uuid,
  created_by     uuid default auth.uid() references auth.users on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists gallery_albums_church_idx on public.gallery_albums (church_id, album_date desc);

create table if not exists public.gallery_photos (
  id         uuid primary key default gen_random_uuid(),
  church_id  uuid not null references public.churches on delete cascade,
  album_id   uuid not null references public.gallery_albums on delete cascade,
  path       text not null unique,
  mini_path  text not null unique,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists gallery_photos_album_idx on public.gallery_photos (album_id, created_at);
create index if not exists gallery_photos_church_idx on public.gallery_photos (church_id);

alter table public.gallery_albums drop constraint if exists gallery_albums_cover_fk;
alter table public.gallery_albums add constraint gallery_albums_cover_fk
  foreign key (cover_photo_id) references public.gallery_photos on delete set null;

create table if not exists public.gallery_removal_requests (
  photo_id   uuid not null references public.gallery_photos on delete cascade,
  user_id    uuid not null references auth.users on delete cascade,
  reason     text check (char_length(reason) <= 300),
  created_at timestamptz not null default now(),
  primary key (photo_id, user_id)
);

-- ---------------------------------------------------------------------
-- 3. Regras de acesso
-- ---------------------------------------------------------------------
alter table public.gallery_albums enable row level security;
drop policy if exists "albuns le" on public.gallery_albums;
create policy "albuns le" on public.gallery_albums for select to authenticated
  using (church_id in (select public.my_church_ids()) and public.gallery_on(church_id));
drop policy if exists "albuns cria" on public.gallery_albums;
create policy "albuns cria" on public.gallery_albums for insert to authenticated
  with check (public.can_gallery(church_id));
drop policy if exists "albuns edita" on public.gallery_albums;
create policy "albuns edita" on public.gallery_albums for update to authenticated
  using (public.can_gallery(church_id)) with check (public.can_gallery(church_id));
drop policy if exists "albuns apaga" on public.gallery_albums;
create policy "albuns apaga" on public.gallery_albums for delete to authenticated
  using (public.can_gallery(church_id));
revoke all on public.gallery_albums from anon;
revoke update on public.gallery_albums from authenticated;
grant update (title, album_date, description, cover_photo_id) on public.gallery_albums to authenticated;

-- A capa precisa ser uma foto do próprio álbum.
create or replace function public.gallery_albums_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.cover_photo_id is not null
     and not exists (select 1 from public.gallery_photos p where p.id = new.cover_photo_id and p.album_id = new.id) then
    raise exception 'A capa precisa ser uma foto deste álbum.';
  end if;
  return new;
end $$;
drop trigger if exists gallery_albums_guard on public.gallery_albums;
create trigger gallery_albums_guard before update of cover_photo_id on public.gallery_albums
  for each row execute function public.gallery_albums_guard();
revoke execute on function public.gallery_albums_guard() from public, anon, authenticated;

-- Fotos: os membros veem; quem publica apaga. Registrar, só por gallery_add_photo.
alter table public.gallery_photos enable row level security;
drop policy if exists "fotos le" on public.gallery_photos;
create policy "fotos le" on public.gallery_photos for select to authenticated
  using (church_id in (select public.my_church_ids()) and public.gallery_on(church_id));
drop policy if exists "fotos apaga" on public.gallery_photos;
create policy "fotos apaga" on public.gallery_photos for delete to authenticated
  using (public.can_gallery(church_id));
revoke all on public.gallery_photos from anon;
revoke insert, update on public.gallery_photos from authenticated;

-- Pedidos de retirada: cada um lê os próprios; gravar, só pela função.
alter table public.gallery_removal_requests enable row level security;
drop policy if exists "pedidos de retirada le" on public.gallery_removal_requests;
create policy "pedidos de retirada le" on public.gallery_removal_requests for select to authenticated
  using (user_id = auth.uid());
revoke all on public.gallery_removal_requests from anon;
revoke insert, update, delete on public.gallery_removal_requests from authenticated;

-- ---------------------------------------------------------------------
-- 4. Arquivos: pasta privada "galeria", em <igreja>/<álbum>/<foto>.webp
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('galeria', 'galeria', false, 409600, array['image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = 409600, allowed_mime_types = array['image/jpeg', 'image/webp'];

drop policy if exists "galeria membros veem" on storage.objects;
create policy "galeria membros veem" on storage.objects for select to authenticated
  using (bucket_id = 'galeria' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids() as id)
         and exists (select 1 from public.gallery_photos p where (p.path = name or p.mini_path = name) and public.gallery_on(p.church_id)));
-- Só o arquivo de uma foto já registrada (e por quem publica).
drop policy if exists "galeria equipe envia" on storage.objects;
create policy "galeria equipe envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'galeria'
              and exists (select 1 from public.gallery_photos p
                          where (p.path = name or p.mini_path = name) and public.can_gallery(p.church_id)));
drop policy if exists "galeria equipe apaga" on storage.objects;
create policy "galeria equipe apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'galeria'
         and (storage.foldername(name))[1] in (select c.id::text from public.churches c where public.can_gallery(c.id)));

-- ---------------------------------------------------------------------
-- 5. Funções das telas
-- ---------------------------------------------------------------------
-- Álbuns com a quantidade de fotos e a miniatura da capa (a escolhida ou a primeira).
create or replace function public.gallery_album_list(p_church uuid)
returns table (id uuid, title text, album_date date, description text, photos integer, cover_mini text, cover_photo_id uuid)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.is_member(p_church) or not public.gallery_on(p_church) then
    return;
  end if;
  return query
  select a.id, a.title, a.album_date, a.description,
         (select count(*)::integer from public.gallery_photos p where p.album_id = a.id),
         coalesce((select p.mini_path from public.gallery_photos p where p.id = a.cover_photo_id),
                  (select p.mini_path from public.gallery_photos p where p.album_id = a.id order by p.created_at limit 1)),
         a.cover_photo_id
  from public.gallery_albums a
  where a.church_id = p_church
  order by a.album_date desc, a.created_at desc;
end $$;

-- Registra uma foto nova (antes de enviar o arquivo) e devolve os caminhos. Confere o limite.
create or replace function public.gallery_add_photo(p_album uuid, p_ext text)
returns table (photo_id uuid, path text, mini_path text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  a public.gallery_albums;
  v_id uuid := gen_random_uuid();
  v_ext text := case when p_ext = 'jpg' then 'jpg' else 'webp' end;
  v_dir text;
begin
  select * into a from public.gallery_albums where id = p_album;
  if a.id is null or not public.can_gallery(a.church_id) then
    raise exception 'Só quem publica na galeria envia fotos.' using errcode = '42501';
  end if;
  -- Uma foto por vez em cada igreja, para o limite valer mesmo com envios ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtext('galeria:' || a.church_id::text));
  if (select count(*) from public.gallery_photos p where p.church_id = a.church_id) >= public.gallery_limit() then
    raise exception 'A galeria chegou ao limite de % fotos. Apague álbuns antigos para enviar novas.', public.gallery_limit();
  end if;
  v_dir := a.church_id || '/' || a.id || '/';
  insert into public.gallery_photos (id, church_id, album_id, path, mini_path)
  values (v_id, a.church_id, a.id, v_dir || v_id || '.' || v_ext, v_dir || v_id || '-mini.' || v_ext);
  return query select v_id, v_dir || v_id || '.' || v_ext, v_dir || v_id || '-mini.' || v_ext;
end $$;

-- "Pedir para tirar esta foto": avisa quem publica (uma vez por pessoa e foto).
create or replace function public.gallery_request_removal(p_photo uuid, p_reason text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  p public.gallery_photos;
  v_title text;
begin
  select * into p from public.gallery_photos where id = p_photo;
  if p.id is null or not public.is_member(p.church_id) or not public.gallery_on(p.church_id) then
    raise exception 'Foto não encontrada.' using errcode = '42501';
  end if;
  insert into public.gallery_removal_requests (photo_id, user_id, reason)
  values (p_photo, auth.uid(), nullif(trim(left(p_reason, 300)), ''))
  on conflict do nothing;
  if not found then
    return false;
  end if;
  select a.title into v_title from public.gallery_albums a where a.id = p.album_id;
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key, push_pending)
  select d.user_id, p.church_id, 'galeria', 'Pedido para tirar uma foto',
         'Álbum "' || v_title || '"' || coalesce(' · ' || nullif(trim(left(p_reason, 120)), ''), ''),
         '#/galeria/' || p.album_id || '/foto/' || p.id, 'galeria-retirada:' || p.id || ':' || auth.uid(), true
  from (
    select m.user_id from public.members m
    where m.church_id = p.church_id and m.role in ('admin', 'secretaria', 'lider')
      and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
    union
    select m.user_id from public.members m
    where m.church_id = p.church_id and m.gallery_publisher
      and m.user_id is not null and m.status = 'ativo' and m.consent_at is not null
  ) d
  where d.user_id <> auth.uid()
  on conflict do nothing;
  return true;
end $$;

revoke execute on function public.gallery_album_list(uuid) from public, anon;
revoke execute on function public.gallery_add_photo(uuid, text) from public, anon;
revoke execute on function public.gallery_request_removal(uuid, text) from public, anon;
grant execute on function public.gallery_album_list(uuid) to authenticated;
grant execute on function public.gallery_add_photo(uuid, text) to authenticated;
grant execute on function public.gallery_request_removal(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 6. Dados de teste: as igrejas de teste ligam a galeria
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"galeria": true}'::jsonb
where slug in ('teste-a', 'teste-b');
