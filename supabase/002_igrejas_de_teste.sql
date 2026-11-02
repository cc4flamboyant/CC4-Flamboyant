-- =====================================================================
-- CC4 — igrejas de teste (Teste A e Teste B)
-- Rode depois do 001, no SQL Editor do Supabase.
--
-- Os testes automáticos entram com contas de teste nestas duas igrejas e
-- conferem que uma não lê nem altera nada da outra. Elas não ganham
-- página própria na publicação do site.
-- As contas de teste (com senha) são criadas por um arquivo que fica só
-- no seu computador: supabase/usuarios-de-teste.local.sql
-- =====================================================================

alter table public.churches add column if not exists is_test boolean not null default false;

insert into public.churches (slug, name, short_name, primary_color, is_test, welcome_text)
values
  ('teste-a', 'Igreja Teste A', 'Teste A', '#2b8a3e', true, 'Igreja usada pelos testes automáticos.'),
  ('teste-b', 'Igreja Teste B', 'Teste B', '#c2255c', true, 'Igreja usada pelos testes automáticos.')
on conflict (slug) do update set is_test = true;

-- Cadastros. Os que têm e-mail são ligados às contas de teste pelo arquivo local.
-- Os "Fulanos" não têm conta: são os dados que a outra igreja tenta ler.
insert into public.members (church_id, role, name, email, phone, birth_date)
select c.id, v.role, v.name, v.email, v.phone, v.birth_date::date
from (values
  ('teste-a', 'admin',  'Admin da A',  'adm-a@teste.igrejaconecta.invalid',    null,            null),
  ('teste-a', 'lider',  'Líder da A',  'lider-a@teste.igrejaconecta.invalid',  null,            null),
  ('teste-a', 'membro', 'Membro da A', 'membro-a@teste.igrejaconecta.invalid', null,            null),
  ('teste-a', 'membro', 'Fulano da A', null,                                   '5561999990001', '1980-03-15'),
  ('teste-b', 'admin',  'Admin da B',  'adm-b@teste.igrejaconecta.invalid',    null,            null),
  ('teste-b', 'membro', 'Fulano da B', null,                                   '5561999990002', '1975-07-20')
) as v(slug, role, name, email, phone, birth_date)
join public.churches c on c.slug = v.slug
where not exists (select 1 from public.members m where m.church_id = c.id and m.name = v.name);
