-- =====================================================================
-- CC4 — base: igrejas, membros, papéis e regras de acesso
-- Rode este arquivo inteiro no SQL Editor do Supabase.
--
-- Regra principal: ninguém vê dados de uma igreja da qual não participa.
-- Isso é garantido aqui no banco (RLS), não só na tela.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Administradores da plataforma (quem cria igrejas). Ninguém lê pelo app.
-- ---------------------------------------------------------------------
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Igrejas: aparência, textos e funcionalidades ligadas.
-- Tudo aqui é público (aparece antes do login), então nada sensível.
-- ---------------------------------------------------------------------
create table if not exists public.churches (
  id               uuid primary key default gen_random_uuid(),
  slug             text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 40),
  name             text not null check (char_length(name) between 2 and 80),
  short_name       text check (char_length(short_name) <= 20),          -- nome embaixo do ícone no celular
  logo_url         text check (char_length(logo_url) <= 500),
  icon_background  text not null default '#ffffff' check (icon_background ~ '^#[0-9a-f]{6}$'),
  primary_color    text not null default '#3b5bdb' check (primary_color ~ '^#[0-9a-f]{6}$'),
  branding_version integer not null default 1,                          -- muda quando nome, logo ou cor mudam
  welcome_text     text check (char_length(welcome_text) <= 500),
  about_text       text check (char_length(about_text) <= 2000),
  address          text check (char_length(address) <= 200),
  city             text check (char_length(city) <= 80),
  pix_key          text check (char_length(pix_key) <= 120),
  pix_name         text check (char_length(pix_name) <= 80),
  social           jsonb not null default '{}' check (jsonb_typeof(social) = 'object' and octet_length(social::text) <= 2000),
  -- Funcionalidades ligadas. As das próximas fases já têm nome reservado:
  -- datas_especiais, oracao, escalas, pix, visitantes, celulas, inscricoes,
  -- infantil, carteirinha, relatorios, galeria, devocional.
  features         jsonb not null default '{"aniversarios": true, "agenda": true, "avisos": true}'
                   check (jsonb_typeof(features) = 'object' and octet_length(features::text) <= 2000),
  privacy_email    text check (char_length(privacy_email) <= 160),      -- contato da igreja para pedidos de LGPD
  privacy_text     text check (char_length(privacy_text) <= 8000),      -- complemento da política da plataforma
  max_members      integer not null default 1000 check (max_members > 0), -- reservado para planos no futuro
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Membros: o cadastro da igreja. A pessoa não precisa ter conta.
-- Quando ela entra com o mesmo e-mail, a conta é ligada ao cadastro
-- (user_id) e o papel passa a valer.
-- ---------------------------------------------------------------------
create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  church_id     uuid not null references public.churches on delete cascade,
  user_id       uuid references auth.users on delete set null,
  role          text not null default 'membro' check (role in ('admin', 'secretaria', 'lider', 'membro')),
  name          text not null check (char_length(name) between 2 and 120),
  email         text check (char_length(email) <= 160 and email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone         text check (phone ~ '^55[0-9]{10,11}$'),
  birth_date    date check (birth_date >= '1900-01-01'),
  photo_path    text check (char_length(photo_path) <= 300),
  show_birthday boolean not null default false,   -- membros veem dia e mês (nunca o ano)
  show_phone    boolean not null default false,   -- membros veem o telefone
  consent_at    timestamptz,                      -- quando a pessoa aceitou participar pelo app
  status        text not null default 'ativo' check (status in ('ativo', 'inativo')),
  created_by    uuid default auth.uid() references auth.users on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (church_id, user_id)
);
create unique index if not exists members_church_email_idx on public.members (church_id, lower(email)) where email is not null;
create index if not exists members_user_idx on public.members (user_id) where user_id is not null;
create index if not exists members_birthday_idx on public.members (church_id, extract(month from birth_date), extract(day from birth_date));

-- ---------------------------------------------------------------------
-- Funções auxiliares das regras de acesso.
-- Nas regras, use "church_id in (select public.my_church_ids(...))":
-- o Postgres calcula a lista uma vez por consulta, não uma vez por linha.
-- Só contam cadastros ativos, com a conta ligada e o convite aceito.
-- ---------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- p_level: 'membro' (qualquer papel), 'lideranca' (admin, secretaria, lider) ou 'admin'.
create or replace function public.my_church_ids(p_level text default 'membro')
returns setof uuid language sql stable security definer set search_path = '' as $$
  select m.church_id
  from public.members m
  join public.churches c on c.id = m.church_id
  where m.user_id = auth.uid()
    and m.status = 'ativo'
    and m.consent_at is not null
    and c.active
    and case p_level
          when 'membro' then true
          when 'lideranca' then m.role in ('admin', 'secretaria', 'lider')
          when 'admin' then m.role = 'admin'
          else false
        end
$$;

