-- =====================================================================
-- CC4 — agenda, mural de avisos e central de notificações (entrega 6)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Eventos e cultos (podem repetir toda semana), com lembrete por push
-- - Avisos da igreja, com notificação opcional para os membros
-- - Central de notificações dentro do app (avisos, lembretes, aniversário)
--
-- Os lembretes e os avisos saem pelo GitHub Actions a cada 10 minutos
-- (.github/workflows/lembretes.yml), com a mesma senha ENVIO_SECRET do 004.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Agenda
-- ---------------------------------------------------------------------
create table if not exists public.events (
  id             uuid primary key default gen_random_uuid(),
  church_id      uuid not null references public.churches on delete cascade,
  title          text not null check (char_length(title) between 3 and 120),
  description    text check (char_length(description) <= 2000),
  location       text check (char_length(location) <= 200),
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  repeat_weekly  boolean not null default false,
  repeat_until   date,
  remind_minutes integer not null default 120 check (remind_minutes in (0, 60, 120, 180, 1440)),
  created_by     uuid default auth.uid() references auth.users on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (ends_at is null or (ends_at > starts_at and ends_at - starts_at <= interval '7 days')),
  check (repeat_until is null or repeat_weekly)
);
create index if not exists events_church_start_idx on public.events (church_id, starts_at);

alter table public.events enable row level security;
drop policy if exists "events membros leem" on public.events;
create policy "events membros leem" on public.events for select to authenticated
  using (church_id in (select public.my_church_ids('membro')));
drop policy if exists "events lideranca cria" on public.events;
create policy "events lideranca cria" on public.events for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "events lideranca edita" on public.events;
create policy "events lideranca edita" on public.events for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "events lideranca apaga" on public.events;
create policy "events lideranca apaga" on public.events for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
revoke all on public.events from anon;
revoke update on public.events from authenticated;
grant update (title, description, location, starts_at, ends_at, repeat_weekly, repeat_until, remind_minutes, updated_at)
  on public.events to authenticated;

-- Cada vez que um evento acontece no período (eventos semanais viram várias ocorrências).
-- Uso interno; as telas usam events_between, que confere a igreja.
create or replace function public.event_occurrences(p_from timestamptz, p_to timestamptz)
returns table (event_id uuid, church_id uuid, title text, description text, location text,
               starts_at timestamptz, ends_at timestamptz, repeat_weekly boolean, remind_minutes integer)
language sql stable security definer set search_path = '' as $$
  select e.id, e.church_id, e.title, e.description, e.location,
         e.starts_at + k * interval '7 days',
         e.ends_at + k * interval '7 days',
         e.repeat_weekly, e.remind_minutes
  from public.events e
  cross join lateral generate_series(
    case when e.repeat_weekly
         then greatest(0, floor(extract(epoch from (p_from - e.starts_at - coalesce(e.ends_at - e.starts_at, interval '2 hours'))) / 604800)::integer)
         else 0 end,
    case when e.repeat_weekly
         then floor(extract(epoch from (p_to - e.starts_at)) / 604800)::integer
         else 0 end
  ) as k
  where e.starts_at + k * interval '7 days' < p_to
    and e.starts_at + k * interval '7 days' + coalesce(e.ends_at - e.starts_at, interval '2 hours') > p_from
    and (e.repeat_until is null
         or ((e.starts_at + k * interval '7 days') at time zone 'America/Sao_Paulo')::date <= e.repeat_until)
$$;
revoke execute on function public.event_occurrences(timestamptz, timestamptz) from public, anon, authenticated;

