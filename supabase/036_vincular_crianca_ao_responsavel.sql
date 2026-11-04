-- =====================================================================
-- CC4 — a liderança vincula a criança ao pai ou à mãe do cadastro
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 035). Pode rodar de novo.
--
-- - A liderança (administrador, secretaria, líder) já cadastra a criança; agora também troca
--   o responsável de uma criança já cadastrada: escolhe o pai ou a mãe do cadastro (que passa a
--   ver a criança em "Meus filhos") ou volta a um responsável sem o app (nome e WhatsApp)
-- - Só a liderança troca o responsável; o próprio responsável não passa a criança para outra pessoa
-- - O responsável continua precisando ser do cadastro da mesma instituição de ensino

grant update (guardian_member_id) on public.children to authenticated;

create or replace function public.children_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.guardian_member_id is not null
     and not exists (select 1 from public.members m where m.id = new.guardian_member_id and m.church_id = new.church_id) then
    raise exception 'O responsável precisa ser do cadastro da mesma instituição de ensino.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.church_id <> old.church_id then
    raise exception 'A criança não muda de instituição de ensino.' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.guardian_member_id is distinct from old.guardian_member_id
     and not coalesce(public.is_leader(new.church_id), false) then
    raise exception 'Só a liderança troca o responsável da criança.' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.children_guard() from public, anon, authenticated;
