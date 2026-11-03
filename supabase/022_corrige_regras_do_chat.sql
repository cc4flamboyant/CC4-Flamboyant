-- =====================================================================
-- CC4 — correção das regras dos arquivos do chat
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 021). Pode rodar de novo.
-- Nas regras abaixo, "name" dentro da consulta dos grupos era lido como o nome do grupo,
-- não o nome do arquivo: o ícone do grupo não subia, e o administrador do grupo não
-- conseguia apagar os anexos dos outros. Agora o nome do arquivo vem de objects.name.

drop policy if exists "chat apaga" on storage.objects;
create policy "chat apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'chat'
         and (exists (select 1 from public.chat_messages x
                      where x.file_path = name and x.author_id = public.my_member_id(x.church_id))
              or exists (select 1 from public.chat_groups g
                         where g.id::text = (storage.foldername(objects.name))[2]
                           and g.church_id::text = (storage.foldername(objects.name))[1]
                           and public.chat_is_admin(g.id))));

drop policy if exists "chat icone envia" on storage.objects;
create policy "chat icone envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'chat'
              and exists (select 1 from public.chat_groups g
                          where g.id::text = (storage.foldername(objects.name))[2]
                            and public.chat_icon_ok(g.id, objects.name) and public.chat_is_admin(g.id)));

drop policy if exists "chat icone ve" on storage.objects;
create policy "chat icone ve" on storage.objects for select to authenticated
  using (bucket_id = 'chat'
         and exists (select 1 from public.chat_groups g
                     where g.id::text = (storage.foldername(objects.name))[2]
                       and public.chat_icon_ok(g.id, objects.name) and public.chat_is_in(g.id)));
