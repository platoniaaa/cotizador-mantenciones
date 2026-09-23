-- ============================================================
--  TODO EL SISTEMA DE CORREOS, EN UN SOLO ARCHIVO
--
--  Pegar completo en el editor SQL de Supabase y ejecutar.
--  Es seguro repetirlo: todo es 'if not exists' o 'create or replace'.
--
--  Junta, en este orden:
--    1. setup_supabase_avisos.sql           el motor y las tablas
--    2. setup_supabase_avisos_plantilla.sql el diseno aprobado del correo
--    3. setup_supabase_avisos_smtp.sql      el envio desde GitHub Actions
--
--  Queda APAGADO: al final hay que hacer
--    update public.avisos_config set activo = true;
-- ============================================================


-- ==================== setup_supabase_avisos.sql ====================

-- ============================================================
--  Avisos por correo al cliente
--
--  Tres correos, sin que nadie apriete un botón:
--    1. al agendar         → "quedaste agendado"
--    2. 7 días antes       → "confirma tu hora"
--    3. 24 horas antes     → SOLO si no confirmó
--
--  Todo corre DENTRO de Supabase: pg_cron dispara cada 5 minutos y pg_net
--  llama a Brevo. No hace falta un servidor aparte ni que nadie deje un PC
--  encendido.
--
--  DECISIONES QUE SOSTIENEN ESTO
--  -----------------------------
--  · Se registra cada envío ANTES de mandarlo. Si el proceso se cae a la
--    mitad, el peor caso es un correo que no salió — nunca uno repetido. Al
--    cliente le molesta más recibir cuatro recordatorios que ninguno.
--  · El enlace de confirmar/cancelar lleva un token aleatorio por cita. No se
--    puede adivinar el de otro cliente ni recorrer las citas cambiando un
--    número.
--  · La clave de Brevo vive en Vault, no en este archivo ni en el repo.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos.sql
-- ============================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;


-- ------------------------------------------------------------
-- 1) Configuración: de dónde salen los correos y a dónde apunta
--    el enlace de confirmación.
-- ------------------------------------------------------------
create table if not exists public.avisos_config (
  id             boolean primary key default true check (id),
  remitente      text not null default 'agenda@curifor.com',
  remitente_nom  text not null default 'Curifor Post Venta',
  responder_a    text,
  url_confirmar  text not null default 'https://platoniaaa.github.io/cotizador-mantenciones/confirmar.html',
  activo         boolean not null default false,   -- se enciende cuando esté probado
  copia_interna  text,                             -- opcional: copia a una casilla del taller
  actualizado    timestamptz not null default now()
);

insert into public.avisos_config (id) values (true) on conflict (id) do nothing;

alter table public.avisos_config enable row level security;
drop policy if exists avisos_config_select on public.avisos_config;
create policy avisos_config_select on public.avisos_config
  for select to authenticated using (public.es_personal_curifor());

comment on table public.avisos_config is
  'Configuracion de los avisos por correo. `activo` en false deja todo el sistema apagado sin desinstalar nada.';


-- ------------------------------------------------------------
-- 2) Bitácora de envíos.
--    La clave (reserva, tipo) es lo que hace imposible mandar dos
--    veces el mismo aviso, incluso si el cron se solapa consigo mismo.
-- ------------------------------------------------------------
create table if not exists public.avisos_enviados (
  id          bigint generated always as identity primary key,
  reserva_id  uuid not null references public.reservas_web(id) on delete cascade,
  tipo        text not null check (tipo in ('agendada', 'recordatorio_7d', 'recordatorio_24h')),
  destinatario text,
  creado_en   timestamptz not null default now(),
  enviado_en  timestamptz,
  estado      text not null default 'pendiente'
              check (estado in ('pendiente', 'enviado', 'error', 'omitido')),
  detalle     text,
  request_id  bigint,                              -- id de la llamada de pg_net
  unique (reserva_id, tipo)
);

