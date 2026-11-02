-- =====================================================================
-- CC4 — 007: relógio do Supabase para os envios e a publicação
-- O agendamento grátis do GitHub atrasa ou pula rodadas em horário de movimento.
-- Aqui o Supabase (pg_cron, pontual) manda o GitHub rodar na hora certa:
--   - lembretes da agenda e avisos: a cada 10 minutos
--   - mensagens de aniversário: 7h de Brasília
--   - publicação do site: na hora em que uma igreja muda nome, ícone ou cor, ou é criada
-- O agendamento do GitHub continua como reserva; os envios não se repetem
-- (o banco registra cada envio).
--
-- ANTES de rodar: guarde a chave do GitHub no Vault com o nome github_token
-- (Supabase > Integrations > Vault > Add new secret). A chave não fica neste arquivo.
-- Pode rodar de novo quando quiser.
-- =====================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Fora da API: só o próprio banco chama essas funções.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- Pede ao GitHub para rodar um workflow (workflow_dispatch). Não espera a resposta:
-- o resultado fica em net._http_response por algumas horas (status 204 = deu certo).
create or replace function private.github_dispatch(p_workflow text)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'github_token';
  if v_token is null then
    raise warning 'Falta o segredo github_token no Vault do Supabase.';
    return null;
  end if;
  return net.http_post(
    url := 'https://api.github.com/repos/cc4flamboyant/CC4-Flamboyant/actions/workflows/' || p_workflow || '/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'cc4-supabase'
    ),
    body := jsonb_build_object('ref', 'main')
  );
end;
$$;
revoke all on function private.github_dispatch(text) from public, anon, authenticated;

-- Igreja de verdade mudou o que aparece no app instalado (ou foi criada, ativada, desativada):
-- publica o site de novo na hora. Igrejas de teste não disparam nada (os testes mexem nelas).
create or replace function private.churches_publish()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not new.is_test then perform private.github_dispatch('deploy.yml'); end if;
  elsif (new.is_test and old.is_test) then
    null;
  elsif (new.slug, new.name, new.short_name, new.primary_color, new.welcome_text, new.branding_version, new.active, new.is_test)
     is distinct from
        (old.slug, old.name, old.short_name, old.primary_color, old.welcome_text, old.branding_version, old.active, old.is_test) then
    perform private.github_dispatch('deploy.yml');
  end if;
  return null;
end;
$$;
revoke all on function private.churches_publish() from public, anon, authenticated;

drop trigger if exists churches_publish on public.churches;
create trigger churches_publish
  after insert or update on public.churches
  for each row execute function private.churches_publish();

-- Horários (o pg_cron usa UTC: 10h UTC = 7h de Brasília).
select cron.schedule('lembretes', '*/10 * * * *', $$select private.github_dispatch('lembretes.yml')$$);
select cron.schedule('aniversarios', '0 10 * * *', $$select private.github_dispatch('aniversarios.yml')$$);
-- O histórico do relógio cresce a cada rodada: guarda só os últimos 7 dias.
select cron.schedule('limpar-historico-do-relogio', '30 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);

-- Confira: devem aparecer os 3 horários.
select jobname, schedule, active from cron.job order by jobname;
