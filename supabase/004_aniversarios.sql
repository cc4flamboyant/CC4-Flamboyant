-- =====================================================================
-- CC4 — aniversários (entrega 5)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Mensagem de aniversário por igreja (texto com {nome}, {primeiro_nome},
--   {igreja}, {idade} e uma imagem), enviada às 7h por push e por e-mail
-- - Resumo dos aniversariantes para a liderança
-- - Registro de envios: ninguém recebe duas vezes
-- - Aniversariantes do mês, respeitando o que cada membro autorizou
--
-- Quem envia é o GitHub Actions (.github/workflows/aniversarios.yml). As
-- funções de envio só respondem com a senha guardada no segredo
-- ENVIO_SECRET do GitHub; aqui fica apenas o hash dela.
-- =====================================================================

create or replace function public.today_br()
returns date language sql stable as $$ select (now() at time zone 'America/Sao_Paulo')::date $$;

-- Aniversário no dia? Quem nasceu em 29/02 faz em 28/02 nos anos que não são bissextos.
create or replace function public.is_birthday(p_birth date, p_day date)
returns boolean language sql immutable as $$
  select p_birth is not null and (
    (extract(month from p_birth) = extract(month from p_day) and extract(day from p_birth) = extract(day from p_day))
    or (extract(month from p_birth) = 2 and extract(day from p_birth) = 29
        and extract(month from p_day) = 2 and extract(day from p_day) = 28
        and extract(day from make_date(extract(year from p_day)::int, 3, 1) - 1) = 28)
  )
$$;

-- ---------------------------------------------------------------------
-- 1. Modelos de mensagem por igreja (o "motor" serve também para as datas
--    especiais da Fase 2: casamento e batismo)
-- ---------------------------------------------------------------------
create table if not exists public.message_templates (
  church_id  uuid not null references public.churches on delete cascade,
  kind       text not null check (kind in ('aniversario', 'resumo_lideres', 'casamento', 'batismo')),
  enabled    boolean not null default true,
  title      text not null check (char_length(title) between 1 and 120),
  body       text not null check (char_length(body) between 1 and 1000),
  image_url  text check (char_length(image_url) <= 500),
  send_push  boolean not null default true,
  send_email boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (church_id, kind)
);

create or replace function public.create_default_templates()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.message_templates (church_id, kind, title, body)
  values
    (new.id, 'aniversario', 'Feliz aniversário, {primeiro_nome}!',
     'A {igreja} celebra a sua vida hoje! Que Deus abençoe o seu novo ano com paz, saúde e alegria. Um abraço de toda a instituição de ensino.'),
    (new.id, 'resumo_lideres', 'Aniversariantes', 'Resumo dos aniversariantes para a liderança.')
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists churches_default_templates on public.churches;
create trigger churches_default_templates after insert on public.churches
  for each row execute function public.create_default_templates();

-- Igrejas que já existiam ganham os modelos padrão.
insert into public.message_templates (church_id, kind, title, body)
select c.id, k.kind, k.title, k.body
from public.churches c
cross join (values
  ('aniversario', 'Feliz aniversário, {primeiro_nome}!',
   'A {igreja} celebra a sua vida hoje! Que Deus abençoe o seu novo ano com paz, saúde e alegria. Um abraço de toda a instituição de ensino.'),
  ('resumo_lideres', 'Aniversariantes', 'Resumo dos aniversariantes para a liderança.')
) as k(kind, title, body)
on conflict do nothing;

alter table public.message_templates enable row level security;
drop policy if exists "templates lideranca le" on public.message_templates;
create policy "templates lideranca le" on public.message_templates for select to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "templates admin edita" on public.message_templates;
create policy "templates admin edita" on public.message_templates for update to authenticated
  using (church_id in (select public.my_church_ids('admin')))
  with check (church_id in (select public.my_church_ids('admin')));
revoke all on public.message_templates from anon;
revoke insert, update, delete on public.message_templates from authenticated;
grant update (enabled, title, body, image_url, send_push, send_email, updated_at) on public.message_templates to authenticated;

