-- =====================================================================
-- CC4 — datas especiais: aniversário de casamento e de batismo
-- (Fase 2, entrega 2). Rode depois dos arquivos anteriores, no SQL Editor.
--
-- - Datas de casamento e de batismo no cadastro do membro, cada uma com a
--   autorização para os outros membros verem (dia e mês, nunca o ano)
-- - Mesmo motor dos aniversários: modelo de mensagem por igreja, envio às 7h
--   por push, central do app e e-mail, registro de envios e limite diário
-- - Campo novo {anos} nas mensagens ("1 ano", "10 anos")
-- - Resumo da liderança e lista do mês com as datas especiais
-- Casamento e batismo só saem com a funcionalidade "datas_especiais" ligada.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cadastro do membro
-- ---------------------------------------------------------------------
alter table public.members
  add column if not exists wedding_date date check (wedding_date >= '1900-01-01'),
  add column if not exists baptism_date date check (baptism_date >= '1900-01-01'),
  add column if not exists show_wedding boolean not null default false,  -- membros veem dia e mês
  add column if not exists show_baptism boolean not null default false;

grant update (wedding_date, baptism_date, show_wedding, show_baptism) on public.members to authenticated;

-- ---------------------------------------------------------------------
-- 2. Campos das mensagens: {anos} vira "1 ano" ou "10 anos" (igual a js/util.js)
-- ---------------------------------------------------------------------
create or replace function public.years_text(p_years integer)
returns text language sql immutable as $$
  select case when p_years is null then '' when p_years = 1 then '1 ano' else p_years || ' anos' end
$$;

create or replace function public.render_template(p_text text, p_name text, p_church text, p_age integer)
returns text language sql immutable as $$
  select trim(regexp_replace(
    replace(replace(replace(replace(replace(p_text,
      '{nome}', p_name),
      '{primeiro_nome}', split_part(trim(p_name), ' ', 1)),
      '{igreja}', p_church),
      '{idade}', coalesce(p_age::text, '')),
      '{anos}', public.years_text(p_age)),
    '[ \t]{2,}', ' ', 'g'))
$$;

-- ---------------------------------------------------------------------
-- 3. Modelos de casamento e batismo (as igrejas novas e as que já existem)
-- ---------------------------------------------------------------------
create or replace function public.create_default_templates()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.message_templates (church_id, kind, title, body)
  values
    (new.id, 'aniversario', 'Feliz aniversário, {primeiro_nome}!',
     'A {igreja} celebra a sua vida hoje! Que Deus abençoe o seu novo ano com paz, saúde e alegria. Um abraço de toda a igreja.'),
    (new.id, 'resumo_lideres', 'Aniversariantes', 'Resumo dos aniversariantes para a liderança.'),
    (new.id, 'casamento', 'Feliz aniversário de casamento, {primeiro_nome}!',
     'Hoje você completa {anos} de casamento! A {igreja} se alegra com vocês e pede a Deus que continue abençoando o seu lar. 💍'),
    (new.id, 'batismo', 'Feliz aniversário de batismo, {primeiro_nome}!',
     'Hoje faz {anos} do seu batismo! A {igreja} celebra com você essa decisão e agradece a Deus pela sua caminhada. 🕊️')
  on conflict do nothing;
  return new;
end $$;

insert into public.message_templates (church_id, kind, title, body)
select c.id, k.kind, k.title, k.body
from public.churches c
cross join (values
  ('casamento', 'Feliz aniversário de casamento, {primeiro_nome}!',
   'Hoje você completa {anos} de casamento! A {igreja} se alegra com vocês e pede a Deus que continue abençoando o seu lar. 💍'),
  ('batismo', 'Feliz aniversário de batismo, {primeiro_nome}!',
   'Hoje faz {anos} do seu batismo! A {igreja} celebra com você essa decisão e agradece a Deus pela sua caminhada. 🕊️')
) as k(kind, title, body)
on conflict do nothing;

-- Central de notificações aceita os tipos novos.
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('aniversario', 'resumo_lideres', 'evento', 'aviso', 'sistema', 'casamento', 'batismo'));

-- ---------------------------------------------------------------------
-- 4. Quem comemora hoje: aniversário, casamento e batismo, num lugar só.
--    "years": idade (aniversário) ou anos de casamento/batismo (a partir de 1).
-- ---------------------------------------------------------------------
create or replace function public.celebration_candidates(p_day date)
returns table (kind text, member_id uuid, church_id uuid, user_id uuid, email text, consent boolean, name text, years integer,
               church_slug text, church_name text, title text, body text, image_url text, send_push boolean, send_email boolean)
