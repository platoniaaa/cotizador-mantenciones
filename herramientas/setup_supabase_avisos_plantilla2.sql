-- ============================================================
--  Plantilla del correo · version 2 (24-09-2026)
--
--  POR QUE SE REHIZO
--  -----------------
--  La v1 se veia bien en Gmail y rota en Outlook, que es donde la mira el
--  cliente. Outlook no usa un motor web: renderiza con Word. Ignora max-width,
--  border-radius y los margenes de los div. El correo salia a todo el ancho de
--  la pantalla, el check verde como una caja enorme y los dos botones pegados.
--
--  Ademas el texto llegaba con simbolos raros ("quedÃ³"): el HTML no declaraba
--  su codificacion y Outlook asumia Windows-1252 en vez de UTF-8.
--
--  QUE CAMBIA
--    · Documento HTML completo con <meta charset="utf-8">: arregla los acentos.
--    · Todo el armado con <table>, que es lo unico que Outlook respeta.
--    · Ancho fijo de 600 px centrado, en vez de max-width sobre un div.
--    · Botones construidos como tablas con fondo solido.
--    · Sin border-radius en lo estructural: en Outlook no existe.
--    · Fuentes sin comillas (Arial,Helvetica) para no pelear con el escape.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos_plantilla2.sql
--  o pegando este archivo en el editor SQL de Supabase.
-- ============================================================