create index if not exists avisos_enviados_estado_idx on public.avisos_enviados (estado, creado_en);

alter table public.avisos_enviados enable row level security;
drop policy if exists avisos_enviados_select on public.avisos_enviados;
create policy avisos_enviados_select on public.avisos_enviados
  for select to authenticated using (public.es_personal_curifor());


-- ------------------------------------------------------------
-- 3) La cita necesita saber si el cliente confirmó, y un token
--    para el enlace del correo.
-- ------------------------------------------------------------
alter table public.reservas_web
  add column if not exists confirmado_en   timestamptz,
  add column if not exists confirmado_por  text,          -- 'cliente' o el correo del asesor
  add column if not exists token_aviso     text;

-- Token aleatorio por cita. `gen_random_bytes` viene de pgcrypto, ya instalada.
create or replace function public.avisos_token()
returns text language sql volatile as $$
  select replace(replace(encode(gen_random_bytes(24), 'base64'), '/', '_'), '+', '-')
$$;

create index if not exists reservas_web_token_idx on public.reservas_web (token_aviso);

-- A las citas que ya existen se les asigna uno.
update public.reservas_web set token_aviso = public.avisos_token()
 where token_aviso is null;

-- Y a las nuevas, al momento de crearse.
create or replace function public.reservas_web_token()
returns trigger language plpgsql as $$
begin
  if new.token_aviso is null then
    new.token_aviso := public.avisos_token();
  end if;
  return new;
end $$;

drop trigger if exists reservas_web_token on public.reservas_web;
create trigger reservas_web_token
  before insert on public.reservas_web
  for each row execute function public.reservas_web_token();


-- ------------------------------------------------------------
-- 4) Qué avisos corresponde mandar AHORA.
--
--    Las ventanas son anchas a propósito (no "exactamente 7 días"): si el cron
--    se salta una vuelta por una caída, el aviso igual sale en la siguiente en
--    vez de perderse para siempre.
-- ------------------------------------------------------------
create or replace function public.avisos_pendientes()
returns table (reserva_id uuid, tipo text, destinatario text)
language sql stable security definer set search_path = public as $$
  with base as (
    select r.id, r.email, r.fecha, r.hora, r.estado, r.creado_en, r.confirmado_en,
           -- momento de la cita en hora de Chile
           (r.fecha + coalesce(nullif(r.hora, 'indiferente'), '09:00')::time)
             at time zone 'America/Santiago' as cuando
      from public.reservas_web r
     where r.email is not null and r.email <> ''
       and r.estado in ('nueva', 'agendada')
  )
  -- 1. recién agendada
  select b.id, 'agendada'::text, b.email from base b
   where b.estado = 'agendada'
     and b.cuando > now()
     and not exists (select 1 from public.avisos_enviados a
                      where a.reserva_id = b.id and a.tipo = 'agendada')
  union all
  -- 2. siete días antes (ventana de 24 h)
  select b.id, 'recordatorio_7d'::text, b.email from base b
   where b.estado = 'agendada'
     and b.cuando - now() between interval '6 days' and interval '7 days'
     and b.confirmado_en is null
     and not exists (select 1 from public.avisos_enviados a
                      where a.reserva_id = b.id and a.tipo = 'recordatorio_7d')
  union all
  -- 3. veinticuatro horas antes, SOLO si no confirmó
  select b.id, 'recordatorio_24h'::text, b.email from base b
   where b.estado = 'agendada'
     and b.cuando - now() between interval '20 hours' and interval '28 hours'
     and b.confirmado_en is null
     and not exists (select 1 from public.avisos_enviados a
                      where a.reserva_id = b.id and a.tipo = 'recordatorio_24h')
$$;


