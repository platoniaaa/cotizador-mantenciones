-- =============================================================
-- QUIÉN ES PERSONAL DE CURIFOR — un solo lugar
--
-- La barrera real de acceso a toda la plataforma es el dominio del correo del
-- token. Estaba escrita a mano en 17 policies y dentro de una función: en cada
-- tabla, en cada operación y en el bucket de Storage. Agregar un dominio
-- significaba tocar 18 sitios y rezar por no olvidar ninguno — y olvidar uno
-- no rompe nada visible: simplemente deja a alguien sin poder leer una tabla,
-- que es el peor tipo de error, porque parece un problema de datos.
--
-- Ahora la regla vive en es_personal_curifor() y todo la consulta.
--
-- MOTIVO DEL CAMBIO (06-ago-2026): un asesor de Curicó tiene su cuenta en
-- `@curifor.onmicrosoft.com`, el dominio por defecto del tenant de Microsoft
-- de Curifor. No podía ni crear cuenta. Ese dominio es de Curifor y nadie
-- externo puede obtener una dirección ahí, así que aceptarlo no abre la puerta
-- a terceros.
--
-- OJO al escribir la regla: el `@` es imprescindible. '%curifor.com' (sin @)
-- aceptaría 'atacante@nocurifor.com'.
--
-- ADITIVO e idempotente.
-- =============================================================

create or replace function public.es_personal_curifor()
returns boolean
language sql
stable
as $$
  select coalesce(
       lower(auth.jwt() ->> 'email') like '%@curifor.com'
    or lower(auth.jwt() ->> 'email') like '%@curifor.onmicrosoft.com',
    false)
$$;

comment on function public.es_personal_curifor() is
  'Única definición de "es personal de Curifor". La usan todas las policies y siguiente_correlativo(). Para sumar un dominio, se cambia solo acá.';

grant execute on function public.es_personal_curifor() to authenticated, anon;

-- ---------------------------------------------------------------
-- Policies reescritas. Se conservan tal cual las demás condiciones
-- (en Storage, el bucket): lo único que cambia es cómo se decide
-- si quien pregunta es de Curifor.
-- ---------------------------------------------------------------

-- clientes / vehiculos (datos personales de clientes: solo lectura del staff)
drop policy if exists clientes_sel on public.clientes;
create policy clientes_sel on public.clientes
  for select to authenticated using ( public.es_personal_curifor() );

drop policy if exists vehiculos_sel on public.vehiculos;
create policy vehiculos_sel on public.vehiculos
  for select to authenticated using ( public.es_personal_curifor() );

-- personal (la nómina)
drop policy if exists personal_select_staff on public.personal;
create policy personal_select_staff on public.personal
  for select to authenticated using ( public.es_personal_curifor() );

-- reservas_web (la cita). La policy de INSERT del público NO se toca: esa no
-- mira el dominio, mira que la fecha sea razonable y que venga un teléfono.
drop policy if exists reservas_web_select_staff on public.reservas_web;
create policy reservas_web_select_staff on public.reservas_web
  for select to authenticated using ( public.es_personal_curifor() );

drop policy if exists reservas_web_insert_staff on public.reservas_web;
create policy reservas_web_insert_staff on public.reservas_web
  for insert to authenticated with check ( public.es_personal_curifor() );

drop policy if exists reservas_web_update_staff on public.reservas_web;
create policy reservas_web_update_staff on public.reservas_web
  for update to authenticated
  using ( public.es_personal_curifor() ) with check ( public.es_personal_curifor() );

drop policy if exists reservas_web_delete_staff on public.reservas_web;
create policy reservas_web_delete_staff on public.reservas_web
  for delete to authenticated using ( public.es_personal_curifor() );

-- taller_estado (la bandeja por sucursal)
drop policy if exists taller_estado_select_staff on public.taller_estado;
create policy taller_estado_select_staff on public.taller_estado
  for select to authenticated using ( public.es_personal_curifor() );

drop policy if exists taller_estado_insert_staff on public.taller_estado;
create policy taller_estado_insert_staff on public.taller_estado
  for insert to authenticated with check ( public.es_personal_curifor() );

drop policy if exists taller_estado_update_staff on public.taller_estado;
create policy taller_estado_update_staff on public.taller_estado
  for update to authenticated
  using ( public.es_personal_curifor() ) with check ( public.es_personal_curifor() );

-- taller_archivo (la historia)
drop policy if exists taller_archivo_select_staff on public.taller_archivo;
create policy taller_archivo_select_staff on public.taller_archivo
  for select to authenticated using ( public.es_personal_curifor() );

drop policy if exists taller_archivo_insert_staff on public.taller_archivo;
create policy taller_archivo_insert_staff on public.taller_archivo
  for insert to authenticated with check ( public.es_personal_curifor() );

drop policy if exists taller_archivo_update_staff on public.taller_archivo;
create policy taller_archivo_update_staff on public.taller_archivo
  for update to authenticated
  using ( public.es_personal_curifor() ) with check ( public.es_personal_curifor() );

-- Storage: fotos y firmas del acta. Se mantiene el filtro por bucket.
drop policy if exists recep_select_staff on storage.objects;
create policy recep_select_staff on storage.objects
  for select to authenticated
  using ( bucket_id = 'recepciones' and public.es_personal_curifor() );

drop policy if exists recep_insert_staff on storage.objects;
create policy recep_insert_staff on storage.objects
  for insert to authenticated
  with check ( bucket_id = 'recepciones' and public.es_personal_curifor() );

drop policy if exists recep_update_staff on storage.objects;
create policy recep_update_staff on storage.objects
  for update to authenticated
  using ( bucket_id = 'recepciones' and public.es_personal_curifor() );

drop policy if exists recep_delete_staff on storage.objects;
create policy recep_delete_staff on storage.objects
  for delete to authenticated
  using ( bucket_id = 'recepciones' and public.es_personal_curifor() );

-- ---------------------------------------------------------------
-- El correlativo de OC/RO también validaba el dominio a mano.
-- Se conserva el resto del cuerpo exactamente igual.
-- ---------------------------------------------------------------
create or replace function public.siguiente_correlativo(p_sucursal text, p_tipo text, p_minimo bigint default 0)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_num bigint;
begin
  if not public.es_personal_curifor() then
    raise exception 'no autorizado';
  end if;
  if p_tipo not in ('oc', 'ro') then
    raise exception 'tipo invalido: %', p_tipo;
  end if;

  insert into public.correlativos as c (sucursal, tipo, valor)
       values (p_sucursal, p_tipo, greatest(p_minimo, 1) + 1)
  on conflict (sucursal, tipo)
    do update set valor = greatest(c.valor, p_minimo) + 1
  returning c.valor - 1 into v_num;

  return v_num;
end $$;
