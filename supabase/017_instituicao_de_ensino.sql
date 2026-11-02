-- =====================================================================
-- CC4 — "igreja" vira "instituição de ensino" nos textos do banco
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 016). Pode rodar de novo.
-- Troca as mensagens de erro das funções e os textos iniciais
-- (Instituição de Ensino Exemplo e mensagem de aniversário padrão).
-- Os nomes técnicos (tabelas, pasta "igrejas" das imagens, campo {igreja}
-- das mensagens) continuam iguais.

-- 1. Textos já gravados
update public.churches
set name = 'Instituição de Ensino Exemplo'
where slug = 'exemplo' and name = 'Igreja Exemplo';

update public.churches
set welcome_text = 'Seja bem-vindo! Aqui você acompanha a agenda, os avisos e os aniversariantes da instituição de ensino.'
where welcome_text = 'Seja bem-vindo! Aqui você acompanha a agenda, os avisos e os aniversariantes da igreja.';

update public.message_templates
set body = replace(body, 'Um abraço de toda a igreja.', 'Um abraço de toda a instituição de ensino.')
where kind = 'aniversario' and body like '%Um abraço de toda a igreja.%';

-- 2. Funções com as mensagens novas (mesma lógica de antes)

-- public.members_guard (versão de 003_membros.sql)
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
      raise exception 'Só o administrador da instituição de ensino define papéis.' using errcode = '42501';
    end if;
    if (select count(*) from public.members where church_id = new.church_id)
       >= (select max_members from public.churches where id = new.church_id) then
      raise exception 'A instituição de ensino chegou ao limite de membros do plano.' using errcode = '54000';
    end if;
    new.created_by := auth.uid();
    return new;
  end if;

  -- Tirar ou rebaixar um administrador: só outro administrador, e nunca o último.
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin' or new.status <> 'ativo') then
    if not v_admin then
      raise exception 'Só o administrador da instituição de ensino altera outro administrador.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.members
      where church_id = old.church_id and id <> old.id and role = 'admin' and status = 'ativo' and user_id is not null
    ) then
      raise exception 'A instituição de ensino precisa de pelo menos um administrador.' using errcode = '42501';
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
    raise exception 'Só o administrador da instituição de ensino define papéis.' using errcode = '42501';
  end if;
  -- O próprio membro (sem papel de liderança) não muda e-mail nem situação.
  if not v_leader and (new.email is distinct from old.email or new.status <> old.status) then
    raise exception 'Peça à secretaria da instituição de ensino para alterar este dado.' using errcode = '42501';
  end if;
  -- Quem já entrou no app usa este e-mail para entrar: trocar exige desligar a conta antes.
  if old.user_id is not null and lower(new.email) is distinct from lower(old.email) then
    raise exception 'Esta pessoa já entrou no app com este e-mail. Para trocar, desligue a conta dela primeiro.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end $$;

