-- ============================================================
--  Los avisos por correo pasan a Resend
--
--  Decisión de Ignacio (13-08-2026): se usa Resend en vez de Brevo. La cuenta
--  ya está creada (curiforsa10). Cambia SOLO el despacho: la lógica de cuándo
--  mandar cada correo, la bitácora, los tokens y la página de confirmación
--  quedan exactamente igual.
--
--  Diferencias con Brevo que obligan a tocar esto:
--    · Autenticación con `Authorization: Bearer`, no con `api-key`.
--    · El remitente va como un solo texto: "Nombre <correo@dominio>".
--    · Los destinatarios son un arreglo de texto plano.
--    · La clave se llama RESEND_API_KEY en Vault.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos_resend.sql
-- ============================================================

-- Resend permite responder al correo del taller; se deja explícito.
update public.avisos_config
   set responder_a = coalesce(responder_a, 'postventa@curifor.com')
 where id;


-- ------------------------------------------------------------
--  Despacho contra la API de Resend
--
--  Se mantiene el orden: anotar PRIMERO, mandar después. Si algo revienta en
--  el medio queda un aviso marcado como enviado que no salió — el error
--  correcto. El contrario (mandar y no anotar) manda el mismo correo cada
--  cinco minutos, para siempre.
-- ------------------------------------------------------------
create or replace function public.avisos_despachar(p_limite int default 25)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg     record;
  p       record;
  cuerpo  jsonb;
  v_key   text;
  v_req   bigint;
  v_from  text;
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

  -- Resend quiere el remitente en una sola línea: Nombre <correo>
  v_from := coalesce(cfg.remitente_nom || ' <' || cfg.remitente || '>', cfg.remitente);

  for p in select * from public.avisos_pendientes() limit p_limite loop
    -- Reserva el envío. El unique(reserva_id, tipo) es lo que impide que dos
    -- vueltas solapadas del cron manden el mismo correo dos veces.
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
                'from', v_from,
                'to', jsonb_build_array(cuerpo->>'email'),
                'subject', cuerpo->>'asunto',
                'html', cuerpo->>'html',
                'tags', jsonb_build_array(
                          jsonb_build_object('name', 'tipo', 'value', p.tipo))
              ) ||
              case when cfg.responder_a is not null
                   then jsonb_build_object('reply_to', cfg.responder_a)
                   else '{}'::jsonb end ||
              case when cfg.copia_interna is not null
                   then jsonb_build_object('bcc', jsonb_build_array(cfg.copia_interna))
                   else '{}'::jsonb end,
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
--  Mandar un correo de prueba a una dirección concreta.
--
--  Existe para el paso que más se equivoca: antes de encender el sistema para
--  todos los clientes, mandarse UNO a uno mismo y ver que llegue, que no caiga
--  en spam y que el botón de confirmar funcione. No toca la bitácora ni
--  ninguna cita.
-- ------------------------------------------------------------
create or replace function public.avisos_probar(p_email text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg    record;
  v_key  text;
  v_req  bigint;
  v_from text;
  resp   record;
  i      int := 0;
begin
  if not public.es_personal_curifor() then
    return jsonb_build_object('ok', false, 'motivo', 'solo personal de Curifor');
  end if;

  select * into cfg from public.avisos_config where id;
  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'RESEND_API_KEY';
  if v_key is null or v_key = '' then
    return jsonb_build_object('ok', false, 'motivo', 'falta RESEND_API_KEY en Vault');
  end if;
  v_from := coalesce(cfg.remitente_nom || ' <' || cfg.remitente || '>', cfg.remitente);

  select net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_key,
                                  'Content-Type', 'application/json'),
    body := jsonb_build_object(
      'from', v_from,
      'to', jsonb_build_array(p_email),
      'subject', 'Prueba de los avisos · Curifor Post Venta',
      'html', '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#16324f">' ||
              '<div style="background:#0d2f5a;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">' ||
              '<div style="font-size:13px;opacity:.85;letter-spacing:1px">CURIFOR POST VENTA</div>' ||
              '<h1 style="margin:6px 0 0;font-size:20px">Si lees esto, los avisos funcionan</h1></div>' ||
              '<div style="border:1px solid #d7dee8;border-top:0;border-radius:0 0 12px 12px;padding:22px">' ||
              '<p style="font-size:15px;line-height:1.5;margin:0 0 14px">Este es un correo de prueba del ' ||
              'sistema de avisos. Los clientes reciben tres: al agendar, siete días antes y ' ||
              'veinticuatro horas antes si no confirmaron.</p>' ||
              '<p style="font-size:13px;color:#789;margin:0">Enviado desde ' || v_from ||
              ' el ' || to_char(now() at time zone 'America/Santiago', 'DD-MM-YYYY HH24:MI') || '.</p>' ||
              '</div></div>'
    ),
    timeout_milliseconds := 8000
  ) into v_req;

  -- pg_net responde asincrónico: se espera un poco para poder decir de
  -- inmediato si Resend lo aceptó, en vez de dejar a quien prueba sin saber.
  while i < 20 loop
    perform pg_sleep(0.25);
    select status_code, content into resp from net._http_response where id = v_req;
    if found then
      return jsonb_build_object(
        'ok', resp.status_code between 200 and 299,
        'http', resp.status_code,
        'desde', v_from,
        'para', p_email,
        'respuesta', left(coalesce(resp.content, ''), 300));
    end if;
    i := i + 1;
  end loop;
  return jsonb_build_object('ok', null, 'motivo', 'sin respuesta todavía',
                            'request_id', v_req, 'desde', v_from);
end $$;

revoke all on function public.avisos_probar(text) from public, anon;
grant execute on function public.avisos_probar(text) to authenticated;

comment on function public.avisos_probar(text) is
  'Manda un correo de prueba a una direccion. No toca la bitacora ni ninguna cita. Usar ANTES de encender los avisos.';
