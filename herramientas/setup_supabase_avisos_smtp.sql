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
