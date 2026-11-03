-- =====================================================================
-- CC4 — trocar o projeto de sala
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 023). Pode rodar de novo.
--
-- - Ao editar o projeto, quem cuida dele pode trocar a sala
-- - Só para uma sala da mesma instituição de ensino que a pessoa também cuida
--   (a liderança: qualquer sala; o tutor: só as dele). A regra "projetos edita" do 021
--   já confere a sala antiga (using) e a nova (with check).
-- - Depois da troca, só quem é da sala nova vê o projeto (etapas, arquivos e comentários juntos)
-- - Os pais da sala nova recebem o aviso de projeto novo

-- O projeto continua na instituição da sala; agora pode mudar de sala dentro dela.
create or replace function public.room_projects_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.church_id is distinct from old.church_id then
      raise exception 'O projeto não muda de instituição.' using errcode = '42501';
    end if;
    if new.room_id is distinct from old.room_id
       and not exists (select 1 from public.kids_rooms r where r.id = new.room_id and r.church_id = old.church_id) then
      raise exception 'A sala precisa ser da mesma instituição.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'INSERT' then
    new.church_id := (select r.church_id from public.kids_rooms r where r.id = new.room_id);
  end if;
  new.updated_at := now();
  return new;
end $$;
revoke execute on function public.room_projects_guard() from public, anon, authenticated;

grant update (room_id) on public.room_projects to authenticated;

-- Projeto novo na sala (criado ou trazido de outra sala): avisa os pais dela.
drop trigger if exists room_projects_notify_move on public.room_projects;
create trigger room_projects_notify_move after update of room_id on public.room_projects
  for each row when (new.room_id is distinct from old.room_id)
  execute function public.room_projects_notify();
