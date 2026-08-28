-- =============================================================
--  El servicio que pidió el cliente, y el kilometraje que declaró
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_agenda_servicio.sql
--
--  El flujo nuevo de agendamiento reduce la lista a cuatro servicios
--  -mantención por kilometraje, desabolladura y pintura, diagnóstico técnico
--  y garantía- y los usa para dos cosas que antes no existían: filtrar las
--  sucursales que pueden atender ese trabajo y repartir la agenda entre los
--  asesores que lo cubren.
--
--  Hasta ahora eso no se guardaba en ninguna parte: la solicitud llegaba con
--  el vehículo y la fecha, y el servicio se deducía de que trajera pauta o no.
--  Con cuatro servicios distintos esa deducción ya no alcanza.
--
--  km_declarado va aparte de km_real: uno lo escribe el cliente al agendar
--  desde su casa y el otro lo lee el asesor del tablero al recibir el auto.
--  Mezclarlos haría imposible detectar al que declaró 40.000 y llegó con
--  60.000, que es justo la diferencia que cambia qué mantención corresponde.
--
--  ADITIVO e idempotente: se puede correr sobre la base en producción.
-- =============================================================

alter table public.reservas_web
  add column if not exists servicio      text,
  add column if not exists km_declarado  integer;

comment on column public.reservas_web.servicio is
  'Servicio pedido por el cliente: mantencion | dip | diagnostico | garantia. Ver js/agenda-servicios.js, que define la lista y qué sucursal atiende cada uno.';
comment on column public.reservas_web.km_declarado is
  'Kilometraje que declaró el cliente AL AGENDAR. Distinto de km_real, que es el que lee el asesor del tablero al recibir el vehículo; la diferencia entre ambos es la que delata una mantención mal elegida.';
