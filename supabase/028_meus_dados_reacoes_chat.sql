-- =====================================================================
-- CC4 — "Baixar meus dados" com as reações do chat
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 027). Pode rodar de novo.
--
-- - Acrescenta "reacoes_no_chat": em qual grupo, com qual emoji e quando a pessoa reagiu
--   (o texto da mensagem não vai: é de outra pessoa)
-- - O resto é igual ao 021

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
    'grupos_de_conversa', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'grupo', g.name, 'administrador', cm.is_admin, 'desde', cm.added_at) order by cm.added_at)
      from public.chat_members cm
      join public.members me on me.id = cm.member_id and me.user_id = v_user
      join public.chat_groups g on g.id = cm.group_id
      join public.churches c on c.id = g.church_id), '[]'::jsonb),
    'mensagens_enviadas_no_chat', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'grupo', g.name, 'texto', x.body, 'arquivo', x.file_name, 'em', x.created_at) order by x.created_at)
      from public.chat_messages x
      join public.members me on me.id = x.author_id and me.user_id = v_user
      join public.chat_groups g on g.id = x.group_id
      join public.churches c on c.id = g.church_id), '[]'::jsonb),
    'reacoes_no_chat', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'grupo', g.name, 'reacao', r.emoji, 'em', r.created_at) order by r.created_at)
      from public.chat_reactions r
      join public.members me on me.id = r.member_id and me.user_id = v_user
      join public.chat_groups g on g.id = r.group_id
      join public.churches c on c.id = g.church_id), '[]'::jsonb),
    'comentarios_em_projetos', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'projeto', p.title, 'comentario', x.body, 'em', x.created_at) order by x.created_at)
      from public.project_comments x
      join public.members me on me.id = x.author_id and me.user_id = v_user
      join public.room_projects p on p.id = x.project_id
      join public.churches c on c.id = p.church_id), '[]'::jsonb),
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
