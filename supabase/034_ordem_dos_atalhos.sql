-- =====================================================================
-- CC4 — ordem dos atalhos do Início
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 033). Pode rodar de novo.
--
-- - O administrador organiza os atalhos do Início arrastando; a ordem vale para todos
-- - Guarda só os nomes dos atalhos ('agenda', 'avisos'…) e os grupos do chat ('chat:<id>');
--   quem não tem um atalho (função desligada, não está no grupo) simplesmente não o vê
-- - Atalho que não está na lista vai para o fim (ex.: uma função ligada depois)
-- - Quem grava é o administrador (a regra "churches admin edita" do 001 já cuida disso)

alter table public.churches add column if not exists home_order text[];

alter table public.churches drop constraint if exists churches_home_order_ok;
alter table public.churches add constraint churches_home_order_ok check (
  home_order is null
  or cardinality(home_order) = 0
  or (cardinality(home_order) <= 60
      and array_to_string(home_order, ',') ~ '^((chat:[0-9a-f-]{36}|[a-z_]{1,30})(,|$))+$')
);

grant update (home_order) on public.churches to authenticated;
