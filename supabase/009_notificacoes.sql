-- =====================================================================
-- Notificações que também vão por push (avisos, galeria, salas)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - push_pending: a notificação da central também sai como push no celular
-- - claim_notification_push: o envio dos lembretes (GitHub Actions, com a senha
--   ENVIO_SECRET) pega as notificações novas e os aparelhos de cada pessoa
-- =====================================================================

alter table public.notifications add column if not exists push_pending boolean not null default false;
create index if not exists notifications_push_idx on public.notifications (created_at) where push_pending;

-- Notificações da central que também vão por push (até 1 dia depois). Todas saem da fila;
-- as das igrejas de teste e das desativadas ficam só na central.
create or replace function public.claim_notification_push(p_secret text)
returns table (notification_id bigint, church_slug text, church_name text, kind text, title text, body text, url text,
               endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform public.envio_check_secret(p_secret);
  return query
  with novos as (
    update public.notifications n
       set push_pending = false
      from public.churches c
     where c.id = n.church_id and n.push_pending
    returning n.id, n.user_id, n.kind, n.title, n.body, n.url, n.created_at, c.slug, c.name, c.active, c.is_test
  )
  select n.id, n.slug, n.name, n.kind, n.title, n.body, n.url, ps.endpoint, ps.p256dh, ps.auth
  from novos n
  join public.push_subscriptions ps on ps.user_id = n.user_id
  where n.active and not n.is_test and n.created_at > now() - interval '1 day';
end $$;
revoke execute on function public.claim_notification_push(text) from public;
grant execute on function public.claim_notification_push(text) to anon;
