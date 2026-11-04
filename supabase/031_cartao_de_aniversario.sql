-- =====================================================================
-- CC4 — cartão de aniversário: o título e a mensagem escritos dentro da imagem
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 030). Pode rodar de novo.
-- (Da skill mensagem-aniversario; veio do Igreja Conecta.)
--
-- - Na tela da mensagem, o administrador liga "escrever dentro da imagem", arrasta o texto e
--   escolhe tamanho, largura, letra e cor (js/cartao.js desenha a prévia e o cartão enviado)
-- - O envio das 7h gera o cartão de cada pessoa (com o nome dela) e manda no push, no e-mail e
--   na central do app. Quem guarda o arquivo é a função guardar-cartao (chave de serviço só
--   lá dentro), na pasta igrejas/cartoes/<instituição>/ (os com mais de 40 dias saem)
-- - Rodar o envio de novo no mesmo dia reaproveita o cartão (celebration_cards)

-- ---------------------------------------------------------------------
-- 1. Opções do cartão no modelo da mensagem
--    Posição em % da imagem: x, y = centro da área do texto; width = largura da área; size = 100 normal.
-- ---------------------------------------------------------------------
alter table public.message_templates
  add column if not exists card            boolean  not null default false,
  add column if not exists card_x          smallint not null default 50,
  add column if not exists card_y          smallint not null default 50,
  add column if not exists card_width      smallint not null default 84,
  add column if not exists card_size       smallint not null default 100,
  add column if not exists card_font       text     not null default 'padrao',
  add column if not exists card_text_color text     not null default '#ffffff';

alter table public.message_templates drop constraint if exists message_templates_card_place;
alter table public.message_templates add constraint message_templates_card_place check (
  card_x between 0 and 100 and card_y between 0 and 100
  and card_width between 30 and 100 and card_size between 40 and 250
);
-- As mesmas chaves de CARD_FONTS em js/cartao.js.
alter table public.message_templates drop constraint if exists message_templates_card_font;
alter table public.message_templates add constraint message_templates_card_font check (
  card_font in ('padrao', 'montserrat', 'lora', 'playfair', 'dancing', 'caveat', 'greatvibes', 'pacifico')
);
alter table public.message_templates drop constraint if exists message_templates_card_text_color;
alter table public.message_templates add constraint message_templates_card_text_color check (card_text_color ~ '^#[0-9a-f]{6}$');

-- O administrador muda também as opções do cartão (as regras de quem muda continuam as do 004).
grant update (card, card_x, card_y, card_width, card_size, card_font, card_text_color) on public.message_templates to authenticated;

-- ---------------------------------------------------------------------
-- 2. Central do app: a notificação do aniversário mostra o cartão
-- ---------------------------------------------------------------------
alter table public.notifications add column if not exists image_url text;
alter table public.notifications drop constraint if exists notifications_image_https;
alter table public.notifications add constraint notifications_image_https
  check (image_url is null or (char_length(image_url) <= 500 and image_url ~* '^https://'));

-- ---------------------------------------------------------------------
-- 3. Cartões gerados (um por pessoa, tipo e dia). Ninguém do app lê esta tabela.
-- ---------------------------------------------------------------------
create table if not exists public.celebration_cards (
  member_id   uuid not null references public.members on delete cascade,
  kind        text not null,
  target_date date not null,
  url         text not null check (char_length(url) <= 500 and url ~* '^https://'),
  created_at  timestamptz not null default now(),
  primary key (member_id, kind, target_date)
);
alter table public.celebration_cards enable row level security;
revoke all on public.celebration_cards from public, anon, authenticated;

-- Cartões a fazer: os de hoje (com o já gerado, se houver) e os já gerados dos 2 dias anteriores
-- (o e-mail que ficou para depois pelo limite diário usa o mesmo cartão).
create or replace function public.claim_celebration_cards(p_secret text)
returns table (member_id uuid, kind text, target_date date, church_id uuid, church_slug text, church_name text,
               name text, years integer, title text, body text, image_url text,
               card_font text, card_text_color text, card_x smallint, card_y smallint, card_width smallint, card_size smallint,
               card_url text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_today date := public.today_br();
begin
  perform public.envio_check_secret(p_secret);
  return query
  select c.member_id, c.kind, d::date, c.church_id, c.church_slug, c.church_name, c.name, c.years,
         c.title, c.body, c.image_url,
         t.card_font, t.card_text_color, t.card_x, t.card_y, t.card_width, t.card_size, cc.url
  from generate_series(v_today - 2, v_today, interval '1 day') as d
  cross join lateral public.celebration_candidates(d::date) c
  join public.message_templates t on t.church_id = c.church_id and t.kind = c.kind
  left join public.celebration_cards cc on cc.member_id = c.member_id and cc.kind = c.kind and cc.target_date = d::date
  where t.card and c.image_url is not null
    and (c.send_push or c.send_email)
    and (d::date = v_today or cc.url is not null);
end $$;

-- Guarda o cartão e põe na notificação do dia (central do app). Só aceita endereço da pasta de
-- cartões deste projeto (a função guardar-cartao sorteia o nome do arquivo).
create or replace function public.save_celebration_card(p_secret text, p_member uuid, p_kind text, p_date date, p_url text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  m public.members;
begin
  perform public.envio_check_secret(p_secret);
  if p_url !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/igrejas/cartoes/[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$' then
    raise exception 'Endereço de cartão inválido.';
  end if;
  select * into m from public.members where id = p_member;
  if m.id is null or position(m.church_id::text in p_url) = 0 then
    raise exception 'Endereço de cartão inválido.';
  end if;
  insert into public.celebration_cards (member_id, kind, target_date, url)
  values (p_member, p_kind, p_date, p_url)
  on conflict (member_id, kind, target_date) do update set url = excluded.url;
  -- A mesma chave de deliver_birthday_notifications (008).
  if m.user_id is not null then
    update public.notifications set image_url = p_url
    where user_id = m.user_id and dedupe_key = p_kind || ':' || m.church_id || ':' || p_date;
  end if;
  delete from public.celebration_cards where target_date < public.today_br() - 40;
end $$;

-- O envio entra sem login (chave pública) e prova quem é com a senha.
revoke execute on function public.claim_celebration_cards(text) from public, authenticated;
revoke execute on function public.save_celebration_card(text, uuid, text, date, text) from public, authenticated;
grant execute on function public.claim_celebration_cards(text) to anon;
grant execute on function public.save_celebration_card(text, uuid, text, date, text) to anon;

notify pgrst, 'reload schema';
