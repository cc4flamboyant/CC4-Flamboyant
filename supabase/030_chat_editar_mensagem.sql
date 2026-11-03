-- =====================================================================
-- CC4 — chat: editar a própria mensagem
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 029). Pode rodar de novo.
--
-- - Só quem escreveu edita o texto da mensagem (ou a legenda da foto/arquivo)
-- - A mensagem mostra "editada" (edited_at) e muda na hora para quem está na conversa
-- - Mensagem só de arquivo pode ganhar uma legenda; texto vazio, só se tiver arquivo

alter table public.chat_messages add column if not exists edited_at timestamptz;

create or replace function public.chat_edit_message(p_message uuid, p_body text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  x public.chat_messages;
  s public.chat_members;
  v_body text := nullif(trim(p_body), '');
  v_now timestamptz := now();
begin
  select * into x from public.chat_messages where id = p_message;
  if x.id is not null then
    s := public.chat_my_seat(x.group_id);
  end if;
  if x.id is null or s.group_id is null or x.author_id is distinct from s.member_id then
    raise exception 'Só quem escreveu edita a mensagem.' using errcode = '42501';
  end if;
  if v_body is null and x.file_path is null then
    raise exception 'Escreva a mensagem.';
  end if;
  if char_length(v_body) > 4000 then
    raise exception 'A mensagem passou de 4.000 letras.';
  end if;
  if v_body is not distinct from x.body then
    return x.edited_at;
  end if;
  update public.chat_messages set body = v_body, edited_at = v_now where id = p_message;
  return v_now;
end $$;
revoke execute on function public.chat_edit_message(uuid, text) from public, anon;
grant execute on function public.chat_edit_message(uuid, text) to authenticated;

notify pgrst, 'reload schema';
