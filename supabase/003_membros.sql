-- =====================================================================
-- CC4 — cadastro de membros (entrega 4)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - Foto do membro sempre na pasta <igreja>/<membro>/ do Storage
-- - O próprio membro envia e troca a sua foto
-- - E-mail de quem já entrou no app só muda depois de desligar a conta
-- - O administrador desliga uma conta ligada ao cadastro errado
-- =====================================================================

create or replace function public.members_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  v_church uuid := coalesce(new.church_id, old.church_id);
  v_admin  boolean;
  v_leader boolean;
begin
  if current_user not in ('authenticated', 'anon') then
    if tg_op <> 'DELETE' then new.updated_at := now(); end if;
    return coalesce(new, old);
  end if;

  v_admin := public.has_role(v_church, 'admin');
  v_leader := public.is_leader(v_church);

  -- A foto fica na pasta do próprio membro: <igreja>/<membro>/...
  if tg_op <> 'DELETE' and new.photo_path is not null
     and new.photo_path not like new.church_id::text || '/' || new.id::text || '/%' then
    raise exception 'Foto fora da pasta do membro.' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.user_id is not null or new.consent_at is not null then
      raise exception 'A conta é ligada ao cadastro quando a própria pessoa entra no app.' using errcode = '42501';
    end if;
    if new.role <> 'membro' and not v_admin then
      raise exception 'Só o administrador da igreja define papéis.' using errcode = '42501';
    end if;
    if (select count(*) from public.members where church_id = new.church_id)
       >= (select max_members from public.churches where id = new.church_id) then
      raise exception 'A igreja chegou ao limite de membros do plano.' using errcode = '54000';
    end if;
    new.created_by := auth.uid();
    return new;
  end if;

  -- Tirar ou rebaixar um administrador: só outro administrador, e nunca o último.
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin' or new.status <> 'ativo') then
    if not v_admin then
      raise exception 'Só o administrador da igreja altera outro administrador.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.members
      where church_id = old.church_id and id <> old.id and role = 'admin' and status = 'ativo' and user_id is not null
    ) then
      raise exception 'A igreja precisa de pelo menos um administrador.' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  if new.church_id <> old.church_id
     or new.user_id is distinct from old.user_id
     or new.consent_at is distinct from old.consent_at
     or new.created_by is distinct from old.created_by
     or new.created_at <> old.created_at then
    raise exception 'Este campo não pode ser alterado.' using errcode = '42501';
  end if;
  if new.role <> old.role and not v_admin then
    raise exception 'Só o administrador da igreja define papéis.' using errcode = '42501';
  end if;
  -- O próprio membro (sem papel de liderança) não muda e-mail nem situação.
  if not v_leader and (new.email is distinct from old.email or new.status <> old.status) then
    raise exception 'Peça à secretaria da igreja para alterar este dado.' using errcode = '42501';
  end if;
  -- Quem já entrou no app usa este e-mail para entrar: trocar exige desligar a conta antes.
  if old.user_id is not null and lower(new.email) is distinct from lower(old.email) then
    raise exception 'Esta pessoa já entrou no app com este e-mail. Para trocar, desligue a conta dela primeiro.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- O administrador desliga a conta de um cadastro (ex.: a pessoa errada entrou com o e-mail).
-- O cadastro continua; a pessoa perde o acesso até entrar de novo e aceitar o convite.
create or replace function public.unlink_member_account(p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m public.members;
begin
  select * into m from public.members where id = p_member;
  if m.id is null or not public.has_role(m.church_id, 'admin') then
    raise exception 'Só o administrador da igreja desliga contas.' using errcode = '42501';
  end if;
  if m.role = 'admin' and not exists (
    select 1 from public.members
    where church_id = m.church_id and id <> m.id and role = 'admin' and status = 'ativo' and user_id is not null
  ) then
    raise exception 'A igreja precisa de pelo menos um administrador.' using errcode = '42501';
  end if;
  update public.members set user_id = null, consent_at = null where id = p_member;
end $$;

revoke execute on function public.unlink_member_account(uuid) from public, anon;
grant execute on function public.unlink_member_account(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- Foto do próprio membro: ele grava só na pasta <igreja>/<seu cadastro>/
-- (a liderança já grava em toda a pasta da igreja, pelo 001).
-- ---------------------------------------------------------------------
create or replace function public.my_member_folders()
returns setof text language sql stable security definer set search_path = '' as $$
  select m.church_id::text || '/' || m.id::text
  from public.members m
  where m.user_id = auth.uid() and m.status = 'ativo' and m.consent_at is not null
$$;

drop policy if exists "membros propria foto envia" on storage.objects;
create policy "membros propria foto envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'membros' and array_to_string((storage.foldername(name))[1:2], '/') in (select public.my_member_folders()));
drop policy if exists "membros propria foto troca" on storage.objects;
create policy "membros propria foto troca" on storage.objects for update to authenticated
  using (bucket_id = 'membros' and array_to_string((storage.foldername(name))[1:2], '/') in (select public.my_member_folders()))
  with check (bucket_id = 'membros' and array_to_string((storage.foldername(name))[1:2], '/') in (select public.my_member_folders()));
drop policy if exists "membros propria foto apaga" on storage.objects;
create policy "membros propria foto apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'membros' and array_to_string((storage.foldername(name))[1:2], '/') in (select public.my_member_folders()));