-- ------------------------------------------------------------
-- 5) El texto del correo.
--    Se arma en la base para que el asunto y el cuerpo no dependan
--    de qué versión del sitio esté publicada.
-- ------------------------------------------------------------
create or replace function public.aviso_html(p_reserva uuid, p_tipo text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  r     record;
  cfg   record;
  v_url text;
  v_fecha text;
  v_titulo text;
  v_intro text;
  v_html text;
  v_asunto text;
  MESES text[] := array['enero','febrero','marzo','abril','mayo','junio','julio',
                        'agosto','septiembre','octubre','noviembre','diciembre'];
begin
  select * into r from public.reservas_web where id = p_reserva;
  if not found then return null; end if;
  select * into cfg from public.avisos_config where id;

  v_fecha := to_char(r.fecha, 'DD') || ' de ' || MESES[extract(month from r.fecha)::int] ||
             ' de ' || to_char(r.fecha, 'YYYY');
  v_url := cfg.url_confirmar || '?t=' || r.token_aviso;

  if p_tipo = 'agendada' then
    v_asunto := 'Tu hora en Curifor quedó agendada · ' || v_fecha;
    v_titulo := 'Tu hora quedó agendada';
    v_intro  := 'Registramos tu hora. Si algo no calza o necesitas cambiarla, avísanos con el botón de abajo.';
  elsif p_tipo = 'recordatorio_7d' then
    v_asunto := 'Confirma tu hora en Curifor · ' || v_fecha;
    v_titulo := 'Tu hora es en una semana';
    v_intro  := 'Para reservarte el espacio y tener listos los repuestos, necesitamos que confirmes.';
  else
    v_asunto := 'Mañana es tu hora en Curifor · confirma por favor';
    v_titulo := 'Tu hora es mañana';
    v_intro  := 'No alcanzamos a recibir tu confirmación. Si no vas a poder venir, cancélala y liberamos la hora para otro cliente.';
  end if;

  v_html :=
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#16324f">' ||
      '<div style="background:#0d2f5a;color:#fff;padding:18px 22px;border-radius:12px 12px 0 0">' ||
        '<div style="font-size:13px;opacity:.85;letter-spacing:1px">CURIFOR POST VENTA</div>' ||
        '<h1 style="margin:6px 0 0;font-size:21px">' || v_titulo || '</h1>' ||
      '</div>' ||
      '<div style="border:1px solid #d7dee8;border-top:0;border-radius:0 0 12px 12px;padding:22px">' ||
        '<p style="margin:0 0 16px;font-size:15px;line-height:1.5">Hola ' ||
          coalesce(nullif(r.nombre, ''), 'cliente') || ',<br>' || v_intro || '</p>' ||
        '<table style="width:100%;font-size:14px;border-collapse:collapse;margin-bottom:18px">' ||
          '<tr><td style="padding:7px 0;color:#789">Fecha</td><td style="padding:7px 0;font-weight:bold">' || v_fecha || '</td></tr>' ||
          '<tr><td style="padding:7px 0;color:#789">Hora</td><td style="padding:7px 0;font-weight:bold">' ||
            coalesce(nullif(r.hora, 'indiferente'), 'por confirmar') || '</td></tr>' ||
          '<tr><td style="padding:7px 0;color:#789">Sucursal</td><td style="padding:7px 0;font-weight:bold">' ||
            coalesce(r.sucursal, 'por confirmar') || '</td></tr>' ||
          case when r.patente is not null then
          '<tr><td style="padding:7px 0;color:#789">Vehículo</td><td style="padding:7px 0;font-weight:bold">' ||
            coalesce(r.patente, '') || coalesce(' · ' || nullif(concat_ws(' ', r.marca, r.modelo), ''), '') || '</td></tr>'
          else '' end ||
        '</table>' ||
        '<div style="text-align:center;margin:22px 0">' ||
          '<a href="' || v_url || '&a=si" style="display:inline-block;background:#14663a;color:#fff;' ||
            'text-decoration:none;padding:13px 26px;border-radius:8px;font-weight:bold;font-size:15px">Confirmar mi hora</a>' ||
          '<div style="margin-top:12px"><a href="' || v_url || '&a=no" ' ||
            'style="color:#a8202a;font-size:13px">No voy a poder ir · cancelar</a></div>' ||
        '</div>' ||
        '<p style="margin:16px 0 0;font-size:12px;color:#789;line-height:1.5;border-top:1px solid #eef1f5;padding-top:14px">' ||
          'Si el botón no funciona, copia este enlace:<br>' || v_url ||
        '</p>' ||
      '</div>' ||
    '</div>';

  return jsonb_build_object('asunto', v_asunto, 'html', v_html,
                            'nombre', coalesce(nullif(r.nombre, ''), 'Cliente'),
                            'email', r.email);
end $$;


-- ------------------------------------------------------------
-- 6) El envío.
--
--    Se anota PRIMERO y se manda después: si algo revienta en el medio, queda
--    un aviso marcado como enviado que no salió. Es el error correcto — el
--    contrario (mandar y no anotar) genera correos repetidos cada 5 minutos.
-- ------------------------------------------------------------
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

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'BREVO_API_KEY';
  if v_key is null or v_key = '' then
    return jsonb_build_object('ok', false, 'motivo', 'falta BREVO_API_KEY en Vault');
  end if;

  for p in select * from public.avisos_pendientes() limit p_limite loop
    -- Reserva el envío. El unique(reserva_id, tipo) es lo que impide que dos
    -- vueltas del cron solapadas manden el mismo correo dos veces.
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
      url := 'https://api.brevo.com/v3/smtp/email',
      headers := jsonb_build_object('api-key', v_key, 'Content-Type', 'application/json',
                                    'accept', 'application/json'),
      body := jsonb_build_object(
        'sender', jsonb_build_object('email', cfg.remitente, 'name', cfg.remitente_nom),
        'to', jsonb_build_array(jsonb_build_object('email', cuerpo->>'email',
                                                   'name', cuerpo->>'nombre')),
        'subject', cuerpo->>'asunto',
        'htmlContent', cuerpo->>'html',
        'tags', jsonb_build_array('curifor', p.tipo)
      ) ||
      case when cfg.responder_a is not null
           then jsonb_build_object('replyTo', jsonb_build_object('email', cfg.responder_a))
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


