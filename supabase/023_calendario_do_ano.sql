-- =====================================================================
-- CC4 — calendário do ano na Agenda
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 022). Pode rodar de novo.
--
-- - A liderança envia o calendário do ano (imagem ou PDF): aparece no topo da Agenda
-- - Pode haver mais de um por ano (ex.: o da escola e o de provas), até 10 por instituição
-- - Só quem é da instituição de ensino vê (pasta privada "calendarios")
-- - Cada arquivo até 15 MB; o app reduz as imagens para 2.400 pixels (os dias continuam legíveis)
-- - O app mostra só os do ano atual em diante; a liderança vê os antigos para apagar

create or replace function public.agenda_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'agenda')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.agenda_on(uuid) from public, anon;
grant execute on function public.agenda_on(uuid) to authenticated;

create table if not exists public.agenda_calendars (
  id         uuid primary key default gen_random_uuid(),
  church_id  uuid not null references public.churches on delete cascade,
  year       integer not null check (year between 2000 and 2100),
  title      text not null check (char_length(title) between 2 and 80),
  path       text not null unique,
  file_type  text not null check (file_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  file_size  bigint not null check (file_size >= 0),
  ready      boolean not null default false,
  created_by uuid default auth.uid() references auth.users on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists agenda_calendars_church_idx on public.agenda_calendars (church_id, year);

-- Membros leem (depois que o arquivo chegou); a liderança muda o título e o ano e apaga.
-- Registrar, só pela função (confere o limite).
alter table public.agenda_calendars enable row level security;
drop policy if exists "calendarios le" on public.agenda_calendars;
create policy "calendarios le" on public.agenda_calendars for select to authenticated
  using (public.is_member(church_id) and public.agenda_on(church_id) and (ready or created_by = auth.uid()));
drop policy if exists "calendarios edita" on public.agenda_calendars;
create policy "calendarios edita" on public.agenda_calendars for update to authenticated
  using (public.is_leader(church_id)) with check (public.is_leader(church_id));
drop policy if exists "calendarios apaga" on public.agenda_calendars;
create policy "calendarios apaga" on public.agenda_calendars for delete to authenticated
  using (public.is_leader(church_id));
revoke all on public.agenda_calendars from anon;
revoke insert, update on public.agenda_calendars from authenticated;
grant update (title, year) on public.agenda_calendars to authenticated;

-- Arquivos: <instituição>/<calendário>.<ext>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('calendarios', 'calendarios', false, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "calendarios membros veem" on storage.objects;
create policy "calendarios membros veem" on storage.objects for select to authenticated
  using (bucket_id = 'calendarios'
         and exists (select 1 from public.agenda_calendars k
                     where k.path = objects.name and public.is_member(k.church_id) and public.agenda_on(k.church_id)));
drop policy if exists "calendarios lideranca envia" on storage.objects;
create policy "calendarios lideranca envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'calendarios'
              and exists (select 1 from public.agenda_calendars k
                          where k.path = objects.name and not k.ready and k.created_by = auth.uid()
                            and public.is_leader(k.church_id)));
drop policy if exists "calendarios lideranca apaga" on storage.objects;
create policy "calendarios lideranca apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'calendarios'
         and (storage.foldername(objects.name))[1] in (select x::text from public.my_church_ids('lideranca') as x));

-- Registra o calendário (antes de enviar o arquivo) e devolve o caminho.
create or replace function public.agenda_calendar_add(p_church uuid, p_year integer, p_title text, p_type text, p_size bigint, p_ext text)
returns table (calendar_id uuid, path text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  if not coalesce(public.is_leader(p_church), false) or not coalesce(public.agenda_on(p_church), false) then
    raise exception 'Só a liderança envia o calendário do ano.' using errcode = '42501';
  end if;
  if p_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf') then
    raise exception 'Envie uma imagem (JPG, PNG) ou um PDF.' using errcode = '22023';
  end if;
  if coalesce(p_size, 0) <= 0 or p_size > 15728640 then
    raise exception 'O arquivo passa de 15 MB.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('calendarios:' || p_church::text));
  if (select count(*) from public.agenda_calendars k where k.church_id = p_church) >= 10 then
    raise exception 'Já há 10 calendários. Apague os de anos anteriores para enviar outro.';
  end if;
  v_path := p_church || '/' || v_id || '.' || case when p_ext in ('jpg', 'png', 'webp', 'pdf') then p_ext else 'bin' end;
  insert into public.agenda_calendars (id, church_id, year, title, path, file_type, file_size)
  values (v_id, p_church, p_year, trim(left(coalesce(nullif(trim(p_title), ''), 'Calendário'), 80)), v_path, p_type, p_size);
  return query select v_id, v_path;
end $$;

-- O arquivo chegou: o calendário aparece para todos.
create or replace function public.agenda_calendar_ready(p_calendar uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  k public.agenda_calendars;
  v_size bigint;
begin
  select * into k from public.agenda_calendars where id = p_calendar;
  if k.id is null or k.created_by is distinct from auth.uid() or not coalesce(public.is_leader(k.church_id), false) then
    raise exception 'Calendário não encontrado.' using errcode = '42501';
  end if;
  select (o.metadata->>'size')::bigint into v_size from storage.objects o where o.bucket_id = 'calendarios' and o.name = k.path;
  if v_size is null then
    raise exception 'O arquivo ainda não chegou. Tente de novo.';
  end if;
  update public.agenda_calendars set ready = true, file_size = v_size where id = p_calendar;
end $$;

revoke execute on function public.agenda_calendar_add(uuid, integer, text, text, bigint, text) from public, anon;
revoke execute on function public.agenda_calendar_ready(uuid) from public, anon;
grant execute on function public.agenda_calendar_add(uuid, integer, text, text, bigint, text) to authenticated;
grant execute on function public.agenda_calendar_ready(uuid) to authenticated;
