-- ============================================================
--  Plantilla de los correos al cliente  (diseño aprobado · ago-2026)
--
--  Reemplaza SOLO la función public.aviso_html. No toca el motor
--  (pg_cron, pg_net, avisos_enviados, avisos_despachar): esos siguen
--  igual, cambia únicamente cómo se ve el correo.
--
--  Qué trae este diseño, respecto del anterior:
--    · Color de marca Curifor (#001b6c) en vez del azul genérico.
--    · Correo "agendada" con check de éxito y SIN botón de confirmar
--      (al agendar no se confirma todavía; eso se pide a los 7 días y 24 h).
--    · Bloques separados "Tu servicio" / "Tu vehículo".
--    · Botones Google Maps y Waze (en Chile Waze se usa tanto como Maps).
--    · Pie con la nota de la Ley 19.628 y 21.719.
--
--  Los campos salen de reservas_web tal como los guarda la agenda:
--    servicio (id), km_declarado, sucursal (id "CURIFOR TALCA"),
--    patente, marca, modelo, fecha, hora, nombre, email.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos_plantilla.sql
-- ============================================================

create or replace function public.aviso_html(p_reserva uuid, p_tipo text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r        record;
  cfg      record;
  v_url    text;
  v_si     text;
  v_no     text;
  v_maps   text;
  v_waze   text;

  v_dia_sem text;
  v_fecha   text;    -- "martes 9 de septiembre de 2026"
  v_fcorta  text;    -- "9 de septiembre"
  v_hora    text;    -- "10:30 h" o "por confirmar"
  v_suc     text;    -- "Curifor Talca"
  v_serv    text;    -- nombre bonito del servicio
  v_veh     text;    -- "Suzuki Swift" o patente
  v_km      text;    -- "45.320 km" o null

  v_asunto text;
  v_titulo text;
  v_intro  text;
  v_cta    text;     -- bloque de botones, distinto por tipo
  v_extra  text;     -- tip final, distinto por tipo
  v_html   text;

  MESES text[] := array['enero','febrero','marzo','abril','mayo','junio','julio',
                        'agosto','septiembre','octubre','noviembre','diciembre'];
  DIAS  text[] := array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
begin
  select * into r from public.reservas_web where id = p_reserva;
  if not found then return null; end if;
  select * into cfg from public.avisos_config where id;

  -- ---- fecha y hora en palabras ----
  v_dia_sem := DIAS[extract(dow from r.fecha)::int + 1];
  v_fcorta  := to_char(r.fecha, 'FMDD') || ' de ' || MESES[extract(month from r.fecha)::int];
  v_fecha   := initcap(v_dia_sem) || ' ' || v_fcorta || ' de ' || to_char(r.fecha, 'YYYY');
  v_hora    := case when nullif(r.hora, 'indiferente') is null
                    then 'por confirmar' else r.hora || ' h' end;

  -- ---- sucursal + enlaces de mapa ----
  v_suc  := initcap(coalesce(r.sucursal, 'por confirmar'));
  v_maps := 'https://www.google.com/maps/search/?api=1&query=' || replace(v_suc, ' ', '+');
  v_waze := 'https://waze.com/ul?q=' || replace(v_suc, ' ', '%20');

  -- ---- servicio: el id se guarda; acá se traduce al nombre que ve el cliente ----
  v_serv := case r.servicio
              when 'mantencion'  then 'Mantención por kilometraje'
              when 'dip'         then 'Desabolladura y pintura'
              when 'diagnostico' then 'Diagnóstico técnico'
              when 'garantia'    then 'Garantía'
              else coalesce(nullif(r.servicio, ''), 'Servicio de taller')
            end;

  -- ---- vehículo y kilometraje ----
  v_veh := coalesce(nullif(concat_ws(' ', r.marca, r.modelo), ''), r.patente, 'tu vehículo');
  -- separador de miles con punto, sin depender del locale del servidor
  v_km  := case when r.km_declarado is not null and r.km_declarado > 0
                then regexp_replace(r.km_declarado::text, '(\d)(?=(\d{3})+$)', '\1.', 'g') || ' km' end;

  -- ---- enlaces del token ----
  v_url := cfg.url_confirmar || '?t=' || r.token_aviso;
  v_si  := v_url || '&a=si';
  v_no  := v_url || '&a=no';

  -- ======================================================
  --  Lo que cambia según el tipo de correo
  -- ======================================================
  if p_tipo = 'agendada' then
    v_asunto := 'Tu hora quedó agendada · ' || v_fcorta;
    v_titulo := 'Tu hora quedó agendada';
    v_intro  := 'registramos tu hora en el taller. Acá están los detalles. Te escribiremos '
             || 'unos días antes para confirmarla.';
    -- Al agendar NO se pide confirmar: solo reagendar/anular si algo no calza.
    v_cta :=
      '<div style="text-align:center;margin:2px 0 4px">' ||
        '<a href="' || v_maps || '" style="display:inline-block;margin:6px 5px 0;padding:11px 20px;' ||
          'border-radius:10px;border:1px solid #cdd7ea;color:#001b6c;text-decoration:none;' ||
          'font-size:14px;font-weight:600">Ver en Google Maps</a>' ||
        '<a href="' || v_waze || '" style="display:inline-block;margin:6px 5px 0;padding:11px 20px;' ||
          'border-radius:10px;border:1px solid #cdd7ea;color:#001b6c;text-decoration:none;' ||
          'font-size:14px;font-weight:600">Abrir en Waze</a>' ||
      '</div>' ||
      '<div style="text-align:center;margin:20px 0 4px">' ||
        '<a href="' || v_no || '" style="color:#16309a;font-size:13.5px;text-decoration:none;' ||
          'font-weight:600">¿Necesitas cambiarla? Reagenda o anúlala</a>' ||
      '</div>';
    v_extra := '<b>Para tu visita:</b> llega 10 minutos antes. Si tienes a mano el permiso de '
            || 'circulación y la última revisión técnica, agilizamos la recepción.';

  elsif p_tipo = 'recordatorio_7d' then
    v_asunto := 'Confirma tu hora en Curifor · ' || v_fcorta;
    v_titulo := 'Tu hora es en una semana';
    v_intro  := 'tu hora se acerca. Confírmala para reservarte el box y dejar listos los repuestos.';
    v_cta :=
      '<div style="text-align:center;margin:4px 0 8px">' ||
        '<a href="' || v_si || '" style="display:inline-block;background:#0a7d43;color:#fff;' ||
          'text-decoration:none;font-size:15px;font-weight:700;padding:14px 30px;border-radius:10px">' ||
          'Confirmar mi hora</a>' ||
      '</div>' ||
      '<div style="text-align:center;margin:13px 0 4px">' ||
        '<a href="' || v_no || '" style="color:#a8202a;font-size:13.5px;text-decoration:none;' ||
          'font-weight:600">No voy a poder ir · reagendar o cancelar</a>' ||
      '</div>';
    v_extra := 'Confirmar nos ayuda a no dejar boxes vacíos y a atender a más clientes. Si no '
            || 'confirmas, te escribimos una vez más el día antes.';

  else  -- recordatorio_24h
    v_asunto := 'Mañana es tu hora · confírmala por favor';
    v_titulo := 'Mañana te esperamos';
    v_intro  := 'tu hora es mañana. Confírmala así te reservamos el box; y si no vas a poder, '
             || 'cancélala para liberar la hora a otro cliente.';
    v_cta :=
      '<div style="text-align:center;margin:4px 0 8px">' ||
        '<a href="' || v_si || '" style="display:inline-block;background:#0a7d43;color:#fff;' ||
          'text-decoration:none;font-size:15px;font-weight:700;padding:14px 30px;border-radius:10px">' ||
          'Confirmar mi hora</a>' ||
      '</div>' ||
      '<div style="text-align:center;margin:13px 0 4px">' ||
        '<a href="' || v_no || '" style="color:#a8202a;font-size:13.5px;text-decoration:none;' ||
          'font-weight:600">No podré ir · cancelar y liberar la hora</a>' ||
      '</div>' ||
      '<div style="text-align:center;margin:14px 0 4px">' ||
        '<a href="' || v_maps || '" style="display:inline-block;margin:0 5px;padding:11px 20px;' ||
          'border-radius:10px;border:1px solid #cdd7ea;color:#001b6c;text-decoration:none;' ||
          'font-size:14px;font-weight:600">Google Maps</a>' ||
        '<a href="' || v_waze || '" style="display:inline-block;margin:0 5px;padding:11px 20px;' ||
          'border-radius:10px;border:1px solid #cdd7ea;color:#001b6c;text-decoration:none;' ||
          'font-size:14px;font-weight:600">Waze</a>' ||
      '</div>';
    v_extra := '<b>Llega 10 minutos antes.</b> Trae el permiso de circulación y, si la tienes a '
            || 'mano, la última revisión técnica.';
  end if;

  -- ======================================================
  --  Armado del correo (email-safe: tablas + estilos inline)
  -- ======================================================
  v_html :=
  '<div style="background:#eef1f8;padding:24px 12px;font-family:''Segoe UI'',Arial,Helvetica,sans-serif">' ||
  '<div style="max-width:600px;margin:0 auto">' ||
  '<div style="border:1px solid #dfe6f2;border-radius:14px;overflow:hidden;background:#fff">' ||

    -- cabecera
    '<div style="background:#001b6c;padding:22px 26px 20px;color:#fff">' ||
      '<div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9fb2ff;margin-bottom:8px">Servicio y Postventa</div>' ||
      '<div style="font-size:23px;font-weight:800;letter-spacing:2px">CURIFOR</div>' ||
    '</div>' ||

    '<div style="padding:24px 26px 8px;color:#16233a">' ||

      -- check solo en el correo de agendada
      case when p_tipo = 'agendada' then
        '<div style="width:58px;height:58px;border-radius:50%;margin:2px auto 14px;border:3px solid #0a7d43;color:#0a7d43;font-size:30px;line-height:53px;text-align:center;font-weight:700">&#10003;</div>' ||
        '<h1 style="font-size:22px;font-weight:700;color:#0d2350;margin:0 0 6px;text-align:center">' || v_titulo || '</h1>' ||
        '<p style="font-size:15px;line-height:1.55;color:#3a475f;margin:0 0 18px;text-align:center">Hola <b style="color:#16233a">' || coalesce(nullif(split_part(r.nombre,' ',1),''),'cliente') || '</b>, ' || v_intro || '</p>'
      else
        '<h1 style="font-size:22px;font-weight:700;color:#0d2350;margin:0 0 6px">' || v_titulo || '</h1>' ||
        '<p style="font-size:15px;line-height:1.55;color:#3a475f;margin:0 0 18px">Hola <b style="color:#16233a">' || coalesce(nullif(split_part(r.nombre,' ',1),''),'cliente') || '</b>, ' || v_intro || '</p>'
      end ||

      -- banda de fecha destacada (verde si es el de mañana)
      '<div style="border:1px solid #dfe6f2;border-left:5px solid ' ||
        case when p_tipo = 'recordatorio_24h' then '#0a7d43;background:#eefaf1' else '#001b6c;background:#f4f6fb' end ||
        ';border-radius:11px;padding:14px 18px;margin:0 0 20px">' ||
        '<div style="font-size:11px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:#7c8aa3;margin-bottom:3px">' ||
          case when p_tipo = 'recordatorio_24h' then 'Mañana' else 'Tu cita' end || '</div>' ||
        '<div style="font-size:19px;font-weight:700;color:#0d2350">' || v_fecha || '</div>' ||
        '<div style="font-size:15px;color:#3a475f;margin-top:3px">a las <b style="color:#0a7d43">' || v_hora || '</b></div>' ||
      '</div>' ||

      -- sección: tu servicio
      '<div style="background:#eef2fb;color:#001b6c;font-weight:700;font-size:12px;letter-spacing:.5px;text-transform:uppercase;padding:9px 14px;border-radius:8px;margin:0 0 6px">Tu servicio</div>' ||
      '<table style="width:100%;border-collapse:collapse;margin:0 0 14px;font-size:14.5px">' ||
        '<tr><td style="padding:10px 0;border-bottom:1px solid #eef1f7;color:#7c8aa3;width:40%">Servicio</td>' ||
          '<td style="padding:10px 0;border-bottom:1px solid #eef1f7;color:#16233a;font-weight:600;text-align:right">' || v_serv || '</td></tr>' ||
        '<tr><td style="padding:10px 0;color:#7c8aa3">Sucursal</td>' ||
          '<td style="padding:10px 0;color:#16233a;font-weight:600;text-align:right">' || v_suc || '</td></tr>' ||
      '</table>' ||

      -- sección: tu vehículo
      '<div style="background:#eef2fb;color:#001b6c;font-weight:700;font-size:12px;letter-spacing:.5px;text-transform:uppercase;padding:9px 14px;border-radius:8px;margin:0 0 6px">Tu vehículo</div>' ||
      '<table style="width:100%;border-collapse:collapse;margin:0 0 18px;font-size:14.5px">' ||
        '<tr><td style="padding:10px 0;border-bottom:1px solid #eef1f7;color:#7c8aa3;width:40%">Vehículo</td>' ||
          '<td style="padding:10px 0;border-bottom:1px solid #eef1f7;color:#16233a;font-weight:600;text-align:right">' || v_veh || '</td></tr>' ||
        case when r.patente is not null then
          '<tr><td style="padding:10px 0;border-bottom:1px solid #eef1f7;color:#7c8aa3">Patente</td>' ||
            '<td style="padding:10px 0;border-bottom:1px solid #eef1f7;color:#16233a;font-weight:600;text-align:right">' || upper(r.patente) || '</td></tr>'
          else '' end ||
        case when v_km is not null then
          '<tr><td style="padding:10px 0;color:#7c8aa3">Kilometraje</td>' ||
            '<td style="padding:10px 0;color:#16233a;font-weight:600;text-align:right">' || v_km || '</td></tr>'
          else '' end ||
      '</table>' ||

      -- botones (varían por tipo)
      v_cta ||

      -- tip final
      '<div style="font-size:13px;color:#5a6880;line-height:1.5;background:#f7f9fd;border-radius:10px;padding:12px 15px;margin:16px 0 4px">' || v_extra || '</div>' ||

      -- respaldo del enlace
      '<p style="font-size:11.5px;color:#9aa6bf;text-align:center;margin:14px 0 0;word-break:break-all">' ||
        'Si un botón no funciona, copia este enlace:<br>' || v_url || '</p>' ||

    '</div>' ||   -- fin cuerpo

    -- pie
    '<div style="background:#0c1a3e;color:#aeb9d4;padding:20px 26px;font-size:12.5px;line-height:1.6">' ||
      '<div style="margin-bottom:8px"><b style="color:#fff">Curifor S.A.</b> · Servicio y Postventa</div>' ||
      case when cfg.responder_a is not null or cfg.remitente is not null then
        '<div style="margin-bottom:8px">¿Dudas? Responde este correo' ||
        coalesce(' o escríbenos a ' || cfg.responder_a, '') || '.</div>'
      else '' end ||
      '<div style="border-top:1px solid #24345f;margin-top:12px;padding-top:12px;color:#8593ba;font-size:11.5px">' ||
        'Recibes este correo porque tienes una hora de servicio agendada en Curifor. Tratamos tus ' ||
        'datos solo para gestionar tu atención, conforme a la Ley 19.628 y la Ley 21.719.' ||
      '</div>' ||
    '</div>' ||

  '</div></div></div>';

  return jsonb_build_object('asunto', v_asunto, 'html', v_html,
                            'nombre', coalesce(nullif(r.nombre, ''), 'Cliente'),
                            'email', r.email);
end $$;

comment on function public.aviso_html(uuid, text) is
  'Arma asunto + HTML de cada correo al cliente. Diseño aprobado ago-2026 (marca Curifor, check, Maps/Waze, pie legal).';