-- ------------------------------------------------------------
-- 7) Revisar cómo le fue a cada envío.
--    pg_net responde asincrónico: el resultado llega después. Sin esto, un
--    correo rechazado por Brevo quedaría marcado como enviado para siempre.
-- ------------------------------------------------------------
create or replace function public.avisos_revisar()
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  a       record;
  resp    record;
  n_fall  int := 0;
begin
  for a in select * from public.avisos_enviados
            where estado = 'enviado' and request_id is not null
              and detalle is null and enviado_en > now() - interval '2 days' loop
    select status_code, content into resp
      from net._http_response where id = a.request_id;
    if not found then continue; end if;

    if resp.status_code between 200 and 299 then
      update public.avisos_enviados set detalle = 'ok' where id = a.id;
    else
      update public.avisos_enviados
         set estado = 'error',
             detalle = 'HTTP ' || resp.status_code || ' · ' || left(coalesce(resp.content, ''), 200)
       where id = a.id;
      n_fall := n_fall + 1;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'fallidos', n_fall);
end $$;


-- ------------------------------------------------------------
-- 8) Lo que hace el cliente con el enlace del correo.
--    Sin sesión: el token ES la credencial. Por eso es aleatorio de 24 bytes
--    y va por cita, no por cliente.
-- ------------------------------------------------------------
create or replace function public.cita_por_token(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  if p_token is null or length(p_token) < 20 then
    return jsonb_build_object('ok', false, 'motivo', 'enlace_invalido');
  end if;
  select * into r from public.reservas_web where token_aviso = p_token;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'enlace_invalido');
  end if;
  -- Se devuelve lo justo para que el cliente reconozca SU cita. Nada de RUT,
  -- teléfono ni correo: el enlace puede terminar reenviado a cualquiera.
  return jsonb_build_object('ok', true,
    'fecha', r.fecha, 'hora', nullif(r.hora, 'indiferente'),
    'sucursal', r.sucursal, 'patente', r.patente,
    'vehiculo', nullif(concat_ws(' ', r.marca, r.modelo), ''),
    'nombre', split_part(coalesce(r.nombre, ''), ' ', 1),
    'estado', r.estado,
    'confirmada', r.confirmado_en is not null,
    'pasada', (r.fecha + coalesce(nullif(r.hora,'indiferente'),'09:00')::time)
              at time zone 'America/Santiago' < now());
