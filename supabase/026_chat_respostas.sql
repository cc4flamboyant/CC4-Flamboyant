-- =====================================================================
-- CC4 — chat: responder citando uma mensagem (como no WhatsApp)
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 025). Pode rodar de novo.
--
-- - A mensagem pode ser resposta a outra do mesmo grupo (ex.: escrever sobre o vídeo
--   em tela cheia): aparece com a original citada em cima
-- - Se a original for apagada, a resposta fica, sem a citação
-- - chat_send ganha o parâmetro p_reply_to (opcional); o resto continua igual

alter table public.chat_messages
  add column if not exists reply_to uuid references public.chat_messages on delete set null;
create index if not exists chat_messages_reply_idx on public.chat_messages (reply_to) where reply_to is not null;

-- A versão antiga (sem p_reply_to) sai: com as duas, a chamada ficaria ambígua.
drop function if exists public.chat_send(uuid, text, text, text, bigint, text);
create or replace function public.chat_send(p_group uuid, p_body text, p_file_name text default null,
                                            p_file_type text default null, p_file_size bigint default null, p_ext text default null,
                                            p_reply_to uuid default null)
returns table (id uuid, file_path text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  g public.chat_groups;
  s public.chat_members;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_body text := nullif(trim(p_body), '');
  v_now timestamptz := now();
begin
  select * into g from public.chat_groups x where x.id = p_group;
  s := public.chat_my_seat(p_group);
  if g.id is null or s.group_id is null then
    raise exception 'Você não está neste grupo.' using errcode = '42501';
  end if;
  if g.locked and not coalesce(public.chat_is_admin(p_group), false) then
    raise exception 'Só os administradores do grupo enviam mensagens.' using errcode = '42501';
  end if;
  if v_body is null and p_file_name is null then
    raise exception 'Escreva a mensagem ou escolha um arquivo.';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'A mensagem passou de 4.000 letras.';
  end if;
  -- Só responde a uma mensagem do mesmo grupo.
  if p_reply_to is not null and not exists (select 1 from public.chat_messages x where x.id = p_reply_to and x.group_id = g.id) then
    raise exception 'A mensagem respondida não está neste grupo.' using errcode = '42501';
  end if;
  -- Contra abuso: até 30 mensagens por minuto por pessoa.
  if (select count(*) from public.chat_messages x where x.author_id = s.member_id and x.created_at > v_now - interval '1 minute') >= 30 then
    raise exception 'Muitas mensagens em pouco tempo. Espere um pouco.';
  end if;
  if p_file_name is not null then
    if coalesce(p_file_size, 0) <= 0 or p_file_size > public.chat_file_limit() then
      raise exception 'O arquivo passa de 25 MB. Para vídeos maiores, mande o link (YouTube, Google Drive).';
    end if;
    perform pg_advisory_xact_lock(hashtext('chat:' || g.church_id::text));
    if coalesce((select sum(x.file_size) from public.chat_messages x where x.church_id = g.church_id and x.file_path is not null), 0)
       + p_file_size > public.chat_storage_limit() then
      raise exception 'O espaço dos anexos do chat acabou (500 MB). Peça para a direção apagar conversas ou arquivos antigos.';
    end if;
    v_path := g.church_id || '/' || g.id || '/' || v_id || '.' ||
              case when p_ext ~ '^[a-z0-9]{1,8}$' then p_ext else 'bin' end;
  end if;
  insert into public.chat_messages (id, group_id, church_id, author_id, body, file_path, file_name, file_type, file_size, push_pending, created_at, reply_to)
  values (v_id, g.id, g.church_id, s.member_id, v_body, v_path, left(trim(p_file_name), 200), left(p_file_type, 100), p_file_size,
          v_path is null, v_now, p_reply_to);
  update public.chat_groups x set last_message_at = v_now where x.id = g.id;
  update public.chat_members x set last_read_at = v_now where x.group_id = g.id and x.member_id = s.member_id;
  return query select v_id, v_path, v_now;
end $$;
revoke execute on function public.chat_send(uuid, text, text, text, bigint, text, uuid) from public, anon;
grant execute on function public.chat_send(uuid, text, text, text, bigint, text, uuid) to authenticated;

-- A tela lê o campo novo (a regra "mensagens le" do 020 continua valendo).
notify pgrst, 'reload schema';
