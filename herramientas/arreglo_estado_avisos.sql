-- ============================================================
--  ARREGLO 2 · el comprobante nunca se habria enviado
--
--  Sintoma: se agenda una hora y el sistema dice "No hay avisos pendientes".
--
--  Causa: la reserva se guarda con estado 'nueva' (es el valor por defecto de
--  la columna, y el formulario no manda ninguno), pero avisos_pendientes()
--  solo miraba las que estaban en 'agendada'. Ninguna calificaba nunca.
--
--  Se corrige la funcion para que valga cualquiera de los dos estados. Antes
--  habia un paso intermedio en que el taller confirmaba la hora; hoy el cliente
--  elige fecha, hora y sucursal el mismo, asi que la reserva ya nace agendada
--  aunque la columna diga 'nueva'.
-- ============================================================

create or replace function public.avisos_pendientes()
returns table (reserva_id uuid, tipo text, destinatario text)
language sql stable security definer set search_path = public as $$
  with base as (
    select r.id, r.email, r.fecha, r.hora, r.estado, r.creado_en, r.confirmado_en,
           (r.fecha + coalesce(nullif(r.hora, 'indiferente'), '09:00')::time)
             at time zone 'America/Santiago' as cuando
      from public.reservas_web r
     where r.email is not null and r.email <> ''
       and r.estado in ('nueva', 'agendada')
  )
  -- 1. recién agendada (cualquiera de los dos estados: la reserva ya existe)
  select b.id, 'agendada'::text, b.email from base b
   where b.cuando > now()
     and not exists (select 1 from public.avisos_enviados a
                      where a.reserva_id = b.id and a.tipo = 'agendada')
  union all
  -- 2. siete días antes (ventana de 24 h)
  select b.id, 'recordatorio_7d'::text, b.email from base b
   where b.cuando - now() between interval '6 days' and interval '7 days'
     and b.confirmado_en is null
     and not exists (select 1 from public.avisos_enviados a
                      where a.reserva_id = b.id and a.tipo = 'recordatorio_7d')
  union all
  -- 3. veinticuatro horas antes, SOLO si no confirmó
  select b.id, 'recordatorio_24h'::text, b.email from base b
   where b.cuando - now() between interval '20 hours' and interval '28 hours'
     and b.confirmado_en is null
     and not exists (select 1 from public.avisos_enviados a
                      where a.reserva_id = b.id and a.tipo = 'recordatorio_24h')
$$;

revoke all on function public.avisos_pendientes() from public, anon, authenticated;
grant execute on function public.avisos_pendientes() to service_role;

-- ------------------------------------------------------------
--  Las reservas que YA existen no deben recibir un comprobante atrasado.
--  Alguien que agendó hace semanas no entenderia por que le llega hoy el
--  "tu hora quedo agendada". Se marcan como omitidas: los RECORDATORIOS de
--  esas mismas citas si van a salir, que es lo util.
-- ------------------------------------------------------------
insert into public.avisos_enviados (reserva_id, tipo, destinatario, estado, detalle)
select r.id, 'agendada', r.email, 'omitido', 'reserva anterior al arreglo del 24-09'
  from public.reservas_web r
 where r.estado in ('nueva', 'agendada')
   and r.email is not null and r.email <> ''
   and not exists (select 1 from public.avisos_enviados a
                    where a.reserva_id = r.id and a.tipo = 'agendada')
on conflict (reserva_id, tipo) do nothing;

-- Limpieza de las reservas que cree probando.
delete from public.reservas_web where patente in ('ZZTEST9', 'ZZFINAL9');

-- Comprobacion: cuantos avisos quedan en cola (deberia ser 0 o muy pocos).
select tipo, count(*) as en_cola
  from public.avisos_pendientes()
 group by tipo;