end $$;

create or replace function public.cita_confirmar(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.reservas_web where token_aviso = p_token;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'enlace_invalido'); end if;
  if r.estado not in ('nueva', 'agendada') then
    return jsonb_build_object('ok', false, 'motivo', 'no_confirmable', 'estado', r.estado);
  end if;
  update public.reservas_web
     set confirmado_en = coalesce(confirmado_en, now()), confirmado_por = 'cliente'
   where id = r.id;
  return jsonb_build_object('ok', true, 'accion', 'confirmada');
end $$;

create or replace function public.cita_cancelar(p_token text, p_motivo text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record;
begin
  select * into r from public.reservas_web where token_aviso = p_token;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'enlace_invalido'); end if;
  if r.estado not in ('nueva', 'agendada') then
    return jsonb_build_object('ok', false, 'motivo', 'no_cancelable', 'estado', r.estado);
  end if;
  -- Se MARCA, no se borra: la agenda necesita enterarse de que se cayó, y con
  -- quién y cuándo. Borrarla la haría desaparecer sin explicación.
  update public.reservas_web
     set estado = 'cancelada', cancelado_en = now(),
         cancelado_por = 'cliente' || coalesce(' · ' || left(p_motivo, 200), '')
   where id = r.id;
  return jsonb_build_object('ok', true, 'accion', 'cancelada');
end $$;

-- El cliente no tiene sesión: estas tres las puede llamar cualquiera, y la
-- seguridad está en que el token no se puede adivinar.
revoke all on function public.cita_por_token(text) from public;
revoke all on function public.cita_confirmar(text) from public;
revoke all on function public.cita_cancelar(text, text) from public;
grant execute on function public.cita_por_token(text) to anon, authenticated;
grant execute on function public.cita_confirmar(text) to anon, authenticated;
grant execute on function public.cita_cancelar(text, text) to anon, authenticated;

-- Las de despacho NO: solo las llama el cron, que corre como superusuario.
revoke all on function public.avisos_despachar(int) from public, anon, authenticated;
revoke all on function public.avisos_revisar() from public, anon, authenticated;
revoke all on function public.avisos_pendientes() from public, anon, authenticated;


-- ------------------------------------------------------------
-- 9) El reloj.
--    Cada 5 minutos busca y manda; cada 15 revisa cómo les fue.
-- ------------------------------------------------------------
select cron.unschedule('curifor_avisos_enviar')
 where exists (select 1 from cron.job where jobname = 'curifor_avisos_enviar');
select cron.schedule('curifor_avisos_enviar', '*/5 * * * *',
                     $cron$ select public.avisos_despachar(25) $cron$);

select cron.unschedule('curifor_avisos_revisar')
 where exists (select 1 from cron.job where jobname = 'curifor_avisos_revisar');
select cron.schedule('curifor_avisos_revisar', '*/15 * * * *',
                     $cron$ select public.avisos_revisar() $cron$);


-- ==================== setup_supabase_avisos_plantilla.sql ====================

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


-- ==================== setup_supabase_avisos_smtp.sql ====================