language sql stable security definer set search_path = '' as $$
  select t.kind, m.id, m.church_id, m.user_id, m.email, m.consent_at is not null, m.name,
         (extract(year from p_day) - extract(year from d.on_date))::integer,
         c.slug, c.name, t.title, t.body, t.image_url, t.send_push, t.send_email
  from public.members m
  join public.churches c on c.id = m.church_id
  cross join lateral (values ('aniversario', m.birth_date), ('casamento', m.wedding_date), ('batismo', m.baptism_date)) as d(kind, on_date)
  join public.message_templates t on t.church_id = c.id and t.kind = d.kind
  where m.status = 'ativo' and c.active and not c.is_test
    and t.enabled
    and public.is_birthday(d.on_date, p_day)
    and case d.kind
          when 'aniversario' then coalesce((c.features->>'aniversarios')::boolean, false)
          else coalesce((c.features->>'datas_especiais')::boolean, false)
               and extract(year from p_day) > extract(year from d.on_date)
        end
$$;
revoke execute on function public.celebration_candidates(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 5. Envio (GitHub Actions): as mesmas funções de antes, agora com o tipo
--    da data. Mudou o formato da resposta, então são recriadas.
-- ---------------------------------------------------------------------
drop function if exists public.claim_birthday_push(text);
create function public.claim_birthday_push(p_secret text)
returns table (log_id bigint, kind text, church_slug text, church_name text, name text, age integer,
               title text, body text, image_url text, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_day date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return query
  with cand as (
    select * from public.celebration_candidates(v_day) c
    where c.send_push and c.consent and c.user_id is not null
      and exists (select 1 from public.push_subscriptions ps where ps.user_id = c.user_id)
  ),
  novos as (
    insert into public.message_log (church_id, member_id, kind, channel, target_date)
    select church_id, member_id, kind, 'push', v_day from cand
    on conflict do nothing
    returning id, member_id, kind
  )
  select n.id, n.kind, c.church_slug, c.church_name, c.name, c.years, c.title, c.body, c.image_url, ps.endpoint, ps.p256dh, ps.auth
  from novos n
  join cand c on c.member_id = n.member_id and c.kind = n.kind
  join public.push_subscriptions ps on ps.user_id = c.user_id;
end $$;

-- E-mail: hoje e o que ficou para trás nos últimos 2 dias por causa do limite.
-- Aniversários primeiro, depois casamento e batismo.
drop function if exists public.claim_birthday_email(text);
create function public.claim_birthday_email(p_secret text)
returns table (log_id bigint, kind text, email text, church_slug text, church_name text, name text, age integer,
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
    cross join lateral public.celebration_candidates(d::date) c
    where c.send_email and c.email is not null
      and not exists (select 1 from public.message_log l
                      where l.member_id = c.member_id and l.kind = c.kind and l.channel = 'email' and l.target_date = d::date)
    order by d, c.kind <> 'aniversario', c.name
    limit v_room
  ),
  novos as (
    insert into public.message_log (church_id, member_id, kind, channel, target_date)
    select church_id, member_id, kind, 'email', day from cand
    on conflict do nothing
    returning id, member_id, kind, target_date
  )
  select n.id, n.kind, c.email, c.church_slug, c.church_name, c.name, c.years, c.title, c.body, c.image_url, (v_today - c.day)::integer
  from novos n
  join cand c on c.member_id = n.member_id and c.kind = n.kind and c.day = n.target_date;
end $$;

create or replace function public.birthday_email_backlog(p_secret text)
returns integer language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return (
    select count(*)::integer
    from generate_series(v_today - 2, v_today, interval '1 day') as d
    cross join lateral public.celebration_candidates(d::date) c
    where c.send_email and c.email is not null
      and not exists (select 1 from public.message_log l
                      where l.member_id = c.member_id and l.kind = c.kind and l.channel = 'email' and l.target_date = d::date)
  );
end $$;

create or replace function public.deliver_birthday_notifications(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_day date := public.today_br();
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key)
  select c.user_id, c.church_id, c.kind,
         left(public.render_template(c.title, c.name, c.church_name, c.years), 200),
         left(public.render_template(c.body, c.name, c.church_name, c.years), 600),
         '#/', c.kind || ':' || c.church_id || ':' || v_day
  from public.celebration_candidates(v_day) c
  where c.user_id is not null and c.consent
  on conflict do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- Resumo para a liderança: aniversariantes de hoje (today_names), as datas
-- especiais de hoje (today_special) e, às segundas, a semana com o tipo de cada data.
drop function if exists public.claim_leader_summaries(text);
create function public.claim_leader_summaries(p_secret text)
returns table (log_id bigint, church_slug text, church_name text, today_names text[], today_special jsonb, week jsonb,
               endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_day date := public.today_br();
  v_monday boolean := extract(isodow from public.today_br()) = 1;
begin
  perform public.envio_check_secret(p_secret);
  return query
  with datas as (
    -- Todas as datas da igreja de hoje até daqui a 7 dias, conforme as funcionalidades ligadas.
    select c.id as church_id, m.name, d::date as on_date, x.kind,
           (extract(year from d) - extract(year from x.on_date))::integer as years
    from public.churches c
    join public.members m on m.church_id = c.id and m.status = 'ativo'
    cross join lateral (values ('aniversario', m.birth_date), ('casamento', m.wedding_date), ('batismo', m.baptism_date)) as x(kind, on_date)
    join generate_series(v_day, v_day + 7, interval '1 day') as d on public.is_birthday(x.on_date, d::date)
    where c.active and not c.is_test
      and case x.kind
            when 'aniversario' then coalesce((c.features->>'aniversarios')::boolean, false)
            else coalesce((c.features->>'datas_especiais')::boolean, false) and extract(year from d) > extract(year from x.on_date)
          end
  ),
  resumo as (
    select c.id as church_id, c.slug, c.name,
      array(select x.name from datas x where x.church_id = c.id and x.on_date = v_day and x.kind = 'aniversario'
            order by x.name) as today_names,
      coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'kind', x.kind, 'years', x.years) order by x.kind, x.name)
                from datas x where x.church_id = c.id and x.on_date = v_day and x.kind <> 'aniversario'), '[]'::jsonb) as today_special,
      coalesce((select jsonb_agg(jsonb_build_object('name', x.name, 'date', x.on_date, 'kind', x.kind) order by x.on_date, x.name)
                from datas x where x.church_id = c.id and x.on_date > v_day), '[]'::jsonb) as week
    from public.churches c
    join public.message_templates t on t.church_id = c.id and t.kind = 'resumo_lideres'
    where c.active and not c.is_test and t.enabled and t.send_push
      and (coalesce((c.features->>'aniversarios')::boolean, false) or coalesce((c.features->>'datas_especiais')::boolean, false))
  ),
  alvo as (
    select r.*, m.id as member_id, m.user_id
    from resumo r
    join public.members m on m.church_id = r.church_id
    where m.role in ('admin', 'secretaria', 'lider') and m.status = 'ativo'
      and m.user_id is not null and m.consent_at is not null
      and (cardinality(r.today_names) > 0 or jsonb_array_length(r.today_special) > 0
           or (v_monday and jsonb_array_length(r.week) > 0))
      and exists (select 1 from public.push_subscriptions ps where ps.user_id = m.user_id)
  ),
  novos as (
    insert into public.message_log (church_id, member_id, kind, channel, target_date)
    select church_id, member_id, 'resumo_lideres', 'push', v_day from alvo
    on conflict do nothing
    returning id, member_id
  )
  select n.id, a.slug, a.name, a.today_names, a.today_special, case when v_monday then a.week else '[]'::jsonb end,
         ps.endpoint, ps.p256dh, ps.auth
  from novos n
  join alvo a on a.member_id = n.member_id
  join public.push_subscriptions ps on ps.user_id = a.user_id;
