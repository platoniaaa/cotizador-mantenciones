-- =============================================================
-- STORAGE de la inspección fotográfica de RECEPCIÓN
-- Bucket privado 'recepciones' + RLS: solo el personal @curifor.com sube y ve
-- las fotos (nunca el público). Las fotos cuelgan por carpeta del vehículo.
-- Ejecutar una vez (idempotente).
-- =============================================================

-- 1) bucket privado, límite 10 MB, solo imágenes
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recepciones', 'recepciones', false, 10485760,
        array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2) RLS en storage.objects, acotado al bucket 'recepciones' y dominio @curifor.com
drop policy if exists recep_insert_staff on storage.objects;
create policy recep_insert_staff on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'recepciones' and lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists recep_select_staff on storage.objects;
create policy recep_select_staff on storage.objects
  for select to authenticated
  using ( bucket_id = 'recepciones' and lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists recep_update_staff on storage.objects;
create policy recep_update_staff on storage.objects
  for update to authenticated
  using ( bucket_id = 'recepciones' and lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists recep_delete_staff on storage.objects;
create policy recep_delete_staff on storage.objects
  for delete to authenticated
  using ( bucket_id = 'recepciones' and lower(auth.jwt() ->> 'email') like '%@curifor.com' );

-- 3) referencia de las fotos en la reserva/recepción (paths dentro del bucket)
alter table public.reservas_web add column if not exists fotos jsonb default '[]'::jsonb;
