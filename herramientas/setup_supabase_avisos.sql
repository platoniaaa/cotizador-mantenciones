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