create or replace function public.is_member(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_church in (select public.my_church_ids('membro'))
$$;

-- Ex.: has_role(church_id, 'admin', 'secretaria')
create or replace function public.has_role(p_church uuid, variadic p_roles text[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.members m
    join public.churches c on c.id = m.church_id
    where m.church_id = p_church and m.user_id = auth.uid()
      and m.status = 'ativo' and m.consent_at is not null and c.active
      and m.role = any (p_roles)
  )
$$;

create or replace function public.is_leader(p_church uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_role(p_church, 'admin', 'secretaria', 'lider')
$$;

-- ---------------------------------------------------------------------
-- Gatilhos de igrejas: data de alteração e versão da aparência
-- ---------------------------------------------------------------------
create or replace function public.churches_touch()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if (new.name, new.short_name, new.logo_url, new.icon_background, new.primary_color)
     is distinct from (old.name, old.short_name, old.logo_url, old.icon_background, old.primary_color) then
    new.branding_version := old.branding_version + 1;
  end if;
  return new;
end $$;

drop trigger if exists churches_touch on public.churches;
create trigger churches_touch before update on public.churches
  for each row execute function public.churches_touch();

-- ---------------------------------------------------------------------
-- Gatilho de membros: o que cada papel pode mudar.
-- Roda com as permissões de quem chamou (sem "security definer"), para
-- saber se é alguém do app. As funções internas do banco passam direto.
-- ---------------------------------------------------------------------
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
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists members_guard on public.members;
create trigger members_guard before insert or update or delete on public.members
  for each row execute function public.members_guard();

-- ---------------------------------------------------------------------
-- Ligar a conta ao cadastro e responder ao convite
-- ---------------------------------------------------------------------
-- O app chama depois de cada login. Só vale para e-mail confirmado
-- (o link mágico e o Google confirmam). Devolve quantos cadastros ligou.
create or replace function public.link_my_account()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_count integer;
begin
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then
    return 0;
  end if;
  update public.members m
     set user_id = auth.uid()
   where lower(m.email) = v_email
     and m.user_id is null
     and not exists (select 1 from public.members x where x.church_id = m.church_id and x.user_id = auth.uid());
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- A pessoa aceita participar pelo app (consentimento da LGPD) ou diz que
-- não é dessa igreja: aí o e-mail sai do cadastro para não ligar de novo.
create or replace function public.respond_to_church(p_church uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  if p_accept then
    update public.members set consent_at = now()
     where church_id = p_church and user_id = auth.uid() and consent_at is null;
  else
    if exists (select 1 from public.members where church_id = p_church and user_id = auth.uid() and role = 'admin'
               and consent_at is not null) then
      raise exception 'Administradores precisam passar o papel para outra pessoa antes de sair.' using errcode = '42501';
    end if;
    update public.members set user_id = null, email = null, consent_at = null
     where church_id = p_church and user_id = auth.uid();
  end if;
end $$;

-- ---------------------------------------------------------------------
-- Administração da plataforma
-- ---------------------------------------------------------------------
create or replace function public.create_church(p_slug text, p_name text, p_admin_email text, p_admin_name text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'Só o administrador da plataforma cria igrejas.' using errcode = '42501';
  end if;
  insert into public.churches (slug, name) values (lower(trim(p_slug)), trim(p_name)) returning id into v_id;
  perform public.set_church_admin(v_id, p_admin_email, p_admin_name);
  return v_id;
end $$;

-- Define (ou acrescenta) um administrador para a igreja, pelo e-mail.
create or replace function public.set_church_admin(p_church uuid, p_email text, p_name text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(trim(p_email));
begin
  if not public.is_platform_admin() then
    raise exception 'Só o administrador da plataforma define o administrador da igreja.' using errcode = '42501';
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

create or replace function public.set_church_active(p_church uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Só o administrador da plataforma ativa ou desativa igrejas.' using errcode = '42501';
  end if;
  update public.churches set active = p_active where id = p_church;
end $$;

-- ---------------------------------------------------------------------
-- Permissões das funções: visitante sem login não chama nenhuma que mexe em dados.
-- ---------------------------------------------------------------------
revoke execute on function public.link_my_account() from public, anon;
revoke execute on function public.respond_to_church(uuid, boolean) from public, anon;
revoke execute on function public.create_church(text, text, text, text) from public, anon;
revoke execute on function public.set_church_admin(uuid, text, text) from public, anon;
revoke execute on function public.set_church_active(uuid, boolean) from public, anon;
grant execute on function public.link_my_account() to authenticated;
grant execute on function public.respond_to_church(uuid, boolean) to authenticated;
grant execute on function public.create_church(text, text, text, text) to authenticated;
grant execute on function public.set_church_admin(uuid, text, text) to authenticated;
grant execute on function public.set_church_active(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------
-- Segurança (RLS)
-- ---------------------------------------------------------------------
alter table public.platform_admins enable row level security;
alter table public.churches        enable row level security;
alter table public.members         enable row level security;

-- Administradores da plataforma: sem regra = ninguém lê nem grava pelo app.
revoke all on public.platform_admins from anon, authenticated;

-- Igrejas: as ativas são públicas (nome, logo, cores). Só o admin da igreja edita,
-- e só os campos de aparência e conteúdo. Criar, apagar e mudar o endereço: só pelas funções acima.
drop policy if exists "churches leitura" on public.churches;
create policy "churches leitura" on public.churches for select
  using (active or (select public.is_platform_admin()));
drop policy if exists "churches admin edita" on public.churches;
create policy "churches admin edita" on public.churches for update to authenticated
  using (id in (select public.my_church_ids('admin')))
  with check (id in (select public.my_church_ids('admin')));
revoke insert, update, delete on public.churches from anon, authenticated;
grant update (name, short_name, logo_url, icon_background, primary_color, welcome_text, about_text,
              address, city, pix_key, pix_name, social, features, privacy_email, privacy_text)
  on public.churches to authenticated;

-- Membros: cada pessoa vê o próprio cadastro; a liderança vê os da igreja.
-- Os outros membros não leem esta tabela: verão só o que a pessoa autorizou,
-- por funções próprias (ex.: aniversariantes do mês, sem o ano).
drop policy if exists "members leitura" on public.members;
create policy "members leitura" on public.members for select to authenticated
  using (user_id = (select auth.uid()) or church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "members lideranca cadastra" on public.members;
create policy "members lideranca cadastra" on public.members for insert to authenticated
  with check (church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "members edita" on public.members;
create policy "members edita" on public.members for update to authenticated
  using (user_id = (select auth.uid()) or church_id in (select public.my_church_ids('lideranca')))
  with check (user_id = (select auth.uid()) or church_id in (select public.my_church_ids('lideranca')));
drop policy if exists "members apaga" on public.members;
create policy "members apaga" on public.members for delete to authenticated
  using (church_id in (select public.my_church_ids('lideranca')) and (select public.has_role(church_id, 'admin', 'secretaria')));
revoke all on public.members from anon;
revoke update on public.members from authenticated;
grant update (role, name, email, phone, birth_date, photo_path, show_birthday, show_phone, status)
  on public.members to authenticated;

-- ---------------------------------------------------------------------
-- Arquivos (Storage), sempre em pastas por igreja: <church_id>/...
--   "igrejas": público (logo, ícones, imagem da mensagem de aniversário). Só o admin grava.
--   "membros": privado (fotos dos membros). Membros da igreja veem; a liderança grava.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('igrejas', 'igrejas', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('membros', 'membros', false, 1048576, array['image/jpeg', 'image/webp'])
on conflict (id) do nothing;

drop policy if exists "igrejas admin envia" on storage.objects;
create policy "igrejas admin envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'igrejas' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('admin') as id));
drop policy if exists "igrejas admin troca" on storage.objects;
create policy "igrejas admin troca" on storage.objects for update to authenticated
  using (bucket_id = 'igrejas' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('admin') as id))
  with check (bucket_id = 'igrejas' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('admin') as id));
drop policy if exists "igrejas admin apaga" on storage.objects;
create policy "igrejas admin apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'igrejas' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('admin') as id));
-- O "upsert" do Storage precisa ler o arquivo que vai trocar.
drop policy if exists "igrejas admin le" on storage.objects;
create policy "igrejas admin le" on storage.objects for select to authenticated
  using (bucket_id = 'igrejas' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('admin') as id));

drop policy if exists "membros igreja ve" on storage.objects;
create policy "membros igreja ve" on storage.objects for select to authenticated
  using (bucket_id = 'membros' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('membro') as id));
drop policy if exists "membros lideranca envia" on storage.objects;
create policy "membros lideranca envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'membros' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('lideranca') as id));
drop policy if exists "membros lideranca troca" on storage.objects;
create policy "membros lideranca troca" on storage.objects for update to authenticated
  using (bucket_id = 'membros' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('lideranca') as id))
  with check (bucket_id = 'membros' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('lideranca') as id));
drop policy if exists "membros lideranca apaga" on storage.objects;
create policy "membros lideranca apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'membros' and (storage.foldername(name))[1] in (select id::text from public.my_church_ids('lideranca') as id));

-- ---------------------------------------------------------------------
-- Primeira igreja de teste. O administrador dela é definido pelo app
-- (Plataforma > Igreja Exemplo > Definir administrador).
-- ---------------------------------------------------------------------
insert into public.churches (slug, name, short_name, welcome_text)
values ('exemplo', 'Igreja Exemplo', 'Exemplo', 'Seja bem-vindo! Aqui você acompanha a agenda, os avisos e os aniversariantes da igreja.')
on conflict (slug) do nothing;
