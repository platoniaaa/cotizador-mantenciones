-- =============================================================
--  Consultas que la página pública SÍ puede hacer
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_agenda_publica.sql
--
--  El agendamiento público corre con la llave anónima, que por RLS no lee
--  `clientes` ni `vehiculos`. Está bien que así sea: si un desconocido pudiera
--  escribir un RUT cualquiera y recibir el nombre, el teléfono y el correo de
--  esa persona, tendríamos un buscador de datos personales abierto a internet.
--
--  Pero el flujo necesita dos cosas puntuales, y ninguna expone a una persona:
--
--   1) La marca y el modelo de una patente. Es lo que cualquiera ve mirando el
--      auto estacionado. NO devuelve dueño, RUT, teléfono, correo ni VIN.
--
--   2) Si el kilometraje que declara el cliente es coherente con el último que
--      registramos. La función responde SÍ o NO; nunca entrega el kilometraje
--      guardado, porque eso sí es información del negocio.
--
--  Ambas son SECURITY DEFINER con la lista de columnas cerrada a mano. Un
--  `select *` acá sería exactamente el agujero que se está evitando.
-- =============================================================

-- ---------------------------------------------------------------
-- 1 · marca y modelo de una patente
-- ---------------------------------------------------------------
drop function if exists public.agenda_vehiculo(text);

create or replace function public.agenda_vehiculo(p_patente text)
returns table (modelo text, anio text)
language sql
security definer
set search_path = public
as $$
  select v.modelo, v.anio
  from public.vehiculos v
  where upper(regexp_replace(v.patente, '[^A-Za-z0-9]', '', 'g'))
      = upper(regexp_replace(coalesce(p_patente, ''), '[^A-Za-z0-9]', '', 'g'))
  limit 1;
$$;

comment on function public.agenda_vehiculo(text) is
  'Marca/modelo y año de una patente, para el agendamiento público. Devuelve SOLO esas dos columnas: nada del dueño.';

revoke all on function public.agenda_vehiculo(text) from public;
grant execute on function public.agenda_vehiculo(text) to anon, authenticated;

-- ---------------------------------------------------------------
-- 2 · ¿el kilometraje declarado es coherente?
-- ---------------------------------------------------------------
drop function if exists public.agenda_km_valido(text, integer);

create or replace function public.agenda_km_valido(p_patente text, p_km integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  ultimo integer;
begin
  if p_km is null then return null; end if;

  select v.km::integer into ultimo
  from public.vehiculos v
  where upper(regexp_replace(v.patente, '[^A-Za-z0-9]', '', 'g'))
      = upper(regexp_replace(coalesce(p_patente, ''), '[^A-Za-z0-9]', '', 'g'))
  limit 1;

  -- Sin registro previo no hay con qué comparar: se acepta.
  if ultimo is null or ultimo <= 0 then return true; end if;

  -- Un auto no retrocede. Se deja un margen de 1.000 km porque el odómetro se
  -- anota a ojo y a veces se registra redondeado hacia arriba; sin ese margen,
  -- el cliente honesto que declara 49.500 sobre un registro de 50.000 quedaría
  -- bloqueado sin entender por qué.
  return p_km >= (ultimo - 1000);
end;
$$;

comment on function public.agenda_km_valido(text, integer) is
  'Responde si el kilometraje declarado al agendar es coherente con el último registrado. Devuelve solo verdadero/falso: nunca el kilometraje guardado.';

revoke all on function public.agenda_km_valido(text, integer) from public;
grant execute on function public.agenda_km_valido(text, integer) to anon, authenticated;