create or replace function public.aviso_html(p_reserva uuid, p_tipo text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r        record;
  cfg      record;
  v_url    text;  v_si text;  v_no text;
  v_maps   text;  v_waze text;
  v_fecha  text;  v_fcorta text;  v_hora text;
  v_suc    text;  v_serv text;  v_veh text;  v_km text;
  v_nom    text;
  v_asunto text;  v_titulo text;  v_intro text;
  v_cta    text;  v_extra text;  v_html text;
  MESES text[] := array['enero','febrero','marzo','abril','mayo','junio','julio',
                        'agosto','septiembre','octubre','noviembre','diciembre'];
  DIAS  text[] := array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
begin
  select * into r from public.reservas_web where id = p_reserva;
  if not found then return null; end if;
  select * into cfg from public.avisos_config where id;

  v_fcorta := to_char(r.fecha, 'FMDD') || ' de ' || MESES[extract(month from r.fecha)::int];
  v_fecha  := initcap(DIAS[extract(dow from r.fecha)::int + 1]) || ' ' || v_fcorta ||
              ' de ' || to_char(r.fecha, 'YYYY');
  v_hora   := case when nullif(r.hora,'indiferente') is null then 'por confirmar'
                   else r.hora || ' h' end;
  v_suc    := initcap(coalesce(r.sucursal,'por confirmar'));
  v_maps   := 'https://www.google.com/maps/search/?api=1&query=' || replace(v_suc,' ','+');
  v_waze   := 'https://waze.com/ul?q=' || replace(v_suc,' ','%20');
  v_serv   := case r.servicio
                when 'mantencion'  then 'Mantención por kilometraje'
                when 'dip'         then 'Desabolladura y pintura'
                when 'diagnostico' then 'Diagnóstico técnico'
                when 'garantia'    then 'Garantía'
                else coalesce(nullif(r.servicio,''),'Servicio de taller') end;
  v_veh    := coalesce(nullif(concat_ws(' ', r.marca, r.modelo),''), r.patente, 'tu vehículo');
  v_km     := case when r.km_declarado is not null and r.km_declarado > 0
                   then regexp_replace(r.km_declarado::text, '(\d)(?=(\d{3})+$)', '\1.', 'g') || ' km' end;
  v_nom    := coalesce(nullif(split_part(coalesce(r.nombre,''),' ',1),''),'cliente');
  v_url := cfg.url_confirmar || '?t=' || r.token_aviso;
  v_si  := v_url || '&a=si';
  v_no  := v_url || '&a=no';

  -- ---------- lo que cambia segun el tipo ----------
  if p_tipo = 'agendada' then
    v_asunto := 'Tu hora quedó agendada · ' || v_fcorta;
    v_titulo := 'Tu hora quedó agendada';
    v_intro  := 'registramos tu hora en el taller. Acá están los detalles.';
    v_cta :=
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' ||
      '<tr><td align="center">' ||
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' ||
        '<td style="border:1px solid #cdd7ea;padding:11px 18px"><a href="' || v_maps ||
          '" style="color:#001b6c;text-decoration:none;font:bold 14px Arial,Helvetica,sans-serif">' ||
          'Ver en Google Maps</a></td>' ||
        '<td style="width:12px;font-size:0">&nbsp;</td>' ||
        '<td style="border:1px solid #cdd7ea;padding:11px 18px"><a href="' || v_waze ||
          '" style="color:#001b6c;text-decoration:none;font:bold 14px Arial,Helvetica,sans-serif">' ||
          'Abrir en Waze</a></td>' ||
        '</tr></table>' ||
      '</td></tr>' ||
      '<tr><td align="center" style="padding-top:18px">' ||
        '<a href="' || v_no || '" style="color:#16309a;font:bold 13px Arial,Helvetica,sans-serif;' ||
        'text-decoration:none">¿Necesitas cambiarla? Reagenda o anúlala</a>' ||
      '</td></tr></table>';
    v_extra := '<b>Para tu visita:</b> llega 10 minutos antes. Si tienes a mano el permiso de '
            || 'circulación y la última revisión técnica, agilizamos la recepción.';

  elsif p_tipo = 'recordatorio_7d' then
    v_asunto := 'Confirma tu hora en Curifor · ' || v_fcorta;
    v_titulo := 'Tu hora es en una semana';
    v_intro  := 'tu hora se acerca. Confírmala para reservarte el box y dejar listos los repuestos.';
    v_cta :=
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' ||
      '<tr><td align="center">' ||
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' ||
        '<td bgcolor="#0a7d43" style="padding:15px 34px"><a href="' || v_si ||
          '" style="color:#ffffff;text-decoration:none;font:bold 16px Arial,Helvetica,sans-serif">' ||
          'Confirmar mi hora</a></td></tr></table>' ||
      '</td></tr>' ||
      '<tr><td align="center" style="padding-top:14px">' ||
        '<a href="' || v_no || '" style="color:#a8202a;font:bold 13px Arial,Helvetica,sans-serif;' ||
        'text-decoration:none">No voy a poder ir · reagendar o cancelar</a>' ||
      '</td></tr></table>';
    v_extra := 'Confirmar nos ayuda a no dejar boxes vacíos y a atender a más clientes. Si no '
            || 'confirmas, te escribimos una vez más el día antes.';

  else
    v_asunto := 'Mañana es tu hora · confírmala por favor';
    v_titulo := 'Mañana te esperamos';
    v_intro  := 'tu hora es mañana. Confírmala así te reservamos el box; y si no vas a poder, '
             || 'cancélala para liberar la hora a otro cliente.';
    v_cta :=
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' ||
      '<tr><td align="center">' ||
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' ||
        '<td bgcolor="#0a7d43" style="padding:15px 34px"><a href="' || v_si ||
          '" style="color:#ffffff;text-decoration:none;font:bold 16px Arial,Helvetica,sans-serif">' ||
          'Confirmar mi hora</a></td></tr></table>' ||
      '</td></tr>' ||
      '<tr><td align="center" style="padding-top:14px">' ||
        '<a href="' || v_no || '" style="color:#a8202a;font:bold 13px Arial,Helvetica,sans-serif;' ||
        'text-decoration:none">No podré ir · cancelar y liberar la hora</a>' ||
      '</td></tr>' ||
      '<tr><td align="center" style="padding-top:16px">' ||
        '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' ||
        '<td style="border:1px solid #cdd7ea;padding:10px 16px"><a href="' || v_maps ||
          '" style="color:#001b6c;text-decoration:none;font:bold 13px Arial,Helvetica,sans-serif">' ||
          'Google Maps</a></td>' ||
        '<td style="width:10px;font-size:0">&nbsp;</td>' ||
        '<td style="border:1px solid #cdd7ea;padding:10px 16px"><a href="' || v_waze ||
          '" style="color:#001b6c;text-decoration:none;font:bold 13px Arial,Helvetica,sans-serif">' ||
          'Waze</a></td></tr></table>' ||
      '</td></tr></table>';
    v_extra := '<b>Llega 10 minutos antes.</b> Trae el permiso de circulación y, si la tienes a '
            || 'mano, la última revisión técnica.';
  end if;

  -- ---------- armado: todo en tablas, para que Outlook lo respete ----------
  v_html :=
  '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">' ||
  '<meta name="viewport" content="width=device-width,initial-scale=1">' ||
  '<title>' || v_titulo || '</title></head>' ||
  '<body style="margin:0;padding:0;background-color:#eef1f8">' ||
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' ||
    'style="background-color:#eef1f8"><tr><td align="center" style="padding:24px 10px">' ||

  '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" ' ||
    'style="width:600px;max-width:600px;background-color:#ffffff;border:1px solid #dfe6f2">' ||

    -- Cabecera con el logotipo real. Va sobre BLANCO porque el logo es azul
    -- marino: sobre la banda azul de antes no se veria.
    --
    -- El alt lleva estilo propio a proposito. Outlook y Gmail bloquean las
    -- imagenes hasta que el lector las autoriza, y sin eso la cabecera quedaria
    -- vacia; asi, mientras no cargue, se lee CURIFOR en azul y el correo sigue
    -- teniendo identidad.
    '<tr><td align="center" style="background-color:#ffffff;padding:26px 26px 20px;' ||
      'border-bottom:3px solid #001b6c">' ||
      '<img src="https://platoniaaa.github.io/cotizador-mantenciones/img/curifor-logo.png" ' ||
        'alt="CURIFOR" width="180" height="40" ' ||
        'style="display:block;margin:0 auto;border:0;width:180px;height:40px;' ||
        'font:bold 24px Arial,Helvetica,sans-serif;color:#001b6c;letter-spacing:2px">' ||
      '<div style="font:bold 11px Arial,Helvetica,sans-serif;letter-spacing:2px;color:#4a566e;' ||
        'padding-top:12px">SERVICIO Y POSTVENTA</div>' ||
    '</td></tr>' ||

    '<tr><td style="padding:26px 26px 0">' ||
      case when p_tipo = 'agendada' then
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' ||
        '<tr><td align="center" style="padding-bottom:10px">' ||
          '<span style="font:bold 42px Arial,Helvetica,sans-serif;color:#0a7d43">&#10003;</span>' ||
        '</td></tr></table>' ||
        '<div style="font:bold 23px Arial,Helvetica,sans-serif;color:#0d2350;text-align:center;' ||
          'padding-bottom:10px">' || v_titulo || '</div>' ||
        '<div style="font:15px/1.55 Arial,Helvetica,sans-serif;color:#3a475f;text-align:center">' ||
          'Hola <b style="color:#16233a">' || v_nom || '</b>, ' || v_intro || '</div>'
      else
        '<div style="font:bold 23px Arial,Helvetica,sans-serif;color:#0d2350;padding-bottom:10px">' ||
          v_titulo || '</div>' ||
        '<div style="font:15px/1.55 Arial,Helvetica,sans-serif;color:#3a475f">Hola ' ||
          '<b style="color:#16233a">' || v_nom || '</b>, ' || v_intro || '</div>'
      end ||
    '</td></tr>' ||

    '<tr><td style="padding:20px 26px 0">' ||
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="' ||
        case when p_tipo = 'recordatorio_24h' then '#eefaf1' else '#f4f6fb' end || '"><tr>' ||
        '<td width="5" bgcolor="' ||
          case when p_tipo = 'recordatorio_24h' then '#0a7d43' else '#001b6c' end ||
          '" style="width:5px;font-size:0;line-height:0">&nbsp;</td>' ||
        '<td style="padding:14px 18px">' ||
          '<div style="font:bold 11px Arial,Helvetica,sans-serif;letter-spacing:1.4px;' ||
            'color:#7c8aa3;padding-bottom:4px">' ||
            case when p_tipo = 'recordatorio_24h' then 'MAÑANA' else 'TU CITA' end || '</div>' ||
          '<div style="font:bold 19px Arial,Helvetica,sans-serif;color:#0d2350">' || v_fecha || '</div>' ||
          '<div style="font:15px Arial,Helvetica,sans-serif;color:#3a475f;padding-top:4px">a las ' ||
            '<b style="color:#0a7d43">' || v_hora || '</b></div>' ||
        '</td></tr></table>' ||
    '</td></tr>' ||

    '<tr><td style="padding:22px 26px 0">' ||
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2fb">' ||
      '<tr><td style="padding:9px 14px;font:bold 12px Arial,Helvetica,sans-serif;' ||
        'letter-spacing:.5px;color:#001b6c">TU SERVICIO</td></tr></table>' ||
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' ||
        'style="font:14px Arial,Helvetica,sans-serif">' ||
        '<tr><td style="padding:10px 2px;color:#7c8aa3;border-bottom:1px solid #eef1f7">Servicio</td>' ||
            '<td align="right" style="padding:10px 2px;color:#16233a;font-weight:bold;' ||
            'border-bottom:1px solid #eef1f7">' || v_serv || '</td></tr>' ||
        '<tr><td style="padding:10px 2px;color:#7c8aa3">Sucursal</td>' ||
            '<td align="right" style="padding:10px 2px;color:#16233a;font-weight:bold">' ||
            v_suc || '</td></tr>' ||
      '</table>' ||
    '</td></tr>' ||

    '<tr><td style="padding:18px 26px 0">' ||
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#eef2fb">' ||
      '<tr><td style="padding:9px 14px;font:bold 12px Arial,Helvetica,sans-serif;' ||
        'letter-spacing:.5px;color:#001b6c">TU VEHÍCULO</td></tr></table>' ||
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' ||
        'style="font:14px Arial,Helvetica,sans-serif">' ||
        '<tr><td style="padding:10px 2px;color:#7c8aa3;border-bottom:1px solid #eef1f7">Vehículo</td>' ||
            '<td align="right" style="padding:10px 2px;color:#16233a;font-weight:bold;' ||
            'border-bottom:1px solid #eef1f7">' || v_veh || '</td></tr>' ||
        case when r.patente is not null then
        '<tr><td style="padding:10px 2px;color:#7c8aa3;border-bottom:1px solid #eef1f7">Patente</td>' ||
            '<td align="right" style="padding:10px 2px;color:#16233a;font-weight:bold;' ||
            'border-bottom:1px solid #eef1f7">' || upper(r.patente) || '</td></tr>'
        else '' end ||
        case when v_km is not null then
        '<tr><td style="padding:10px 2px;color:#7c8aa3">Kilometraje</td>' ||
            '<td align="right" style="padding:10px 2px;color:#16233a;font-weight:bold">' ||
            v_km || '</td></tr>'
        else '' end ||
      '</table>' ||
    '</td></tr>' ||

    '<tr><td style="padding:22px 26px 0">' || v_cta || '</td></tr>' ||

    '<tr><td style="padding:20px 26px 0">' ||
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f7f9fd">' ||
      '<tr><td style="padding:13px 16px;font:13px/1.5 Arial,Helvetica,sans-serif;color:#5a6880">' ||
        v_extra || '</td></tr></table>' ||
    '</td></tr>' ||

    '<tr><td style="padding:16px 26px 24px">' ||
      '<div style="font:11px/1.5 Arial,Helvetica,sans-serif;color:#9aa6bf;text-align:center;' ||
        'word-break:break-all">Si un botón no funciona, copia este enlace:<br>' || v_url || '</div>' ||
    '</td></tr>' ||

    '<tr><td style="background-color:#0c1a3e;padding:20px 26px">' ||
      '<div style="font:12px/1.6 Arial,Helvetica,sans-serif;color:#aeb9d4">' ||
        '<b style="color:#ffffff">Curifor S.A.</b> · Servicio y Postventa</div>' ||
      '<div style="font:12px/1.6 Arial,Helvetica,sans-serif;color:#aeb9d4;padding-top:4px">' ||
        '¿Dudas? Responde este correo.</div>' ||
      '<div style="font:11px/1.55 Arial,Helvetica,sans-serif;color:#8593ba;padding-top:14px">' ||
        'Recibes este correo porque tienes una hora de servicio agendada en Curifor. ' ||
        'Tratamos tus datos solo para gestionar tu atención, conforme a la Ley 19.628 y la Ley 21.719.</div>' ||
    '</td></tr>' ||

  '</table></td></tr></table></body></html>';

  return jsonb_build_object('asunto', v_asunto, 'html', v_html,
                            'nombre', coalesce(nullif(r.nombre,''),'Cliente'),
                            'email', r.email);
end $$;

comment on function public.aviso_html(uuid, text) is
  'Correo al cliente, v2 (24-09-2026): armado en tablas y con charset declarado, para que Outlook lo muestre bien.';