end $$;

revoke execute on function public.claim_birthday_push(text) from public;
revoke execute on function public.claim_birthday_email(text) from public;
revoke execute on function public.claim_leader_summaries(text) from public;
grant execute on function public.claim_birthday_push(text) to anon;
grant execute on function public.claim_birthday_email(text) to anon;
grant execute on function public.claim_leader_summaries(text) to anon;

-- ---------------------------------------------------------------------
-- 6. Datas para as telas (cartão da semana e lista do mês), com a regra de
--    privacidade: a liderança vê todas (e os anos); os membros veem só as
--    datas que cada pessoa autorizou, sem o ano. Período de até 62 dias.
-- ---------------------------------------------------------------------
create or replace function public.celebrations_between(p_church uuid, p_from date, p_to date)
returns table (member_id uuid, name text, kind text, on_date date, photo_path text, years integer)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_leader boolean := public.is_leader(p_church);
  v_features jsonb;
begin
  if not (v_leader or public.is_member(p_church)) then
    return;
  end if;
  if p_to < p_from or p_to - p_from > 62 then
    raise exception 'Período inválido (até 62 dias).';
  end if;
  select features into v_features from public.churches where id = p_church;
  return query
  select m.id, m.name, x.kind, d::date, m.photo_path,
         case when v_leader then (extract(year from d) - extract(year from x.on_date))::integer end
  from public.members m
  cross join lateral (values
    ('aniversario', m.birth_date, m.show_birthday, coalesce((v_features->>'aniversarios')::boolean, false)),
    ('casamento', m.wedding_date, m.show_wedding, coalesce((v_features->>'datas_especiais')::boolean, false)),
    ('batismo', m.baptism_date, m.show_baptism, coalesce((v_features->>'datas_especiais')::boolean, false))
  ) as x(kind, on_date, shown, feature_on)
  join generate_series(p_from, p_to, interval '1 day') as d on public.is_birthday(x.on_date, d::date)
  where m.church_id = p_church
    and m.status = 'ativo'
    and x.feature_on
    and (v_leader or x.shown)
    and (x.kind = 'aniversario' or extract(year from d) > extract(year from x.on_date))
  order by d, x.kind <> 'aniversario', x.kind, m.name;
