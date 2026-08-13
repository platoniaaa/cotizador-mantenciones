-- ============================================================
--  Los avisos salen por Resend
--
--  Reemplaza el despacho que apuntaba a Brevo. Solo cambia POR DÓNDE viaja el
--  correo: las ventanas de tiempo, la bitácora de envíos, los tokens y la
--  página de confirmación quedan igual (ver setup_supabase_avisos.sql).
--
--  Diferencias que obligan a este archivo:
--    · Resend recibe el remitente como un solo texto: "Nombre <correo>".
--    · El destinatario va en un arreglo `to`.
--    · La clave viaja en Authorization: Bearer, no en un encabezado propio.
--
--  MIENTRAS NO HAYA UN DOMINIO VERIFICADO, Resend solo acepta enviar desde
--  onboarding@resend.dev y ÚNICAMENTE a la casilla dueña de la cuenta. Por eso
--  el remitente por defecto queda en ese valor: así una prueba funciona sin
--  tocar nada, y al verificar curifor.com se cambia por agenda@curifor.com.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos_resend.sql
-- ============================================================

-- El remitente por defecto pasa a ser el de pruebas de Resend. Si ya estaba
-- configurado uno propio, no se pisa.
update public.avisos_config
   set remitente = 'onboarding@resend.dev'
 where remitente = 'agenda@curifor.com';

comment on column public.avisos_config.remitente is
  'Casilla desde la que salen los correos. Mientras no haya dominio verificado en Resend debe ser onboarding@resend.dev; despues, agenda@curifor.com.';


create or replace function public.avisos_despachar(p_limite int default 25)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg     record;
  p       record;
  cuerpo  jsonb;
  v_key   text;
  v_req   bigint;
  n_ok    int := 0;
  n_omit  int := 0;
begin
  select * into cfg from public.avisos_config where id;
  if not found or not cfg.activo then
    return jsonb_build_object('ok', false, 'motivo', 'avisos desactivados');
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'RESEND_API_KEY';
  if v_key is null or v_key = '' then
    return jsonb_build_object('ok', false, 'motivo', 'falta RESEND_API_KEY en Vault');
  end if;

  for p in select * from public.avisos_pendientes() limit p_limite loop
    -- Se reserva el envío ANTES de mandarlo. El unique(reserva_id, tipo) es lo
    -- que impide que dos vueltas del cron solapadas manden el mismo correo dos
    -- veces: al cliente le molesta más recibir cuatro recordatorios que ninguno.
    begin
      insert into public.avisos_enviados (reserva_id, tipo, destinatario, estado)
           values (p.reserva_id, p.tipo, p.destinatario, 'pendiente');
    exception when unique_violation then
      n_omit := n_omit + 1;
      continue;
    end;

    cuerpo := public.aviso_html(p.reserva_id, p.tipo);
    if cuerpo is null then
      update public.avisos_enviados set estado = 'error', detalle = 'no se pudo armar el correo'
       where reserva_id = p.reserva_id and tipo = p.tipo;
      continue;
    end if;

    select net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key,
                                    'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'from', cfg.remitente_nom || ' <' || cfg.remitente || '>',
        'to', jsonb_build_array(cuerpo->>'email'),
        'subject', cuerpo->>'asunto',
        'html', cuerpo->>'html',
        'tags', jsonb_build_array(jsonb_build_object('name', 'aviso', 'value', p.tipo))
      ) ||
      case when cfg.responder_a is not null
           then jsonb_build_object('reply_to', cfg.responder_a) else '{}'::jsonb end ||
      case when cfg.copia_interna is not null
           then jsonb_build_object('bcc', jsonb_build_array(cfg.copia_interna)) else '{}'::jsonb end,
      timeout_milliseconds := 8000
    ) into v_req;

    update public.avisos_enviados
       set estado = 'enviado', enviado_en = now(), request_id = v_req
     where reserva_id = p.reserva_id and tipo = p.tipo;
    n_ok := n_ok + 1;
  end loop;

  return jsonb_build_object('ok', true, 'enviados', n_ok, 'omitidos', n_omit);
end $$;

revoke all on function public.avisos_despachar(int) from public, anon, authenticated;


-- ------------------------------------------------------------
--  Prueba manual: manda UN correo a la casilla que se le indique,
--  sin depender de que haya citas ni de que el sistema esté activo.
--  Sirve para comprobar la clave y ver cómo se ve el correo antes de
--  encenderlo para los clientes.
-- ------------------------------------------------------------
-- Postgres no deja renombrar un parámetro con CREATE OR REPLACE, y esta
-- función pudo quedar de un intento anterior con otro nombre de parámetro.
drop function if exists public.avisos_probar(text);

create or replace function public.avisos_probar(p_destino text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg   record;
  v_key text;
  v_req bigint;
begin
  select * into cfg from public.avisos_config where id;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'RESEND_API_KEY';
  if v_key is null or v_key = '' then
    return jsonb_build_object('ok', false, 'motivo', 'falta RESEND_API_KEY en Vault');
  end if;

  select net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key,
                                  'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'from', cfg.remitente_nom || ' <' || cfg.remitente || '>',
      'to', jsonb_build_array(p_destino),
      'subject', 'Prueba de los avisos de Curifor',
      'html', '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#16324f">' ||
              '<div style="background:#0d2f5a;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">' ||
              '<div style="font-size:13px;opacity:.85;letter-spacing:1px">CURIFOR POST VENTA</div>' ||
              '<h1 style="margin:6px 0 0;font-size:20px">Los avisos funcionan</h1></div>' ||
              '<div style="border:1px solid #d7dee8;border-top:0;border-radius:0 0 12px 12px;padding:22px">' ||
              '<p style="font-size:15px;line-height:1.5;margin:0">Si estás leyendo esto, la conexión con ' ||
              'Resend quedó lista y los correos a los clientes pueden encenderse.</p>' ||
              '<p style="font-size:13px;color:#789;margin:16px 0 0">Enviado desde ' || cfg.remitente ||
              ' · ' || to_char(now() at time zone 'America/Santiago', 'DD-MM-YYYY HH24:MI') || '</p>' ||
              '</div></div>'
    ),
    timeout_milliseconds := 8000
  ) into v_req;

  return jsonb_build_object('ok', true, 'request_id', v_req, 'destino', p_destino,
                            'remitente', cfg.remitente);
end $$;

revoke all on function public.avisos_probar(text) from public, anon, authenticated;
