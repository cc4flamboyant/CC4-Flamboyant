-- =====================================================================
-- CC4 — volta as igrejas Teste A e Teste B ao que os testes esperam
-- Rode no SQL Editor do Supabase quando os testes avisarem que as igrejas
-- de teste "não estão como os testes esperam". Pode rodar quantas vezes quiser.
--
-- - Tira das igrejas de TESTE os cadastros que não são das contas de teste
--   (o seu cadastro na Vineyard e nas igrejas de verdade não muda)
-- - Recria os cadastros das contas de teste que tiverem sumido
-- - Devolve os nomes, os papéis e a ligação com as contas de teste
-- Para experimentar o app, use a Vineyard, não as igrejas de teste.
-- =====================================================================

delete from public.members m
using public.churches c
where m.church_id = c.id
  and c.is_test
  and coalesce(m.email, '') not like '%@teste.igrejaconecta.invalid'
  and m.name not in ('Fulano da A', 'Fulano da B', 'Bissexto da A', 'Casada da A', 'Batizado da A');

-- Recria os cadastros sem conta que os testes usam (se tiverem sumido).
insert into public.members (church_id, role, name, phone, birth_date, show_birthday, wedding_date, show_wedding, baptism_date, show_baptism)
select c.id, 'membro', v.name, v.phone, v.birth_date::date, v.show_birthday, v.wedding_date::date, v.show_wedding, v.baptism_date::date, v.show_baptism
from (values
  ('teste-a', 'Fulano da A',   '5561999990001', '1980-03-15', false, null,         false, null,         false),
  ('teste-b', 'Fulano da B',   '5561999990002', '1975-07-20', false, null,         false, null,         false),
  ('teste-a', 'Bissexto da A', null,            '2000-02-29', true,  null,         false, null,         false),
  ('teste-a', 'Casada da A',   null,            null,         false, '2010-06-12', true,  null,         false),
  ('teste-a', 'Batizado da A', null,            null,         false, null,         false, '2020-06-20', false)
) as v(slug, name, phone, birth_date, show_birthday, wedding_date, show_wedding, baptism_date, show_baptism)
join public.churches c on c.slug = v.slug
where not exists (select 1 from public.members m where m.church_id = c.id and m.name = v.name);

with v(slug, email, role, name) as (values
  ('teste-a', 'adm-a@teste.igrejaconecta.invalid', 'admin', 'Admin da A'),
  ('teste-a', 'lider-a@teste.igrejaconecta.invalid', 'lider', 'Líder da A'),
  ('teste-a', 'membro-a@teste.igrejaconecta.invalid', 'membro', 'Membro da A'),
  ('teste-b', 'adm-b@teste.igrejaconecta.invalid', 'admin', 'Admin da B')
),
recriados as (
  insert into public.members (church_id, role, name, email)
  select c.id, v.role, v.name, v.email
  from v join public.churches c on c.slug = v.slug
  where not exists (select 1 from public.members m where m.church_id = c.id and lower(m.email) = v.email)
  returning id
)
update public.members m
set role = v.role, name = v.name, status = 'ativo'
from v
where lower(m.email) = v.email;

-- Liga as contas de teste aos cadastros, já com o convite aceito.
update public.members m
set user_id = u.id, consent_at = coalesce(m.consent_at, now())
from auth.users u
where lower(m.email) = u.email
  and u.email like '%@teste.igrejaconecta.invalid'
  and m.church_id in (select id from public.churches where is_test)
  and m.user_id is distinct from u.id;

-- Confira: devem aparecer as 4 contas de teste (Admin da A, Líder da A,
-- Membro da A, Admin da B) e os cadastros sem conta (Fulanos, Bissexto,
-- Casada e Batizado da A).
select c.slug, m.name, m.role, m.email, m.user_id is not null as tem_conta
from public.members m join public.churches c on c.id = m.church_id
where c.is_test
order by c.slug, m.name;