end $$;
revoke execute on function public.celebrations_between(uuid, date, date) from public, anon;
grant execute on function public.celebrations_between(uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------
-- 7. "Baixar meus dados" com as datas novas
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
    'aviso', 'Dados que o CC4 guarda sobre você. Dados de outras pessoas não aparecem aqui.',
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
          'mostra_telefone_aos_membros', m.show_phone),
        'mensagens_enviadas', coalesce((
          select jsonb_agg(jsonb_build_object('tipo', l.kind, 'canal', l.channel, 'data', l.target_date, 'situacao', l.status)
                           order by l.target_date desc)
          from public.message_log l where l.member_id = m.id), '[]'::jsonb))
        order by c.name)
      from public.members m join public.churches c on c.id = m.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'notificacoes', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'tipo', n.kind, 'titulo', n.title, 'texto', n.body,
                                          'criada_em', n.created_at, 'lida_em', n.read_at) order by n.created_at desc)
      from public.notifications n join public.churches c on c.id = n.church_id
      where n.user_id = v_user), '[]'::jsonb),
    'aparelhos_com_notificacao', coalesce((
      select jsonb_agg(jsonb_build_object('servico', split_part(split_part(ps.endpoint, '://', 2), '/', 1), 'ativado_em', ps.created_at))
      from public.push_subscriptions ps where ps.user_id = v_user), '[]'::jsonb),
    'publicado_por_voce', jsonb_build_object(
      'eventos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', e.title, 'inicio', e.starts_at, 'criado_em', e.created_at))
        from public.events e join public.churches c on c.id = e.church_id where e.created_by = v_user), '[]'::jsonb),
      'avisos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', a.title, 'criado_em', a.created_at))
        from public.announcements a join public.churches c on c.id = a.church_id where a.created_by = v_user), '[]'::jsonb),
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;

-- ---------------------------------------------------------------------
-- 8. Dados de teste: as igrejas de teste ligam as datas especiais, e a
--    Teste A ganha duas pessoas com datas em junho (uma autorizou mostrar o
--    casamento; o batismo da outra fica oculto para os membros).
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"datas_especiais": true}'::jsonb
where slug in ('teste-a', 'teste-b');

insert into public.members (church_id, role, name, wedding_date, show_wedding)
select c.id, 'membro', 'Casada da A', '2010-06-12', true
from public.churches c
where c.slug = 'teste-a'
  and not exists (select 1 from public.members m where m.church_id = c.id and m.name = 'Casada da A');

insert into public.members (church_id, role, name, baptism_date, show_baptism)
select c.id, 'membro', 'Batizado da A', '2020-06-20', false
from public.churches c
where c.slug = 'teste-a'
  and not exists (select 1 from public.members m where m.church_id = c.id and m.name = 'Batizado da A');
