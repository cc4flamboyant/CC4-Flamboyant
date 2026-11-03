-- =====================================================================
-- CC4 — aniversário dos filhos: mensagem para os pais
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 024). Pode rodar de novo.
--
-- - No dia do aniversário da criança (data de nascimento do cadastro dos filhos), o
--   responsável recebe a mensagem na central do app e no celular (push), às 7h
-- - O texto é o mesmo modelo de aniversário da instituição, com o nome e a idade da criança
-- - Só com "Aniversários" e "Salas" ligados, o modelo de aniversário ligado, e para o
--   responsável que é membro ativo, com conta no app e que aceitou os termos
-- - Sem e-mail (as crianças não têm e-mail; o dos pais fica para o aniversário deles)
-- - Quem envia é o mesmo robô das 7h (scripts/enviar-aniversarios.mjs), com a mesma senha

-- ---------------------------------------------------------------------
-- 1. Quem recebe hoje: o responsável de cada criança que faz aniversário
-- ---------------------------------------------------------------------
create or replace function public.child_birthday_candidates(p_day date)
returns table (child_id uuid, church_id uuid, user_id uuid, name text, years integer,
               church_slug text, church_name text, title text, body text, image_url text, send_push boolean)
language sql stable security definer set search_path = '' as $$
  select k.id, k.church_id, m.user_id, k.name,
         (extract(year from p_day) - extract(year from k.birth_date))::integer,
         c.slug, c.name, t.title, t.body, t.image_url, t.send_push
  from public.children k
  join public.members m on m.id = k.guardian_member_id
  join public.churches c on c.id = k.church_id
  join public.message_templates t on t.church_id = c.id and t.kind = 'aniversario'
  where c.active and not c.is_test and t.enabled
    and coalesce((c.features->>'aniversarios')::boolean, false)
    and coalesce((c.features->>'salas')::boolean, false)
    and m.church_id = k.church_id and m.status = 'ativo'
    and m.user_id is not null and m.consent_at is not null
    and public.is_birthday(k.birth_date, p_day)
$$;
revoke execute on function public.child_birthday_candidates(date) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Registro dos envios por push (um por criança por dia: irmãos gêmeos, uma mensagem cada)
-- ---------------------------------------------------------------------
create table if not exists public.child_birthday_log (
  id          bigint generated always as identity primary key,
  child_id    uuid not null references public.children on delete cascade,
  target_date date not null,
  status      text not null default 'enviado' check (status in ('enviado', 'falhou')),
  created_at  timestamptz not null default now(),
  unique (child_id, target_date)
);
alter table public.child_birthday_log enable row level security;
revoke all on public.child_birthday_log from anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Funções do robô (só com a senha do envio)
-- ---------------------------------------------------------------------
-- Central de notificações do responsável (abre em "Meus filhos").
create or replace function public.deliver_child_birthday_notifications(p_secret text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_day date := public.today_br();
  v_count integer;
begin
  perform public.envio_check_secret(p_secret);
  insert into public.notifications (user_id, church_id, kind, title, body, url, dedupe_key)
  select c.user_id, c.church_id, 'aniversario',
         left(public.render_template(c.title, c.name, c.church_name, c.years), 200),
         left(public.render_template(c.body, c.name, c.church_name, c.years), 600),
         '#/filhos', 'aniversario_filho:' || c.child_id || ':' || v_day
  from public.child_birthday_candidates(v_day) c
  on conflict do nothing;
  get diagnostics v_count = row_count;
  -- O registro dos envios guarda só os últimos 60 dias.
  delete from public.child_birthday_log where target_date < v_day - 60;
  return v_count;
end $$;

-- Push: reserva o envio de hoje de cada criança e devolve os aparelhos do responsável.
create or replace function public.claim_child_birthday_push(p_secret text)
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
    select * from public.child_birthday_candidates(v_day) c
    where c.send_push and exists (select 1 from public.push_subscriptions ps where ps.user_id = c.user_id)
  ),
  novos as (
    insert into public.child_birthday_log (child_id, target_date)
    select child_id, v_day from cand
    on conflict do nothing
    returning id, child_id
  )
  select n.id, c.church_slug, c.church_name, c.name, c.years, c.title, c.body, c.image_url, ps.endpoint, ps.p256dh, ps.auth
  from novos n
  join cand c on c.child_id = n.child_id
  join public.push_subscriptions ps on ps.user_id = c.user_id;
end $$;

create or replace function public.mark_child_birthday_failed(p_secret text, p_log_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.envio_check_secret(p_secret);
  update public.child_birthday_log set status = 'falhou' where id = p_log_id;
end $$;

revoke execute on function public.deliver_child_birthday_notifications(text) from public;
revoke execute on function public.claim_child_birthday_push(text) from public;
revoke execute on function public.mark_child_birthday_failed(text, bigint) from public;
grant execute on function public.deliver_child_birthday_notifications(text) to anon;
grant execute on function public.claim_child_birthday_push(text) to anon;
grant execute on function public.mark_child_birthday_failed(text, bigint) to anon;
