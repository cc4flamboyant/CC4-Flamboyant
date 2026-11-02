-- =====================================================================
-- CC4 — os próprios dados: ver, exportar e excluir (entrega 7, LGPD)
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- - export_my_data: tudo o que o app guarda sobre a pessoa, num arquivo
-- - leave_church: a pessoa sai de uma igreja (o cadastro dela lá é apagado)
-- - delete_my_account: apaga a conta e os cadastros em todas as igrejas
-- O último administrador de uma igreja precisa passar o papel antes.
-- As fotos (Storage) são apagadas pelo app antes de chamar as funções.
-- =====================================================================

-- O último administrador ativo (com conta) de alguma igreja não pode sair dela.
create or replace function public.assert_not_last_admin(p_user uuid, p_church uuid default null)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text;
begin
  select c.name into v_name
  from public.members m
  join public.churches c on c.id = m.church_id
  where m.user_id = p_user and m.role = 'admin' and m.status = 'ativo'
    and (p_church is null or m.church_id = p_church)
    and not exists (
      select 1 from public.members o
      where o.church_id = m.church_id and o.id <> m.id and o.role = 'admin' and o.status = 'ativo' and o.user_id is not null
    )
  limit 1;
  if v_name is not null then
    raise exception 'Você é o único administrador da %. Passe o papel de administrador para outra pessoa antes.', v_name
      using errcode = '42501';
  end if;
end $$;
revoke execute on function public.assert_not_last_admin(uuid, uuid) from public, anon, authenticated;

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
    'aviso', 'Dados que o CC4 guarda sobre você. Dados de outras pessoas não aparecem aqui.',
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
          'foto', m.photo_path,
          'mostra_aniversario_aos_membros', m.show_birthday,
          'mostra_telefone_aos_membros', m.show_phone),
        'mensagens_enviadas', coalesce((
          select jsonb_agg(jsonb_build_object('tipo', l.kind, 'canal', l.channel, 'data', l.target_date, 'situacao', l.status)
                           order by l.target_date desc)
          from public.message_log l where l.member_id = m.id), '[]'::jsonb))
        order by c.name)
      from public.members m join public.churches c on c.id = m.church_id
      where m.user_id = v_user), '[]'::jsonb),
    'notificacoes', coalesce((
      select jsonb_agg(jsonb_build_object('igreja', c.name, 'tipo', n.kind, 'titulo', n.title, 'texto', n.body,
                                          'criada_em', n.created_at, 'lida_em', n.read_at) order by n.created_at desc)
      from public.notifications n join public.churches c on c.id = n.church_id
      where n.user_id = v_user), '[]'::jsonb),
    'aparelhos_com_notificacao', coalesce((
      select jsonb_agg(jsonb_build_object('servico', split_part(split_part(ps.endpoint, '://', 2), '/', 1), 'ativado_em', ps.created_at))
      from public.push_subscriptions ps where ps.user_id = v_user), '[]'::jsonb),
    'publicado_por_voce', jsonb_build_object(
      'eventos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', e.title, 'inicio', e.starts_at, 'criado_em', e.created_at))
        from public.events e join public.churches c on c.id = e.church_id where e.created_by = v_user), '[]'::jsonb),
      'avisos', coalesce((
        select jsonb_agg(jsonb_build_object('igreja', c.name, 'titulo', a.title, 'criado_em', a.created_at))
        from public.announcements a join public.churches c on c.id = a.church_id where a.created_by = v_user), '[]'::jsonb),
      'cadastros_feitos', (select count(*) from public.members x where x.created_by = v_user))
  );
end $$;

-- Sair de uma igreja: apaga o próprio cadastro nela (e as notificações dela).
create or replace function public.leave_church(p_church uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  perform public.assert_not_last_admin(auth.uid(), p_church);
  delete from public.notifications where user_id = auth.uid() and church_id = p_church;
  delete from public.members where user_id = auth.uid() and church_id = p_church;
end $$;

-- Excluir a conta: cadastros em todas as igrejas, aparelhos, notificações e o login.
-- Eventos e avisos publicados pela pessoa continuam na igreja, sem o autor.
create or replace function public.delete_my_account()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'Entre na sua conta.' using errcode = '42501';
  end if;
  perform public.assert_not_last_admin(auth.uid());
  delete from public.members where user_id = auth.uid();
  delete from auth.users where id = auth.uid();
end $$;

revoke execute on function public.export_my_data() from public, anon;
revoke execute on function public.leave_church(uuid) from public, anon;
revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.leave_church(uuid) to authenticated;
grant execute on function public.delete_my_account() to authenticated;
