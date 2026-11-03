-- =====================================================================
-- CC4 — reações com emoji nos avisos
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 018). Pode rodar de novo.
-- Cada pessoa reage com um emoji por aviso (tocar de novo tira; tocar em
-- outro troca). O app mostra só quantas pessoas reagiram com cada emoji e
-- qual é a reação da própria pessoa: ninguém vê quem reagiu.
-- A reação é do cadastro da pessoa na instituição de ensino: some sozinha
-- se o aviso for apagado ou se a pessoa sair, for excluída ou apagar a conta.

create table if not exists public.announcement_reactions (
  announcement_id uuid not null references public.announcements on delete cascade,
  member_id       uuid not null references public.members on delete cascade,
  emoji           text not null check (emoji in ('👍', '❤️', '🎉', '😂', '😮', '😢')),
  created_at      timestamptz not null default now(),
  primary key (announcement_id, member_id)
);
create index if not exists announcement_reactions_member_idx on public.announcement_reactions (member_id);

-- Ninguém lê nem grava direto: só pelas duas funções abaixo.
alter table public.announcement_reactions enable row level security;
revoke all on public.announcement_reactions from anon, authenticated;

-- Contagem das reações dos avisos que a pessoa pode ver, e a reação dela.
create or replace function public.announcement_reaction_counts(p_church uuid)
returns table (announcement_id uuid, emoji text, total integer, mine boolean)
language sql stable security definer set search_path = '' as $$
  select r.announcement_id, r.emoji, count(*)::integer,
         bool_or(r.member_id = public.my_member_id(p_church))
  from public.announcement_reactions r
  join public.announcements a on a.id = r.announcement_id
  where a.church_id = p_church
    and (p_church in (select public.my_church_ids('lideranca'))
         or (p_church in (select public.my_church_ids('membro'))
             and (a.visible_until is null or a.visible_until >= public.today_br())))
  group by r.announcement_id, r.emoji
$$;
revoke execute on function public.announcement_reaction_counts(uuid) from public, anon;
grant execute on function public.announcement_reaction_counts(uuid) to authenticated;

-- Reagir (p_emoji) ou tirar a reação (p_emoji nulo). Só em aviso que a pessoa vê.
create or replace function public.set_announcement_reaction(p_announcement uuid, p_emoji text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_church uuid;
  v_until date;
  v_member uuid;
begin
  select a.church_id, a.visible_until into v_church, v_until
  from public.announcements a where a.id = p_announcement;
  v_member := public.my_member_id(v_church);
  if v_church is null or v_member is null
     or (v_until is not null and v_until < public.today_br()
         and v_church not in (select public.my_church_ids('lideranca'))) then
    raise exception 'Aviso não encontrado.' using errcode = '42501';
  end if;
  if p_emoji is null then
    delete from public.announcement_reactions where announcement_id = p_announcement and member_id = v_member;
  else
    insert into public.announcement_reactions (announcement_id, member_id, emoji)
    values (p_announcement, v_member, p_emoji)
    on conflict (announcement_id, member_id) do update set emoji = excluded.emoji, created_at = now();
  end if;
end $$;
revoke execute on function public.set_announcement_reaction(uuid, text) from public, anon;
grant execute on function public.set_announcement_reaction(uuid, text) to authenticated;

-- "Baixar meus dados" passa a trazer as reações (mesma função do 016, com uma parte a mais).
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
    'aviso', 'Dados que o app guarda sobre você. Dados de outras pessoas não aparecem aqui.',
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
          'mostra_telefone_aos_membros', m.show_phone,
          'membro_desde', m.member_since,
          'qr_da_carteirinha_gerado_em', m.card_token_at,
          'publica_na_galeria', m.gallery_publisher),
        'tutor_das_salas', coalesce((
          select jsonb_agg(r.name order by r.name) from public.kids_rooms r where r.tutor_member_id = m.id), '[]'::jsonb),
        'mensagens_enviadas', coalesce((
          select jsonb_agg(jsonb_build_object('tipo', l.kind, 'canal', l.channel, 'data', l.target_date, 'situacao', l.status)
                           order by l.target_date desc)
          from public.message_log l where l.member_id = m.id), '[]'::jsonb))
        order by c.name)
      from public.members m join public.churches c on c.id = m.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'filhos', coalesce((
      select jsonb_agg(jsonb_build_object(
        'igreja', ch.name, 'nome', c.name, 'nascimento', c.birth_date, 'alergias_e_cuidados', c.care_notes,
        'autorizado_em', c.consent_at,
        'sala', (select r.name from public.room_children rc join public.kids_rooms r on r.id = rc.room_id where rc.child_id = c.id),
        'presencas', coalesce((
          select jsonb_agg(s.session_date order by s.session_date desc)
          from public.room_attendance a join public.room_sessions s on s.id = a.session_id
          where a.child_id = c.id), '[]'::jsonb)) order by c.name)
      from public.children c
      join public.members m on m.id = c.guardian_member_id
      join public.churches ch on ch.id = c.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'pedidos_para_tirar_fotos_da_galeria', coalesce((
      select jsonb_agg(jsonb_build_object('motivo', r.reason, 'pedido_em', r.created_at) order by r.created_at desc)
      from public.gallery_removal_requests r where r.user_id = v_user), '[]'::jsonb),
    'notificacoes', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'tipo', n.kind, 'titulo', n.title, 'texto', n.body,
                                          'criada_em', n.created_at, 'lida_em', n.read_at) order by n.created_at desc)
      from public.notifications n join public.churches c on c.id = n.church_id
      where n.user_id = v_user), '[]'::jsonb),
    'aparelhos_com_notificacao', coalesce((
      select jsonb_agg(jsonb_build_object('servico', split_part(split_part(ps.endpoint, '://', 2), '/', 1), 'ativado_em', ps.created_at))
      from public.push_subscriptions ps where ps.user_id = v_user), '[]'::jsonb),
    'reacoes_aos_avisos', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'aviso', a.title, 'reacao', r.emoji, 'em', r.created_at) order by r.created_at)
      from public.announcement_reactions r
      join public.members me on me.id = r.member_id and me.user_id = v_user
      join public.announcements a on a.id = r.announcement_id
      join public.churches c on c.id = a.church_id), '[]'::jsonb),
    'publicado_por_voce', jsonb_build_object(
      'eventos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', e.title, 'inicio', e.starts_at, 'criado_em', e.created_at))
        from public.events e join public.churches c on c.id = e.church_id where e.created_by = v_user), '[]'::jsonb),
      'avisos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', a.title, 'criado_em', a.created_at))
        from public.announcements a join public.churches c on c.id = a.church_id where a.created_by = v_user), '[]'::jsonb),
      'albuns_da_galeria', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'album', g.title, 'data', g.album_date, 'criado_em', g.created_at))
        from public.gallery_albums g join public.churches c on c.id = g.church_id where g.created_by = v_user), '[]'::jsonb),
      'fotos_enviadas', (select count(*) from public.gallery_photos p where p.created_by = v_user),
      'anotacoes_de_aula', (select count(*) from public.room_sessions s where s.created_by = v_user),
      'avisos_para_os_pais', (select count(*) from public.room_messages x where x.created_by = v_user),
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;
revoke execute on function public.export_my_data() from public, anon;
grant execute on function public.export_my_data() to authenticated;
