-- =====================================================================
-- CC4 — fundo do app no tema escuro: preto ou a cor principal
-- Rode depois dos arquivos anteriores, no SQL Editor do Supabase.
--
-- O administrador escolhe, em Configurar a igreja > Aparência, se no tema
-- escuro o fundo do app fica preto (padrão, como já era) ou na cor principal
-- da igreja.
-- =====================================================================

alter table public.churches add column if not exists dark_theme text not null default 'preto'
  check (dark_theme in ('preto', 'principal'));
grant update (dark_theme) on public.churches to authenticated;

