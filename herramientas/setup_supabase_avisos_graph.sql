-- =============================================================
--  Envío de avisos por Microsoft 365 (Graph) vía Edge Function
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos_graph.sql
--
--  POR QUÉ ASÍ (y no llamando a Microsoft directo desde la base)
--  ------------------------------------------------------------
--  El motor manda con pg_net, que SOLO sabe enviar cuerpo JSON. El login de
--  Microsoft (OAuth) exige el cuerpo en form-urlencoded y rechaza JSON: se
--  probó y devuelve AADSTS900144. Son incompatibles. La solución es una Edge
--  Function (supabase/functions/curifor-correo) que recibe JSON desde la base
--  y le habla a Microsoft en el formato que Microsoft exige. Esta función
--  además maneja el token OAuth y lo cachea; la base ni se entera del token.
--
--  Ventaja de Microsoft 365 sobre Resend: NO necesita registros DNS nuevos.
--  El correo sale por la infraestructura de 365 que Curifor ya tiene
--  autenticada para curifor.com (SPF/DKIM/DMARC ya cuadran).
--
--  Se reutiliza TODO el motor: pg_cron, plantillas (aviso_html), avisos_config
--  y el control de "una sola vez" (avisos_enviados). Lo único que cambia es a
--  quién se le entrega el correo: ahora a la Edge Function.
--
--  QUÉ FALTA PARA ENCENDER
--  -----------------------
--  (A) TI, en Entra ID (Azure AD): registrar una aplicación, darle el permiso
--      de APLICACIÓN Mail.Send (Microsoft Graph) con consentimiento de admin,
--      y acotarla con una Application Access Policy SOLO al buzón
--      serviciotecnico@curifor.com. Entrega: tenant id, client id, client secret.
--  (B) Desplegar la Edge Function con esas credenciales como secretos:
--        supabase functions deploy curifor-correo --no-verify-jwt
--        supabase secrets set MS_TENANT_ID=... MS_CLIENT_ID=... \
--          MS_CLIENT_SECRET=... MS_SENDER=serviciotecnico@curifor.com \
--          FUNC_SECRET=<uno largo y aleatorio>
--  (C) En Vault de la base, dos secretos para que el motor la encuentre:
--        select vault.create_secret('https://<ref>.supabase.co/functions/v1/curifor-correo',
--                                   'CURIFOR_CORREO_URL');
--        select vault.create_secret('<el mismo FUNC_SECRET de arriba>',
--                                   'CURIFOR_FUNC_SECRET');
--  (D) Encender:
--        update public.avisos_config set proveedor='graph', activo=true;
--
--  Antes de (D), probar el tubo completo con:
--        select public.avisos_probar_correo('tu-correo@ejemplo.cl');
--
--  ADITIVO e idempotente: se puede correr sin romper lo demás.
-- =============================================================

create extension if not exists pg_net;


-- ---------------------------------------------------------------
-- 1 · de qué proveedor sale el correo
-- ---------------------------------------------------------------
alter table public.avisos_config
  add column if not exists proveedor text not null default 'graph';

-- El check se agrega aparte para que no reviente si la columna ya existía
-- con otra restricción.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'avisos_config_proveedor_chk') then
    alter table public.avisos_config
      add constraint avisos_config_proveedor_chk
      check (proveedor in ('brevo','resend','graph'));
  end if;
end $$;


-- ---------------------------------------------------------------
-- 2 · el despacho: entrega cada correo a la Edge Function
--
--     Mismo patrón de siempre: se RESERVA el envío antes de mandarlo
--     (insert con unique(reserva_id,tipo)), así dos vueltas del cron
--     solapadas nunca mandan el mismo correo dos veces.
-- ---------------------------------------------------------------
create or replace function public.avisos_despachar(p_limite int default 25)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg    record;
  p      record;
  cuerpo jsonb;
  v_url  text;
  v_sec  text;
  v_req  bigint;
  n_ok   int := 0;
  n_omit int := 0;
