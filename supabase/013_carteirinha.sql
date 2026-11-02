-- =====================================================================
-- CC4 — carteirinha digital de membro (Fase 3)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Cada membro vê a própria carteirinha (nome, foto, papel, membro desde,
--   batismo) com um QR Code de conferência
-- - O QR leva a uma página pública que confirma se o cadastro está ativo,
--   pelo código secreto da carteirinha (nunca pelo número do cadastro).
--   Ela mostra só o que está na carteirinha: sem foto, telefone, e-mail ou aniversário
-- - A pessoa gera um QR novo quando quiser (o antigo deixa de valer)
-- - "Membro desde": só a liderança preenche
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Cadastro: código da carteirinha e "membro desde"
-- ---------------------------------------------------------------------
alter table public.members add column if not exists member_since date check (member_since > '1900-01-01');
alter table public.members add column if not exists card_token uuid not null default gen_random_uuid();
alter table public.members add column if not exists card_token_at timestamptz not null default now();
create unique index if not exists members_card_token_idx on public.members (card_token);
grant update (member_since) on public.members to authenticated;

-- A pessoa edita o próprio cadastro, mas "membro desde" é da liderança.
create or replace function public.members_since_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.member_since is distinct from old.member_since and auth.uid() is not null
     and not public.is_leader(new.church_id) then
    raise exception 'Só a liderança da instituição de ensino muda "membro desde".' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists members_since_guard on public.members;
create trigger members_since_guard before update of member_since on public.members
  for each row execute function public.members_since_guard();
revoke execute on function public.members_since_guard() from public, anon, authenticated;

create or replace function public.cards_on(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select (c.features->>'carteirinha')::boolean from public.churches c where c.id = p_church and c.active), false)
$$;
revoke execute on function public.cards_on(uuid) from public, anon;
grant execute on function public.cards_on(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 2. Gerar um QR Code novo (o antigo deixa de valer)
-- ---------------------------------------------------------------------
create or replace function public.rotate_card_token(p_church uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_token uuid;
begin
  update public.members
     set card_token = gen_random_uuid(), card_token_at = now()
   where church_id = p_church and user_id = auth.uid() and status = 'ativo' and consent_at is not null
     and public.cards_on(p_church)
  returning card_token into v_token;
  if v_token is null then
    raise exception 'Carteirinha não encontrada.' using errcode = '42501';
  end if;
  return v_token;
end $$;
revoke execute on function public.rotate_card_token(uuid) from public, anon;
grant execute on function public.rotate_card_token(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Conferência pública (sem login), só pelo código exato
-- ---------------------------------------------------------------------
create or replace function public.verify_member_card(p_token uuid)
returns table (church_name text, church_slug text, logo_url text, primary_color text,
               name text, role text, member_since date, active boolean)
language sql stable security definer set search_path = '' as $$
  select c.name, c.slug, c.logo_url, c.primary_color, m.name, m.role, m.member_since,
         m.status = 'ativo' and m.consent_at is not null
  from public.members m
  join public.churches c on c.id = m.church_id
  where m.card_token = p_token and c.active and public.cards_on(c.id)
$$;
revoke execute on function public.verify_member_card(uuid) from public;
grant execute on function public.verify_member_card(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Dados de teste: as igrejas de teste ligam a carteirinha
-- ---------------------------------------------------------------------
update public.churches set features = features || '{"carteirinha": true}'::jsonb
where slug in ('teste-a', 'teste-b');