-- public.create_church (versão de 001_base.sql)
create or replace function public.create_church(p_slug text, p_name text, p_admin_email text, p_admin_name text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Só o administrador da plataforma cria instituições de ensino.' using errcode = '42501';
  end if;
  insert into public.churches (slug, name) values (lower(trim(p_slug)), trim(p_name)) returning id into v_id;
  perform public.set_church_admin(v_id, p_admin_email, p_admin_name);
  return v_id;
end $$;

-- public.set_church_admin (versão de 001_base.sql)
create or replace function public.set_church_admin(p_church uuid, p_email text, p_name text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
begin
  if not public.is_platform_admin() then
    raise exception 'Só o administrador da plataforma define o administrador da instituição de ensino.' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'E-mail inválido.';
  end if;
  update public.members set role = 'admin', status = 'ativo'
   where church_id = p_church and lower(email) = v_email;
  if not found then
    insert into public.members (church_id, role, name, email)
    values (p_church, 'admin', coalesce(nullif(trim(p_name), ''), split_part(v_email, '@', 1)), v_email);
  end if;
end $$;

-- public.set_church_active (versão de 001_base.sql)
create or replace function public.set_church_active(p_church uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Só o administrador da plataforma ativa ou desativa instituições de ensino.' using errcode = '42501';
  end if;
  update public.churches set active = p_active where id = p_church;
end $$;

-- public.unlink_member_account (versão de 003_membros.sql)
create or replace function public.unlink_member_account(p_member uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m public.members;
begin
  select * into m from public.members where id = p_member;
  if m.id is null or not public.has_role(m.church_id, 'admin') then
    raise exception 'Só o administrador da instituição de ensino desliga contas.' using errcode = '42501';
  end if;
  if m.role = 'admin' and not exists (
    select 1 from public.members
    where church_id = m.church_id and id <> m.id and role = 'admin' and status = 'ativo' and user_id is not null
  ) then
    raise exception 'A instituição de ensino precisa de pelo menos um administrador.' using errcode = '42501';
  end if;
  update public.members set user_id = null, consent_at = null where id = p_member;
end $$;

-- public.create_default_templates (versão de 008_datas_especiais.sql)
create or replace function public.create_default_templates()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.message_templates (church_id, kind, title, body)
  values
    (new.id, 'aniversario', 'Feliz aniversário, {primeiro_nome}!',
     'A {igreja} celebra a sua vida hoje! Que Deus abençoe o seu novo ano com paz, saúde e alegria. Um abraço de toda a instituição de ensino.'),
    (new.id, 'resumo_lideres', 'Aniversariantes', 'Resumo dos aniversariantes para a liderança.'),
    (new.id, 'casamento', 'Feliz aniversário de casamento, {primeiro_nome}!',
     'Hoje você completa {anos} de casamento! A {igreja} se alegra com vocês e pede a Deus que continue abençoando o seu lar. 💍'),
    (new.id, 'batismo', 'Feliz aniversário de batismo, {primeiro_nome}!',
     'Hoje faz {anos} do seu batismo! A {igreja} celebra com você essa decisão e agradece a Deus pela sua caminhada. 🕊️')
  on conflict do nothing;
  return new;
end $$;

-- public.children_guard (versão de 012_salas.sql)
create or replace function public.children_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.guardian_member_id is not null
     and not exists (select 1 from public.members m where m.id = new.guardian_member_id and m.church_id = new.church_id) then
    raise exception 'O responsável precisa ser do cadastro da mesma instituição de ensino.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.church_id <> old.church_id or new.guardian_member_id is distinct from old.guardian_member_id) then
    raise exception 'Não dá para trocar a instituição de ensino nem o responsável.' using errcode = '42501';
  end if;
  return new;
end $$;

-- public.kids_rooms_guard (versão de 012_salas.sql)
create or replace function public.kids_rooms_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.tutor_member_id is not null
     and not exists (select 1 from public.members m where m.id = new.tutor_member_id and m.church_id = new.church_id) then
    raise exception 'O tutor precisa ser do cadastro da mesma instituição de ensino.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.church_id <> old.church_id then
    raise exception 'A sala não muda de instituição de ensino.' using errcode = '42501';
  end if;
  return new;
end $$;

-- public.members_since_guard (versão de 013_carteirinha.sql)
create or replace function public.members_since_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.member_since is distinct from old.member_since and auth.uid() is not null
     and not public.is_leader(new.church_id) then
    raise exception 'Só a liderança da instituição de ensino muda "membro desde".' using errcode = '42501';
  end if;
  return new;
end $$;

-- public.gallery_set_publisher (versão de 014_galeria.sql)
create or replace function public.gallery_set_publisher(p_member uuid, p_on boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
begin
  select m.church_id into v_church from public.members m where m.id = p_member;
  if v_church is null or not coalesce(public.has_role(v_church, 'admin'), false) then
    raise exception 'Só o administrador da instituição de ensino escolhe quem publica na galeria.' using errcode = '42501';
  end if;
  update public.members set gallery_publisher = coalesce(p_on, false) where id = p_member;
end $$;

