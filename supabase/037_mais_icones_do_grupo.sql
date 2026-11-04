-- =====================================================================
-- CC4 — mais ícones para o atalho do grupo do chat no Início
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 036). Pode rodar de novo.
--
-- Novos: temas (paleta), integração (quebra-cabeça), achados e perdidos (caixa),
-- lanche coletivo (maçã), encerramento (capelo) e plastificadora.

alter table public.chat_groups drop constraint if exists chat_groups_home_icon_ok;
alter table public.chat_groups add constraint chat_groups_home_icon_ok check (
  home_icon is null or home_icon in (
    'chat', 'users', 'megaphone', 'bell', 'calendar', 'clipboard', 'book', 'project',
    'child', 'heart', 'cake', 'image', 'camera', 'chart', 'pin', 'sun',
    'palette', 'puzzle', 'box', 'apple', 'graduation', 'laminator'
  )
);