-- ---------------------------------------------------------------------
-- 2. Aparelhos que aceitaram notificações (por pessoa, não por igreja)
-- ---------------------------------------------------------------------
create table if not exists public.push_subscriptions (
  endpoint   text primary key check (endpoint ~ '^https://' and char_length(endpoint) <= 1000),
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  p256dh     text not null check (char_length(p256dh) <= 200),
  auth       text not null check (char_length(auth) <= 100),
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
revoke insert, update on public.push_subscriptions from authenticated;
drop policy if exists "push le os proprios" on public.push_subscriptions;
create policy "push le os proprios" on public.push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "push apaga os proprios" on public.push_subscriptions;
create policy "push apaga os proprios" on public.push_subscriptions for delete to authenticated
  using (user_id = (select auth.uid()));

-- Grava (ou passa para a conta atual) a inscrição deste aparelho.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end $$;
revoke execute on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Registro de envios: uma linha por pessoa, tipo, canal e dia
-- ---------------------------------------------------------------------
create table if not exists public.message_log (
  id          bigint generated always as identity primary key,
  church_id   uuid not null references public.churches on delete cascade,
  member_id   uuid not null references public.members on delete cascade,
  kind        text not null,
  channel     text not null check (channel in ('push', 'email')),
  target_date date not null,
  status      text not null default 'enviado' check (status in ('enviado', 'falhou')),
  created_at  timestamptz not null default now(),
  unique (member_id, kind, channel, target_date)
);
create index if not exists message_log_email_day_idx on public.message_log (created_at) where channel = 'email';

alter table public.message_log enable row level security;
revoke all on public.message_log from anon;
revoke insert, update, delete on public.message_log from authenticated;
drop policy if exists "log lideranca le" on public.message_log;
create policy "log lideranca le" on public.message_log for select to authenticated
  using (church_id in (select public.my_church_ids('lideranca')));

-- ---------------------------------------------------------------------
-- 4. Aniversariantes para as telas, com a regra de privacidade:
--    a liderança vê todos (e a idade); os membros veem só quem autorizou,
--    sem o ano. Período de até 62 dias.
-- ---------------------------------------------------------------------
create or replace function public.birthdays_between(p_church uuid, p_from date, p_to date)
returns table (member_id uuid, name text, on_date date, photo_path text, age integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_leader boolean := public.is_leader(p_church);
begin
  if not (v_leader or public.is_member(p_church)) then
    return;
  end if;
  if p_to < p_from or p_to - p_from > 62 then
    raise exception 'Período inválido (até 62 dias).';
  end if;
  return query
  select m.id, m.name, d::date, m.photo_path,
         case when v_leader then (extract(year from d) - extract(year from m.birth_date))::integer end
  from generate_series(p_from, p_to, interval '1 day') as d
  join public.members m on public.is_birthday(m.birth_date, d::date)
  where m.church_id = p_church
    and m.status = 'ativo'
    and (v_leader or m.show_birthday)
  order by d, m.name;
end $$;
revoke execute on function public.birthdays_between(uuid, date, date) from public, anon;
grant execute on function public.birthdays_between(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 5. Funções do envio (GitHub Actions), protegidas pela senha ENVIO_SECRET
-- ---------------------------------------------------------------------
create or replace function public.envio_check_secret(p_secret text)
returns void language plpgsql stable set search_path = '' as $$
begin
  if p_secret is null
     or encode(extensions.digest(p_secret, 'sha256'), 'hex')
        <> 'e55a0d51ca73d2b8add829d5523bf18efd5525597153f0d3682b305ea1babbfe' then
    raise exception 'acesso negado' using errcode = '42501';
  end if;
end $$;
revoke execute on function public.envio_check_secret(text) from public, anon, authenticated;

-- Quem faz aniversário hoje e pode receber: igreja ativa (e não de teste), funcionalidade
-- ligada, modelo ligado, cadastro ativo.
create or replace function public.birthday_candidates(p_day date)
returns table (member_id uuid, church_id uuid, user_id uuid, email text, consent boolean, name text, age integer,
               church_slug text, church_name text, title text, body text, image_url text, send_push boolean, send_email boolean)
language sql stable security definer set search_path = '' as $$
  select m.id, m.church_id, m.user_id, m.email, m.consent_at is not null, m.name,
         (extract(year from p_day) - extract(year from m.birth_date))::integer,
         c.slug, c.name, t.title, t.body, t.image_url, t.send_push, t.send_email
  from public.members m
  join public.churches c on c.id = m.church_id
  join public.message_templates t on t.church_id = c.id and t.kind = 'aniversario'
  where m.status = 'ativo' and c.active and not c.is_test
    and coalesce((c.features->>'aniversarios')::boolean, false)
    and t.enabled
    and public.is_birthday(m.birth_date, p_day)
$$;
revoke execute on function public.birthday_candidates(date) from public, anon, authenticated;

-- Push de aniversário de hoje: separa os aparelhos e já marca como enviado.
create or replace function public.claim_birthday_push(p_secret text)
returns table (log_id bigint, church_slug text, church_name text, name text, age integer,
               title text, body text, image_url text, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_day date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return query
  with cand as (
    select * from public.birthday_candidates(v_day) c
    where c.send_push and c.consent and c.user_id is not null
      and exists (select 1 from public.push_subscriptions ps where ps.user_id = c.user_id)
  ),
  novos as (
    insert into public.message_log (church_id, member_id, kind, channel, target_date)
    select church_id, member_id, 'aniversario', 'push', v_day from cand
    on conflict do nothing
    returning id, member_id
  )
  select n.id, c.church_slug, c.church_name, c.name, c.age, c.title, c.body, c.image_url, ps.endpoint, ps.p256dh, ps.auth
  from novos n
  join cand c on c.member_id = n.member_id
  join public.push_subscriptions ps on ps.user_id = c.user_id;
end $$;

-- Limite de e-mails do provedor gratuito, para todas as igrejas juntas.
create or replace function public.email_daily_limit()
returns integer language sql immutable as $$ select 100 $$;

create or replace function public.emails_sent_today()
returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.message_log
  where channel = 'email' and (created_at at time zone 'America/Sao_Paulo')::date = public.today_br()
$$;
revoke execute on function public.emails_sent_today() from public, anon, authenticated;

-- E-mail de aniversário: hoje e o que ficou para trás nos últimos 2 dias por causa do limite.
-- Separa até o que cabe no limite de hoje e já marca como enviado.
-- Quem não tem conta também recebe (a secretaria cadastrou com consentimento).
create or replace function public.claim_birthday_email(p_secret text)
returns table (log_id bigint, email text, church_slug text, church_name text, name text, age integer,
               title text, body text, image_url text, late_days integer)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_today date := public.today_br();
  v_room  integer;
begin
  perform public.envio_check_secret(p_secret);
  v_room := greatest(public.email_daily_limit() - public.emails_sent_today(), 0);
  return query
  with cand as (
    select c.*, d::date as day
    from generate_series(v_today - 2, v_today, interval '1 day') as d
    cross join lateral public.birthday_candidates(d::date) c
    where c.send_email and c.email is not null
      and not exists (select 1 from public.message_log l
                      where l.member_id = c.member_id and l.kind = 'aniversario' and l.channel = 'email' and l.target_date = d::date)
    order by d, c.name
    limit v_room
  ),
  novos as (
    insert into public.message_log (church_id, member_id, kind, channel, target_date)
    select church_id, member_id, 'aniversario', 'email', day from cand
    on conflict do nothing
    returning id, member_id, target_date
  )
  select n.id, c.email, c.church_slug, c.church_name, c.name, c.age, c.title, c.body, c.image_url, (v_today - c.day)::integer
  from novos n
  join cand c on c.member_id = n.member_id and c.day = n.target_date;
end $$;

-- Quantos e-mails de aniversário ficaram para amanhã por causa do limite.
create or replace function public.birthday_email_backlog(p_secret text)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return (
    select count(*)::integer
    from generate_series(v_today - 2, v_today, interval '1 day') as d
    cross join lateral public.birthday_candidates(d::date) c
    where c.send_email and c.email is not null
      and not exists (select 1 from public.message_log l
                      where l.member_id = c.member_id and l.kind = 'aniversario' and l.channel = 'email' and l.target_date = d::date)
  );
end $$;

-- Resumo para a liderança (push): todo dia que tiver aniversariante, e às segundas
-- com os aniversariantes da semana (próximos 7 dias).
create or replace function public.claim_leader_summaries(p_secret text)
returns table (log_id bigint, church_slug text, church_name text, today_names text[], week jsonb,
               endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_day date := public.today_br();
  v_monday boolean := extract(isodow from public.today_br()) = 1;
begin
  perform public.envio_check_secret(p_secret);
  return query
  with resumo as (
    select c.id as church_id, c.slug, c.name,
      array(select m.name from public.members m
            where m.church_id = c.id and m.status = 'ativo' and public.is_birthday(m.birth_date, v_day)
            order by m.name) as today_names,
      coalesce((select jsonb_agg(jsonb_build_object('name', m.name, 'date', d::date) order by d, m.name)
                from generate_series(v_day + 1, v_day + 7, interval '1 day') as d
                join public.members m on public.is_birthday(m.birth_date, d::date)
                where m.church_id = c.id and m.status = 'ativo'), '[]'::jsonb) as week
    from public.churches c
    join public.message_templates t on t.church_id = c.id and t.kind = 'resumo_lideres'
    where c.active and not c.is_test and t.enabled and t.send_push
      and coalesce((c.features->>'aniversarios')::boolean, false)
  ),
  alvo as (
    select r.*, m.id as member_id, m.user_id
    from resumo r
    join public.members m on m.church_id = r.church_id
    where m.role in ('admin', 'secretaria', 'lider') and m.status = 'ativo'
      and m.user_id is not null and m.consent_at is not null
      and (cardinality(r.today_names) > 0 or (v_monday and jsonb_array_length(r.week) > 0))
      and exists (select 1 from public.push_subscriptions ps where ps.user_id = m.user_id)
  ),
  novos as (
    insert into public.message_log (church_id, member_id, kind, channel, target_date)
    select church_id, member_id, 'resumo_lideres', 'push', v_day from alvo
    on conflict do nothing
    returning id, member_id
  )
  select n.id, a.slug, a.name, a.today_names, case when v_monday then a.week else '[]'::jsonb end,
         ps.endpoint, ps.p256dh, ps.auth
  from novos n
  join alvo a on a.member_id = n.member_id
  join public.push_subscriptions ps on ps.user_id = a.user_id;
end $$;

-- Aparelhos do administrador da plataforma (aviso de limite de e-mails, falhas).
create or replace function public.platform_push_targets(p_secret text)
returns table (endpoint text, p256dh text, auth text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.envio_check_secret(p_secret);
  return query
  select ps.endpoint, ps.p256dh, ps.auth
  from public.push_subscriptions ps join public.platform_admins pa on pa.user_id = ps.user_id;
end $$;

create or replace function public.mark_message_failed(p_secret text, p_log_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.envio_check_secret(p_secret);
  update public.message_log set status = 'falhou' where id = p_log_id;
end $$;

-- Aparelho que desinstalou o app ou bloqueou as notificações: some da lista.
create or replace function public.forget_push_subscription(p_secret text, p_endpoint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.envio_check_secret(p_secret);
  delete from public.push_subscriptions where endpoint = p_endpoint;
end $$;

-- Registros com mais de um ano saem (só servem para não repetir envios).
create or replace function public.clean_message_log(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  delete from public.message_log where created_at < now() - interval '1 year';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- O envio entra sem login (chave pública) e prova quem é com a senha.
revoke execute on function public.claim_birthday_push(text) from public;
revoke execute on function public.claim_birthday_email(text) from public;
revoke execute on function public.birthday_email_backlog(text) from public;
revoke execute on function public.claim_leader_summaries(text) from public;
revoke execute on function public.platform_push_targets(text) from public;
revoke execute on function public.mark_message_failed(text, bigint) from public;
revoke execute on function public.forget_push_subscription(text, text) from public;
revoke execute on function public.clean_message_log(text) from public;
grant execute on function public.claim_birthday_push(text) to anon;
grant execute on function public.claim_birthday_email(text) to anon;
grant execute on function public.birthday_email_backlog(text) to anon;
grant execute on function public.claim_leader_summaries(text) to anon;
grant execute on function public.platform_push_targets(text) to anon;
grant execute on function public.mark_message_failed(text, bigint) to anon;
grant execute on function public.forget_push_subscription(text, text) to anon;
grant execute on function public.clean_message_log(text) to anon;

-- ---------------------------------------------------------------------
-- 6. Dados de teste: na Teste A, alguém de 29/02 que autorizou mostrar o aniversário
-- ---------------------------------------------------------------------
insert into public.members (church_id, role, name, birth_date, show_birthday)
select c.id, 'membro', 'Bissexto da A', '2000-02-29', true
from public.churches c
where c.slug = 'teste-a'
  and not exists (select 1 from public.members m where m.church_id = c.id and m.name = 'Bissexto da A');
