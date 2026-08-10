-- ============================================================
--  El tablero del taller deja de hablar con GitHub desde el navegador.
--
--  QUÉ ARREGLA
--  -----------
--  El tablero va embebido en la app y guardaba solo: hacía PUT a la API de
--  GitHub desde el navegador. Para poder hacerlo, la app le metía un token de
--  GitHub CON PERMISO DE ESCRITURA dentro del HTML que recibe cada uno de los
--  63 usuarios. Cualquiera que abriera las herramientas del navegador podía
--  sacarlo y reescribir el repositorio entero — incluido `usuarios_curifor.json`,
--  o sea darse permisos de administrador.
--
--  Acá se reemplaza por un permiso mínimo: un vale de un solo uso, por usuario,
--  que dura una jornada y que SOLO sirve para leer y escribir los dos
--  documentos del tablero. Si alguien lo saca del navegador, lo peor que puede
--  hacer es tocar el tablero de una sucursal; no puede leer clientes, ni
--  usuarios, ni tocar el resto de la base.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_tablero.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1) Los vales
-- ------------------------------------------------------------
create table if not exists public.taller_vales (
  vale     text primary key,
  usuario  text not null,
  sucursal text not null,
  creado   timestamptz not null default now(),
  expira   timestamptz not null
);

create index if not exists taller_vales_expira_idx on public.taller_vales (expira);

alter table public.taller_vales enable row level security;
-- Sin policies: nadie los lee ni los escribe desde fuera. Los crea la app
-- (que se conecta con la clave de la base) y los valida la función de abajo,
-- que corre con permisos propios.

comment on table public.taller_vales is 'Vales de acceso del tablero embebido. Los emite la app de post venta al pintar el tablero; el navegador los usa para llamar a tablero_leer / tablero_guardar. Reemplazan al token de GitHub que antes viajaba al navegador.';


-- ------------------------------------------------------------
-- 2) Qué documentos puede tocar el tablero. La lista es cerrada
--    a propósito: si mañana alguien agrega un documento acá, que
--    sea una decisión consciente y no un descuido.
-- ------------------------------------------------------------
create or replace function public.tablero_documento_permitido(p_nombre text)
returns boolean language sql immutable as $$
  select p_nombre in ('control_taller.json', 'prepicking_estados.json')
$$;


-- ------------------------------------------------------------
-- 3) Validar un vale. Devuelve el usuario, o null si no sirve.
-- ------------------------------------------------------------
create or replace function public.tablero_usuario_del_vale(p_vale text)
returns text language sql stable security definer set search_path = public as $$
  select usuario from public.taller_vales
   where vale = p_vale and expira > now()
$$;


-- ------------------------------------------------------------
-- 4) Leer un documento del tablero
-- ------------------------------------------------------------
create or replace function public.tablero_leer(p_vale text, p_nombre text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_usuario text;
  v_data    jsonb;
  v_sello   timestamptz;
begin
  if not public.tablero_documento_permitido(p_nombre) then
    return jsonb_build_object('ok', false, 'motivo', 'documento_no_permitido');
  end if;

  v_usuario := public.tablero_usuario_del_vale(p_vale);
  if v_usuario is null then
    return jsonb_build_object('ok', false, 'motivo', 'vale_invalido');
  end if;

  select data, actualizado into v_data, v_sello
    from public.documentos where nombre = p_nombre;

  if v_data is null then
    -- No es lo mismo "no existe" que "no pude leerlo": el tablero se niega a
    -- guardar cuando no pudo leer, justamente para no borrar las otras
    -- sucursales. Se distingue.
    return jsonb_build_object('ok', true, 'existe', false, 'data', '{}'::jsonb, 'sello', null);
  end if;

  return jsonb_build_object('ok', true, 'existe', true, 'data', v_data,
                            'sello', to_char(v_sello, 'YYYY-MM-DD"T"HH24:MI:SS.US+00'));
end $$;


-- ------------------------------------------------------------
-- 5) Guardar un documento del tablero
--
--    `p_sello` es la versión que el navegador creía tener. Si en el
--    intertanto otro guardó, se rechaza y se devuelve el sello nuevo
--    para que reintente sobre lo último — es lo mismo que hacía el
--    `sha` de GitHub, que el tablero ya sabe reintentar.
-- ------------------------------------------------------------
create or replace function public.tablero_guardar(p_vale text, p_nombre text,
                                                  p_data jsonb, p_sello text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_usuario text;
  v_actual  timestamptz;
  v_nuevo   timestamptz;
begin
  if not public.tablero_documento_permitido(p_nombre) then
    return jsonb_build_object('ok', false, 'motivo', 'documento_no_permitido');
  end if;

  v_usuario := public.tablero_usuario_del_vale(p_vale);
  if v_usuario is null then
    return jsonb_build_object('ok', false, 'motivo', 'vale_invalido');
  end if;

  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('ok', false, 'motivo', 'datos_invalidos');
  end if;

  select actualizado into v_actual from public.documentos
   where nombre = p_nombre for update;

  if v_actual is not null and p_sello is distinct from
       to_char(v_actual, 'YYYY-MM-DD"T"HH24:MI:SS.US+00') then
    return jsonb_build_object('ok', false, 'motivo', 'conflicto',
                              'sello', to_char(v_actual, 'YYYY-MM-DD"T"HH24:MI:SS.US+00'));
  end if;

  insert into public.documentos (nombre, data, mensaje)
       values (p_nombre, p_data, 'tablero · ' || v_usuario)
  on conflict (nombre) do update
     set data = excluded.data, actualizado = now(), mensaje = excluded.mensaje
  returning actualizado into v_nuevo;

  return jsonb_build_object('ok', true,
                            'sello', to_char(v_nuevo, 'YYYY-MM-DD"T"HH24:MI:SS.US+00'));
end $$;


-- ------------------------------------------------------------
-- 6) Permisos: el navegador llega con la clave pública `anon`, que
--    por sí sola no abre NADA (todas las tablas tienen RLS). Lo
--    único que puede hacer es llamar a estas dos funciones, y ellas
--    exigen un vale válido.
-- ------------------------------------------------------------
revoke all on function public.tablero_leer(text, text) from public;
revoke all on function public.tablero_guardar(text, text, jsonb, text) from public;
revoke all on function public.tablero_usuario_del_vale(text) from public;

grant execute on function public.tablero_leer(text, text) to anon, authenticated;
grant execute on function public.tablero_guardar(text, text, jsonb, text) to anon, authenticated;
-- tablero_usuario_del_vale queda solo para uso interno de las dos de arriba.