-- =============================================================
--  Avisos por correo: envío desde GitHub Actions por SMTP
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos_smtp.sql
--
--  POR QUÉ ASÍ
--  -----------
--  El envío NO puede salir desde Supabase: Deno Deploy (donde corren las Edge
--  Functions) no permite conexiones salientes por los puertos 25 y 587, y el
--  servidor de correo que entregó TI (smtp14.mycloudmailbox.com) solo tiene
--  abierto el 587 —probado: 465, 25 y 2525 no responden—. Tampoco sirve Graph:
--  TI no autorizó el permiso Mail.Send en Entra.
--
--  Entonces el correo lo manda un script que corre en GitHub Actions, que sí
--  alcanza el puerto 587. Este archivo deja en la base lo que ese script
--  necesita, y nada más.
--
--  QUÉ SE REUTILIZA: avisos_config, avisos_enviados, avisos_pendientes y
--  aviso_html siguen igual. Solo cambia QUIÉN entrega el correo.
--
--  LOS DOS CORREOS DISTINTOS
--    · "agendada"        -> sale en ~30 s, porque el trigger de abajo le avisa
--                           a GitHub apenas se crea la reserva.
--    · los recordatorios -> salen con el reloj de GitHub (cada 15 min).
-- =============================================================

create extension if not exists pg_net;


-- ---------------------------------------------------------------
-- 1 · El cron viejo se apaga.
--
--    avisos_despachar() entregaba el correo con pg_net (Brevo/Resend/Graph).
--    Si quedara programado, al encender avisos_config.activo mandaría los
--    mismos correos que manda GitHub: el cliente recibiría todo dos veces.
-- ---------------------------------------------------------------
do $$
begin
  if exists (select 1 from cron.job where jobname = 'curifor_avisos_enviar') then
    perform cron.unschedule('curifor_avisos_enviar');
  end if;
  if exists (select 1 from cron.job where jobname = 'curifor_avisos_revisar') then
    perform cron.unschedule('curifor_avisos_revisar');
  end if;
exception when others then
  null;   -- si pg_cron no está, no hay nada que apagar
end $$;


-- ---------------------------------------------------------------
-- 2 · Tomar los avisos que tocan, y reservarlos en el mismo acto.
--
--    Devuelve el correo LISTO (asunto y html ya armados) para que el script
--    solo tenga que entregarlo. La reserva y el armado ocurren dentro de una
--    misma transacción: si dos corridas de GitHub se solapan —el reloj y el
--    disparo inmediato pueden coincidir—, el unique(reserva_id, tipo) deja
--    pasar una sola. Es lo que impide el correo repetido.
-- ---------------------------------------------------------------
create or replace function public.avisos_tomar(p_limite int default 25)
returns table (
  reserva_id uuid,
  tipo       text,
  email      text,
  nombre     text,
  asunto     text,
  html       text
)
language plpgsql security definer set search_path = public as $$
declare
  cfg    record;
  p      record;
  cuerpo jsonb;
begin
  select * into cfg from public.avisos_config where id;
  if not found or not cfg.activo then
    return;                      -- sistema apagado: no devuelve nada
  end if;

  for p in select * from public.avisos_pendientes() limit p_limite loop
    -- Reserva el envío. Si otra corrida ya lo tomó, se salta.
    begin
      insert into public.avisos_enviados (reserva_id, tipo, destinatario, estado)
           values (p.reserva_id, p.tipo, p.destinatario, 'pendiente');
    exception when unique_violation then
      continue;
    end;

    cuerpo := public.aviso_html(p.reserva_id, p.tipo);
    if cuerpo is null or coalesce(cuerpo->>'email', '') = '' then
      update public.avisos_enviados
         set estado = 'error', detalle = 'sin correo o no se pudo armar'
       where avisos_enviados.reserva_id = p.reserva_id
         and avisos_enviados.tipo = p.tipo;
      continue;
    end if;

    reserva_id := p.reserva_id;
    tipo       := p.tipo;
    email      := cuerpo->>'email';
    nombre     := cuerpo->>'nombre';
    asunto     := cuerpo->>'asunto';
    html       := cuerpo->>'html';
    return next;
  end loop;