begin
  select * into cfg from public.avisos_config where id;
  if not found or not cfg.activo then
    return jsonb_build_object('ok', false, 'motivo', 'avisos desactivados');
  end if;

  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'CURIFOR_CORREO_URL';
  select decrypted_secret into v_sec from vault.decrypted_secrets where name = 'CURIFOR_FUNC_SECRET';
  if v_url is null or v_url = '' or v_sec is null or v_sec = '' then
    return jsonb_build_object('ok', false,
      'motivo', 'falta CURIFOR_CORREO_URL o CURIFOR_FUNC_SECRET en Vault');
  end if;

  for p in select * from public.avisos_pendientes() limit p_limite loop
    -- Reserva el envío. Si otra vuelta ya lo tomó, el unique lo rebota y se salta.
    begin
      insert into public.avisos_enviados (reserva_id, tipo, destinatario, estado)
           values (p.reserva_id, p.tipo, p.destinatario, 'pendiente');
    exception when unique_violation then
      n_omit := n_omit + 1;
      continue;
    end;

    cuerpo := public.aviso_html(p.reserva_id, p.tipo);
    if cuerpo is null or coalesce(cuerpo->>'email','') = '' then
      update public.avisos_enviados
         set estado = 'error', detalle = 'sin correo o no se pudo armar'
       where reserva_id = p.reserva_id and tipo = p.tipo;
      continue;
    end if;

    -- pg_net manda JSON (lo único que sabe); la Edge Function traduce a Graph.
    select net.http_post(
      url := v_url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-curifor-secret', v_sec),
      body := jsonb_build_object(
        'to',      cuerpo->>'email',
        'toName',  cuerpo->>'nombre',
        'subject', cuerpo->>'asunto',
        'html',    cuerpo->>'html'),
      timeout_milliseconds := 15000
    ) into v_req;

    update public.avisos_enviados
       set estado = 'enviado', enviado_en = now(), request_id = v_req
     where reserva_id = p.reserva_id and tipo = p.tipo;
    n_ok := n_ok + 1;
  end loop;

  return jsonb_build_object('ok', true, 'enviados', n_ok, 'omitidos', n_omit);
end $$;

revoke all on function public.avisos_despachar(int) from public, anon, authenticated;


-- ---------------------------------------------------------------
-- 3 · prueba de punta a punta, sin esperar una reserva real
--     select public.avisos_probar_correo('tu-correo@ejemplo.cl');
--     Luego revisar el resultado real:
--     select status_code, content from net._http_response order by id desc limit 1;
-- ---------------------------------------------------------------
create or replace function public.avisos_probar_correo(p_destino text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url text;
  v_sec text;
  v_req bigint;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'CURIFOR_CORREO_URL';
  select decrypted_secret into v_sec from vault.decrypted_secrets where name = 'CURIFOR_FUNC_SECRET';
  if v_url is null or v_sec is null then
    return jsonb_build_object('ok', false, 'motivo', 'faltan CURIFOR_CORREO_URL / CURIFOR_FUNC_SECRET en Vault');
  end if;

  select net.http_post(
    url := v_url,
    headers := jsonb_build_object('Content-Type','application/json','x-curifor-secret', v_sec),
    body := jsonb_build_object(
      'to', p_destino,
      'toName', 'Prueba Curifor',
      'subject', 'Prueba de correo · Curifor Postventa',
      'html', '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;'
           || 'border:1px solid #dfe6f2;border-radius:12px;overflow:hidden">'
           || '<div style="background:#001b6c;color:#fff;padding:18px 22px;font-weight:800;'
           || 'letter-spacing:2px">CURIFOR</div>'
           || '<div style="padding:22px;color:#16233a;font-size:15px;line-height:1.55">'
           || 'Este es un correo de <b>prueba</b> del sistema de agenda de Curifor. '
           || 'Si te llegó, el envío por Microsoft 365 quedó funcionando.</div></div>'),
    timeout_milliseconds := 15000
  ) into v_req;

  return jsonb_build_object('ok', true, 'request_id', v_req,
    'nota', 'en unos segundos: select status_code, content from net._http_response where id = '
            || v_req);
end $$;

revoke all on function public.avisos_probar_correo(text) from public, anon, authenticated;


-- ---------------------------------------------------------------
-- 4 · recordatorio de encendido (queda apagado hasta que TI complete A-C)
-- ---------------------------------------------------------------
-- update public.avisos_config set proveedor = 'graph', activo = true;
