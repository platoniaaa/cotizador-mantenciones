-- =============================================================
-- FLUJO UNIFICADO de los 3 módulos (Cotizador → Agenda → Recepción)
-- Extiende reservas_web (creada por setup_supabase_reservas.sql) para que
-- sea la tabla central del flujo, compartida entre estaciones vía Supabase.
-- ADITIVO e idempotente: no rompe el INSERT del cliente ni las policies previas.
--
-- Ciclo de vida (columna estado):
--   nueva      -> solicitud del cliente web, pendiente de confirmar
--   agendada   -> el taller (o el cotizador interno) la confirma con fecha/hora
--   recibida   -> recepción registró la llegada del vehículo (por patente)
--   en_taller  -> se generó la orden de trabajo (ro)
--   cerrada    -> trabajo terminado / entregado
--   rechazada / cancelada -> descartada
-- =============================================================

-- 1) Columnas nuevas del flujo (todas opcionales -> el INSERT anon sigue igual)
alter table public.reservas_web
  add column if not exists rut         text,           -- rut del cliente (llave a clientes)
  add column if not exists valor       numeric,        -- monto de la cotización
  add column if not exists asesor      text,           -- quién gestiona en el taller
  add column if not exists sucursal    text,           -- para las 8 sucursales
  add column if not exists origen      text default 'cliente_web',  -- cliente_web | cotizador_interno | taller
  add column if not exists ro          text,           -- nº de orden de trabajo al entrar a taller
  add column if not exists vin         text,           -- del vehículo (autocompletado)
  add column if not exists actualizado timestamptz default now();

-- 2) Índices para las búsquedas del flujo (recepción por patente, bandeja por estado)
create index if not exists idx_reservas_web_patente on public.reservas_web (patente);
create index if not exists idx_reservas_web_estado  on public.reservas_web (estado);
create index if not exists idx_reservas_web_fecha   on public.reservas_web (fecha);

-- 3) Trigger para mantener 'actualizado' al día en cada cambio
create or replace function public.reservas_web_touch()
returns trigger language plpgsql as $$
begin
  new.actualizado := now();
  return new;
end $$;
drop trigger if exists trg_reservas_web_touch on public.reservas_web;
create trigger trg_reservas_web_touch before update on public.reservas_web
  for each row execute function public.reservas_web_touch();

-- 4) Policies de GESTIÓN para el personal @curifor.com (faltaban UPDATE/INSERT/DELETE).
--    Mismo patrón de dominio que la SELECT existente.
drop policy if exists reservas_web_insert_staff on public.reservas_web;
create policy reservas_web_insert_staff on public.reservas_web
  for insert to authenticated
  with check ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists reservas_web_update_staff on public.reservas_web;
create policy reservas_web_update_staff on public.reservas_web
  for update to authenticated
  using      ( lower(auth.jwt() ->> 'email') like '%@curifor.com' )
  with check ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists reservas_web_delete_staff on public.reservas_web;
create policy reservas_web_delete_staff on public.reservas_web
  for delete to authenticated
  using ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );
