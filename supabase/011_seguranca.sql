-- =====================================================================
-- CC4 — reforços de segurança (scan de vulnerabilidades)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- O código do app é público (GitHub): toda regra precisa valer no banco,
-- não só na tela. Aqui:
-- - links das redes sociais da igreja: só endereços https:// (um link
--   "javascript:" gravado direto pela API viraria um ataque a quem tocasse)
-- - logo da igreja e imagem das mensagens: só https://
-- - notificações no celular: só endereços dos serviços de push conhecidos
-- - funções de gatilho: ninguém chama pelo app
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Links e imagens só com https://
-- ---------------------------------------------------------------------
create or replace function public.social_links_ok(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select not exists (
    select 1 from jsonb_each(coalesce(p, '{}'::jsonb)) e
    where jsonb_typeof(e.value) <> 'string'
       or (e.value #>> '{}') !~* '^https://[^[:space:]"<>''`]+$'
  )
$$;

alter table public.churches drop constraint if exists churches_social_https;
alter table public.churches add constraint churches_social_https check (public.social_links_ok(social)) not valid;
alter table public.churches drop constraint if exists churches_logo_https;
alter table public.churches add constraint churches_logo_https check (logo_url is null or logo_url ~* '^https://') not valid;
alter table public.message_templates drop constraint if exists message_templates_image_https;
alter table public.message_templates add constraint message_templates_image_https check (image_url is null or image_url ~* '^https://') not valid;

-- Confere também o que já está gravado. Se algo antigo não passar, a regra continua valendo
-- para tudo o que for gravado daqui em diante, e a lista abaixo mostra o que corrigir.
do $$
begin
  alter table public.churches validate constraint churches_social_https;
  alter table public.churches validate constraint churches_logo_https;
  alter table public.message_templates validate constraint message_templates_image_https;
exception when check_violation then
  raise notice 'Há links antigos fora do padrão; veja a consulta no fim do arquivo.';
end $$;

-- ---------------------------------------------------------------------
-- 2. Notificações no celular: só os serviços de push dos navegadores
--    (Chrome/Android/Samsung/Edge novo: FCM; Firefox: Mozilla; Safari/iPhone: Apple; Edge antigo: Windows)
-- ---------------------------------------------------------------------
create or replace function public.push_endpoint_ok(p text)
returns boolean language sql immutable set search_path = '' as $$
  select p ~ '^https://(fcm\.googleapis\.com|([a-z0-9-]+\.)*push\.services\.mozilla\.com|web\.push\.apple\.com|([a-z0-9-]+\.)*notify\.windows\.com)/'
$$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  if not public.push_endpoint_ok(p_endpoint) then
    raise exception 'Endereço de notificação não reconhecido.' using errcode = '22023';
  end if;
  insert into public.push_subscriptions (endpoint, user_id, p256dh, auth)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now();
end $$;
revoke execute on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Funções de gatilho: só o banco chama
-- ---------------------------------------------------------------------
revoke execute on function public.create_default_templates() from public, anon, authenticated;

-- Confira: deve vir vazio. Se aparecer alguma igreja, corrija os links em Configurar a igreja.
select slug, social, logo_url from public.churches
where not public.social_links_ok(social) or (logo_url is not null and logo_url !~* '^https://');
