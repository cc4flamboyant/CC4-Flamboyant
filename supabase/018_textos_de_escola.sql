-- =====================================================================
-- CC4 — mensagem de aniversário com cara de escola e o campo {instituicao}
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 017). Pode rodar de novo.
-- - O campo {instituicao} vira o nome da instituição de ensino ({igreja}
--   continua funcionando nas mensagens antigas).
-- - A mensagem de aniversário padrão deixa de falar em Deus.

create or replace function public.render_template(p_text text, p_name text, p_church text, p_age integer)
returns text language sql immutable as $$
  select trim(regexp_replace(
    replace(replace(replace(replace(replace(replace(p_text,
      '{nome}', p_name),
      '{primeiro_nome}', split_part(trim(p_name), ' ', 1)),
      '{igreja}', p_church),
      '{instituicao}', p_church),
      '{idade}', coalesce(p_age::text, '')),
      '{anos}', public.years_text(p_age)),
    '[ \t]{2,}', ' ', 'g'))
$$;

create or replace function public.create_default_templates()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.message_templates (church_id, kind, title, body)
  values
    (new.id, 'aniversario', 'Feliz aniversário, {primeiro_nome}!',
     'A {instituicao} celebra o seu dia! Desejamos um novo ano cheio de alegria, saúde e conquistas. Um abraço de toda a equipe.'),
    (new.id, 'resumo_lideres', 'Aniversariantes', 'Resumo dos aniversariantes para a liderança.'),
    (new.id, 'casamento', 'Feliz aniversário de casamento, {primeiro_nome}!',
     'Hoje você completa {anos} de casamento! A {igreja} se alegra com vocês e pede a Deus que continue abençoando o seu lar. 💍'),
    (new.id, 'batismo', 'Feliz aniversário de batismo, {primeiro_nome}!',
     'Hoje faz {anos} do seu batismo! A {igreja} celebra com você essa decisão e agradece a Deus pela sua caminhada. 🕊️')
  on conflict do nothing;
  return new;
end $$;

-- Mensagens já gravadas: o texto padrão novo (só se ainda for o padrão) e o campo novo.
update public.message_templates
set body = 'A {instituicao} celebra o seu dia! Desejamos um novo ano cheio de alegria, saúde e conquistas. Um abraço de toda a equipe.'
where kind = 'aniversario'
  and body in (
    'A {igreja} celebra a sua vida hoje! Que Deus abençoe o seu novo ano com paz, saúde e alegria. Um abraço de toda a igreja.',
    'A {igreja} celebra a sua vida hoje! Que Deus abençoe o seu novo ano com paz, saúde e alegria. Um abraço de toda a instituição de ensino.'
  );

update public.message_templates
set title = replace(title, '{igreja}', '{instituicao}'),
    body = replace(body, '{igreja}', '{instituicao}')
where title like '%{igreja}%' or body like '%{igreja}%';