end $$;


-- ---------------------------------------------------------------
-- 3 · Anotar cómo le fue a cada envío.
--
--    Un correo que falló queda como 'error' y NO se reintenta solo: si el
--    servidor rechaza, reintentar cada 15 minutos solo multiplica el problema.
--    Queda anotado para revisarlo a mano.
-- ---------------------------------------------------------------
create or replace function public.avisos_marcar(
  p_reserva uuid,
  p_tipo    text,
  p_ok      boolean,
  p_detalle text default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.avisos_enviados
     set estado     = case when p_ok then 'enviado' else 'error' end,
         enviado_en = case when p_ok then now() else enviado_en end,
         detalle    = left(coalesce(p_detalle, case when p_ok then 'ok' end), 300)
   where reserva_id = p_reserva and tipo = p_tipo;
end $$;


-- ---------------------------------------------------------------
-- 4 · Permisos: solo el script (service_role) puede usarlas.
--
--    Nunca anon ni authenticated: aviso_html arma el correo con el token de
--    confirmación de la cita, y eso no puede quedar al alcance del navegador.
-- ---------------------------------------------------------------
revoke all on function public.avisos_tomar(int)                     from public, anon, authenticated;
revoke all on function public.avisos_marcar(uuid, text, boolean, text) from public, anon, authenticated;
grant execute on function public.avisos_tomar(int)                     to service_role;
grant execute on function public.avisos_marcar(uuid, text, boolean, text) to service_role;
grant execute on function public.avisos_pendientes()                   to service_role;
grant execute on function public.aviso_html(uuid, text)                to service_role;


-- ---------------------------------------------------------------
-- 5 · El disparo inmediato.
--
--    Apenas se crea una reserva, se le avisa a GitHub para que arranque el
--    envío sin esperar al reloj. El correo sale en ~30 s en vez de hasta 15
--    minutos.
--
--    REGLA: esto NUNCA puede voltear el agendamiento. Si falta el token, si
--    GitHub responde mal o si se cae la red, la reserva se guarda igual y el
--    correo sale después con el reloj. Por eso todo va dentro de un exception
--    que se traga cualquier error.
--
--    Requiere en Vault:
--      GITHUB_DISPATCH_TOKEN -> token fino con permiso Contents: read/write
--      GITHUB_REPO           -> "platoniaaa/cotizador-mantenciones"
-- ---------------------------------------------------------------
create or replace function public.avisos_disparar_github()
returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare
  v_token text;
  v_repo  text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'GITHUB_DISPATCH_TOKEN';
  select decrypted_secret into v_repo  from vault.decrypted_secrets where name = 'GITHUB_REPO';
  if v_token is null or v_repo is null then
    return new;                   -- sin configurar: el reloj se encarga
  end if;

  perform net.http_post(
    url     := 'https://api.github.com/repos/' || v_repo || '/dispatches',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_token,
                 'Accept',        'application/vnd.github+json',
                 'Content-Type',  'application/json',
                 'User-Agent',    'curifor-agenda'),
    body    := jsonb_build_object('event_type', 'aviso_nuevo'),
    timeout_milliseconds := 5000);

  return new;
exception when others then
  return new;                     -- jamás romper el agendamiento por un aviso
end $$;

drop trigger if exists reservas_web_avisar on public.reservas_web;
create trigger reservas_web_avisar
  after insert on public.reservas_web
  for each row execute function public.avisos_disparar_github();


-- ---------------------------------------------------------------
-- 6 · Encender (dejar para el final, después de la prueba)
-- ---------------------------------------------------------------
-- update public.avisos_config set activo = true;
--
-- Para apagar todo sin desinstalar nada:
-- update public.avisos_config set activo = false;