create or replace function public.events_between(p_church uuid, p_from timestamptz, p_to timestamptz)
returns table (event_id uuid, title text, description text, location text,
               starts_at timestamptz, ends_at timestamptz, repeat_weekly boolean, remind_minutes integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if not public.is_member(p_church) then
    return;
  end if;
  if p_to < p_from or p_to - p_from > interval '120 days' then
    raise exception 'Período inválido (até 120 dias).';
  end if;
  return query
  select o.event_id, o.title, o.description, o.location, o.starts_at, o.ends_at, o.repeat_weekly, o.remind_minutes
  from public.event_occurrences(p_from, p_to) o
  where o.church_id = p_church
  order by o.starts_at, o.title;
end $$;
revoke execute on function public.events_between(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.events_between(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Mural de avisos
-- ---------------------------------------------------------------------
create table if not exists public.announcements (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches on delete cascade,
  title         text not null check (char_length(title) between 3 and 120),
  body          text not null check (char_length(body) between 1 and 4000),
  pinned        boolean not null default false,
  visible_until date,
  push          boolean not null default false,   -- notificar os membros (só ao publicar)
  pushed_at     timestamptz,
  created_by    uuid default auth.uid() references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists announcements_church_idx on public.announcements (church_id, created_at desc);
create index if not exists announcements_push_idx on public.announcements (created_at) where push and pushed_at is null;

create or replace function public.announcements_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.pushed_at := null;
    new.created_by := auth.uid();
    new.created_at := now();
  end if;
  return new;
end $$;
drop trigger if exists announcements_guard on public.announcements;
create trigger announcements_guard before insert on public.announcements
  for each row execute function public.announcements_guard();

alter table public.announcements enable row level security;
-- Membros veem os avisos dentro do prazo; a liderança vê todos (inclusive os vencidos).
drop policy if exists "avisos membros leem" on public.announcements;
create policy "avisos membros leem" on public.announcements for select to authenticated
  using (church_id in (select public.my_church_ids('lideranca'))
         or (church_id in (select public.my_church_ids('membro'))
             and (visible_until is null or visible_until >= public.today_br())));
drop policy if exists "avisos lideranca cria" on public.announcements;
create policy "avisos lideranca cria" on public.announcements for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "avisos lideranca edita" on public.announcements;
create policy "avisos lideranca edita" on public.announcements for update to authenticated
  using (church_id in (select public.my_church_ids('lideranca')))
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "avisos lideranca apaga" on public.announcements;
create policy "avisos lideranca apaga" on public.announcements for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
revoke all on public.announcements from anon;
revoke update on public.announcements from authenticated;
grant update (title, body, pinned, visible_until, updated_at) on public.announcements to authenticated;

-- ---------------------------------------------------------------------
-- 3. Central de notificações (dentro do app)
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users on delete cascade,
  church_id  uuid not null references public.churches on delete cascade,
  kind       text not null check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema')),
  title      text not null check (char_length(title) <= 200),
  body       text check (char_length(body) <= 600),
  url        text check (char_length(url) <= 300),   -- caminho dentro do app da igreja, ex.: #/avisos
  dedupe_key text not null,
  read_at    timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, dedupe_key)
);
create index if not exists notifications_user_idx on public.notifications (user_id, church_id, created_at desc);

alter table public.notifications enable row level security;
drop policy if exists "notificacoes le as proprias" on public.notifications;
create policy "notificacoes le as proprias" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "notificacoes marca as proprias" on public.notifications;
create policy "notificacoes marca as proprias" on public.notifications for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "notificacoes apaga as proprias" on public.notifications;
create policy "notificacoes apaga as proprias" on public.notifications for delete to authenticated
  using (user_id = (select auth.uid()));
revoke all on public.notifications from anon;
revoke insert, update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- Quem recebe as notificações de uma igreja: membros ativos com conta e convite aceito.
create or replace function public.church_audience(p_church uuid)
returns table (member_id uuid, user_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.id, m.user_id from public.members m
  where m.church_id = p_church and m.status = 'ativo' and m.user_id is not null and m.consent_at is not null
$$;
revoke execute on function public.church_audience(uuid) from public, anon, authenticated;

-- Mesmos campos da mensagem de aniversário do app (js/util.js renderMessage).
create or replace function public.render_template(p_text text, p_name text, p_church text, p_age integer)
returns text language sql immutable as $$
  select trim(regexp_replace(
    replace(replace(replace(replace(p_text,
      '{nome}', p_name),
      '{primeiro_nome}', split_part(trim(p_name), ' ', 1)),
      '{igreja}', p_church),
      '{idade}', coalesce(p_age::text, '')),
    '[ \t]{2,}', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------
-- 4. Funções do envio (GitHub Actions), protegidas pela senha ENVIO_SECRET
-- ---------------------------------------------------------------------
-- Lembretes: ocorrências que começam dentro do prazo de lembrete escolhido.
-- Grava a notificação na central de cada membro e devolve os aparelhos para o push.
create table if not exists public.event_reminders_sent (
  event_id   uuid not null references public.events on delete cascade,
  occurrence timestamptz not null,
  sent_at    timestamptz not null default now(),
  primary key (event_id, occurrence)
);
alter table public.event_reminders_sent enable row level security;
revoke all on public.event_reminders_sent from anon, authenticated;

create or replace function public.claim_event_reminders(p_secret text)
returns table (event_id uuid, occurrence timestamptz, church_slug text, church_name text, title text, location text,
               endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.envio_check_secret(p_secret);
  return query
  with due as (
    select o.*, c.slug, c.name as church_name
    from public.event_occurrences(now(), now() + interval '1 day 1 hour') o
    join public.churches c on c.id = o.church_id
    where o.remind_minutes > 0
      and now() >= o.starts_at - make_interval(mins => o.remind_minutes)
      and now() < o.starts_at
      and c.active and not c.is_test
      and coalesce((c.features->>'agenda')::boolean, false)
  ),
  novos as (
    insert into public.event_reminders_sent (event_id, occurrence)
    select event_id, starts_at from due
    on conflict do nothing
    returning event_reminders_sent.event_id, event_reminders_sent.occurrence
  ),
  alvo as (
    select d.*, a.user_id
    from novos n
    join due d on d.event_id = n.event_id and d.starts_at = n.occurrence
    cross join lateral public.church_audience(d.church_id) a
  ),
  central as (
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key)
    select user_id, church_id, 'evento', title,
           to_char(starts_at at time zone 'America/Sao_Paulo', 'DD/MM "às" HH24"h"MI') || coalesce(' · ' || location, ''),
           '#/agenda/' || event_id, 'evento:' || event_id || ':' || extract(epoch from starts_at)::bigint
    from alvo
    on conflict do nothing
  )
  select a.event_id, a.starts_at, a.slug, a.church_name, a.title, a.location, ps.endpoint, ps.p256dh, ps.auth
  from alvo a
  join public.push_subscriptions ps on ps.user_id = a.user_id;
end $$;

-- Avisos publicados com "notificar os membros" que ainda não saíram (até 1 dia depois).
create or replace function public.claim_announcement_push(p_secret text)
returns table (announcement_id uuid, church_slug text, church_name text, title text, body text,
               endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.envio_check_secret(p_secret);
  return query
  with novos as (
    update public.announcements a
       set pushed_at = now()
      from public.churches c
     where c.id = a.church_id and a.push and a.pushed_at is null
       and a.created_at > now() - interval '1 day'
       and c.active and not c.is_test
       and coalesce((c.features->>'avisos')::boolean, false)
    returning a.id, a.church_id, a.title, a.body, c.slug, c.name
  ),
  alvo as (
    select n.*, au.user_id from novos n cross join lateral public.church_audience(n.church_id) au
  ),
  central as (
    insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key)
    select user_id, church_id, 'aviso', title, left(body, 200), '#/avisos', 'aviso:' || id
    from alvo
    on conflict do nothing
  )
  select a.id, a.slug, a.name, a.title, left(a.body, 160), ps.endpoint, ps.p256dh, ps.auth
  from alvo a
  join public.push_subscriptions ps on ps.user_id = a.user_id;
end $$;

-- Mensagem de aniversário de hoje também na central (para quem tem conta, mesmo sem push).
create or replace function public.deliver_birthday_notifications(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_day date := public.today_br();
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key)
  select c.user_id, c.church_id, 'aniversario',
         left(public.render_template(c.title, c.name, c.church_name, c.age), 200),
         left(public.render_template(c.body, c.name, c.church_name, c.age), 600),
         '#/', 'aniversario:' || c.church_id || ':' || v_day
  from public.birthday_candidates(v_day) c
  where c.user_id is not null and c.consent
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Limpeza: notificações com mais de 90 dias e lembretes antigos.
create or replace function public.clean_notifications(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  delete from public.notifications where created_at < now() - interval '90 days';
  get diagnostics v_count = row_count;
  delete from public.event_reminders_sent where occurrence < now() - interval '30 days';
  return v_count;
end $$;

revoke execute on function public.claim_event_reminders(text) from public;
revoke execute on function public.claim_announcement_push(text) from public;
revoke execute on function public.deliver_birthday_notifications(text) from public;
revoke execute on function public.clean_notifications(text) from public;
grant execute on function public.claim_event_reminders(text) to anon;
grant execute on function public.claim_announcement_push(text) to anon;
grant execute on function public.deliver_birthday_notifications(text) to anon;
grant execute on function public.clean_notifications(text) to anon;
