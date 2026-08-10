-- ============================================================
--  Acceso a los documentos de post venta desde el navegador.
--
--  Hasta ahora `documentos` tenía RLS encendido y CERO policies: solo entraba
--  la app de Streamlit, que se conecta con la clave de la base. Para migrar
--  las pantallas a la plataforma web, el personal con sesión iniciada tiene
--  que poder leerlos (y escribir los que la app modifica).
--
--  DOS REGLAS QUE NO SE PUEDEN RELAJAR
--  -----------------------------------
--  1. `usuarios_curifor.json` NO se lee nunca desde el navegador. Tiene los
--     hash de contraseña de las 63 personas. La app de Streamlit lo necesita
--     (se conecta con la clave de la base y no pasa por estas policies); el
--     navegador no.
--  2. Solo escribe lo que de verdad se edita. Los documentos que fabrica el
--     proceso diario (OTs, stock, producción, cuenta ficha) son de solo
--     lectura: si el navegador pudiera escribirlos, un error de una pantalla
--     borraría el trabajo del consolidador.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_postventa.sql
-- ============================================================

-- ------------------------------------------------------------
-- 1) Qué documentos NO salen jamás al navegador
-- ------------------------------------------------------------
create or replace function public.documento_reservado(p_nombre text)
returns boolean language sql immutable as $$
  select p_nombre in ('usuarios_curifor.json')
$$;

comment on function public.documento_reservado(text) is
  'Documentos que solo puede tocar la app conectada con la clave de la base. usuarios_curifor.json lleva los hash de contrasena.';


-- ------------------------------------------------------------
-- 2) Qué documentos puede ESCRIBIR el personal desde el navegador.
--    Lista cerrada: agregar uno acá tiene que ser una decisión, no
--    un descuido. Los que fabrica el consolidador quedan fuera.
-- ------------------------------------------------------------
create or replace function public.documento_editable(p_nombre text)
returns boolean language sql immutable as $$
  select p_nombre in (
    'datos_dashboard.json',        -- las 4 columnas de gestion + color + etapa
    'comentarios_log.json',
    'notificaciones.json',
    'audit_log.json',
    'control_taller.json',
    'prepicking_estados.json',
    'cuenta_ficha_revisados.json',
    'loaners.json',
    'online_users.json',
    'tecnicos_sucursal_manual.json'
  )
$$;


-- ------------------------------------------------------------
-- 3) Policies sobre `documentos`
-- ------------------------------------------------------------
drop policy if exists documentos_select_personal on public.documentos;
create policy documentos_select_personal on public.documentos
  for select to authenticated
  using (public.es_personal_curifor() and not public.documento_reservado(nombre));

drop policy if exists documentos_update_personal on public.documentos;
create policy documentos_update_personal on public.documentos
  for update to authenticated
  using (public.es_personal_curifor() and public.documento_editable(nombre))
  with check (public.es_personal_curifor() and public.documento_editable(nombre));

-- Sin insert ni delete: los documentos ya existen y no se crean ni se borran
-- desde una pantalla. Crear uno nuevo es tarea del consolidador o de un script.


-- ------------------------------------------------------------
-- 4) Guardar sin pisar a otro.
--
--    Las pantallas leen el documento entero, lo modifican y lo guardan. Si dos
--    personas guardan a la vez, la ultima gana y el trabajo de la otra
--    desaparece sin aviso — el mismo problema que tenia GitHub. Esta funcion
--    solo escribe si el documento sigue igual que cuando se leyo.
--
--    Devuelve {ok:true, sello} o {ok:false, motivo:'conflicto', sello} con el
--    sello nuevo, para que la pantalla relea y reintente sobre lo ultimo.
-- ------------------------------------------------------------
create or replace function public.documento_guardar(p_nombre text, p_data jsonb,
                                                    p_sello text, p_mensaje text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_actual timestamptz;
  v_nuevo  timestamptz;
  v_quien  text;
begin
  if not public.es_personal_curifor() then
    return jsonb_build_object('ok', false, 'motivo', 'sin_permiso');
  end if;
  if not public.documento_editable(p_nombre) then
    return jsonb_build_object('ok', false, 'motivo', 'documento_no_editable');
  end if;
  if p_data is null or jsonb_typeof(p_data) not in ('object', 'array') then
    return jsonb_build_object('ok', false, 'motivo', 'datos_invalidos');
  end if;

  v_quien := coalesce(auth.jwt() ->> 'email', '?');

  select actualizado into v_actual from public.documentos
   where nombre = p_nombre for update;

  if v_actual is null then
    return jsonb_build_object('ok', false, 'motivo', 'no_existe');
  end if;

  if p_sello is distinct from to_char(v_actual, 'YYYY-MM-DD"T"HH24:MI:SS.US+00') then
    return jsonb_build_object('ok', false, 'motivo', 'conflicto',
                              'sello', to_char(v_actual, 'YYYY-MM-DD"T"HH24:MI:SS.US+00'));
  end if;

  update public.documentos
     set data = p_data, actualizado = now(),
         mensaje = coalesce(p_mensaje, 'plataforma') || ' · ' || v_quien
   where nombre = p_nombre
  returning actualizado into v_nuevo;

  return jsonb_build_object('ok', true,
                            'sello', to_char(v_nuevo, 'YYYY-MM-DD"T"HH24:MI:SS.US+00'));
end $$;

revoke all on function public.documento_guardar(text, jsonb, text, text) from public;
grant execute on function public.documento_guardar(text, jsonb, text, text) to authenticated;


-- ------------------------------------------------------------
-- 5) Leer con su sello, en una sola llamada.
--    PostgREST no expone `actualizado` junto al dato de forma cómoda para
--    todos los casos, y la pantalla necesita ambos para poder guardar después.
-- ------------------------------------------------------------
create or replace function public.documento_leer(p_nombre text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_data  jsonb;
  v_sello timestamptz;
begin
  if not public.es_personal_curifor() then
    return jsonb_build_object('ok', false, 'motivo', 'sin_permiso');
  end if;
  if public.documento_reservado(p_nombre) then
    return jsonb_build_object('ok', false, 'motivo', 'documento_reservado');
  end if;

  select data, actualizado into v_data, v_sello
    from public.documentos where nombre = p_nombre;

  if v_data is null then
    return jsonb_build_object('ok', false, 'motivo', 'no_existe');
  end if;

  return jsonb_build_object('ok', true, 'data', v_data,
                            'sello', to_char(v_sello, 'YYYY-MM-DD"T"HH24:MI:SS.US+00'));
end $$;

revoke all on function public.documento_leer(text) from public;
grant execute on function public.documento_leer(text) to authenticated;
