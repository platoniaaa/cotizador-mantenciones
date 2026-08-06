-- =============================================================
-- ACTA DE RECEPCIÓN + ARCHIVO HISTÓRICO DEL TALLER
--
-- Cubre tres agujeros detectados en la revisión del 06-ago-2026:
--
-- 1) El acta de recepción no guardaba nada más que fotos y firmas. Los
--    accesorios que el asesor marca, el nivel de combustible, el kilometraje
--    REAL de llegada y las observaciones se perdían al cerrar el formulario.
--    Es justo lo que respalda al taller si el cliente reclama. Van como
--    columnas de reservas_web, que es la fila que ya viaja entre estaciones.
--
-- 2) No había una sola marca de tiempo real: no se sabía a qué hora llegó el
--    auto (se mostraba la hora de la CITA), quién lo recibió ni quién lo
--    entregó. Se agregan los sellos y el responsable de cada hito.
--
-- 3) La bandeja compartida (taller_estado) es un único documento JSON que
--    viaja entero en cada guardado y solo crece. Con un año de operación
--    reventaría el tope de localStorage (~5 MB) y cada sync mandaría un
--    archivo enorme. taller_archivo saca de la bandeja lo que ya está
--    cerrado, UNA FILA POR ENTIDAD (no un bloque), y lo conserva para
--    siempre. La bandeja queda acotada a lo que está vivo.
--
-- ADITIVO e idempotente: se puede correr sobre la base en producción.
-- =============================================================

-- ---------------------------------------------------------------
-- 1 · ACTA DE RECEPCIÓN — columnas nuevas en reservas_web
-- ---------------------------------------------------------------
alter table public.reservas_web
  add column if not exists acc            jsonb,
  add column if not exists comb           text,
  add column if not exists km_real        integer,
  add column if not exists obs            text,
  add column if not exists oc             bigint,
  add column if not exists recibido_en    timestamptz,
  add column if not exists recibido_por   text,
  add column if not exists entregado_en   timestamptz,
  add column if not exists entregado_por  text;

comment on column public.reservas_web.acc is
  'Checklist de accesorios del acta: {"Gata": true, "Extintor": false, ...}. Lo que el asesor marcó al recibir.';
comment on column public.reservas_web.comb is
  'Nivel de combustible al recibir: 1 | 3/4 | 1/2 | 1/4 | 0.';
comment on column public.reservas_web.km_real is
  'Kilometraje REAL leído del tablero al recibir. Distinto de km, que es el estimado de la cita.';
comment on column public.reservas_web.obs is
  'Observaciones del asesor al recibir (daños previos, faltantes, lo que declara el cliente).';
comment on column public.reservas_web.recibido_en is
  'Hora real de llegada del vehículo. NO es la hora de la cita: esa es `hora`.';

-- ---------------------------------------------------------------
-- 2 · ARCHIVO HISTÓRICO — una fila por cita y por orden
-- ---------------------------------------------------------------
create table if not exists public.taller_archivo (
  uid            text        primary key,
  sucursal       text        not null,
  tipo           text        not null check (tipo in ('agendamiento', 'orden')),
  ref            text,
  fecha          date,
  patente        text,
  data           jsonb       not null,
  archivado_en   timestamptz not null default now(),
  archivado_por  text
);

comment on table public.taller_archivo is
  'Historia del taller, una fila por entidad. La bandeja (taller_estado) guarda solo lo vivo; lo cerrado se mueve acá y no vuelve.';
comment on column public.taller_archivo.uid is
  'Identidad estable de la entidad, la misma que usa la fusión de la bandeja. Evita archivar dos veces.';
comment on column public.taller_archivo.ref is
  'Número visible: OC para agendamientos, RO para órdenes. Para buscar sin abrir el jsonb.';

create index if not exists taller_archivo_suc_fecha_idx on public.taller_archivo (sucursal, fecha desc);
create index if not exists taller_archivo_patente_idx   on public.taller_archivo (patente);
create index if not exists taller_archivo_ref_idx       on public.taller_archivo (ref);

-- Sello de auditoría: quién archivó.
create or replace function public.taller_archivo_touch()
returns trigger language plpgsql as $$
begin
  new.archivado_en  := coalesce(new.archivado_en, now());
  new.archivado_por := coalesce(auth.jwt() ->> 'email', new.archivado_por);
  return new;
end $$;

drop trigger if exists trg_taller_archivo_touch on public.taller_archivo;
create trigger trg_taller_archivo_touch before insert or update on public.taller_archivo
  for each row execute function public.taller_archivo_touch();

-- ---- RLS: solo el personal @curifor.com, igual que taller_estado ----
alter table public.taller_archivo enable row level security;

drop policy if exists taller_archivo_select_staff on public.taller_archivo;
create policy taller_archivo_select_staff on public.taller_archivo
  for select to authenticated
  using ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists taller_archivo_insert_staff on public.taller_archivo;
create policy taller_archivo_insert_staff on public.taller_archivo
  for insert to authenticated
  with check ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

-- El archivo se re-escribe (upsert) para tolerar reintentos, pero nunca se
-- borra desde el navegador: no hay policy de DELETE a propósito.
drop policy if exists taller_archivo_update_staff on public.taller_archivo;
create policy taller_archivo_update_staff on public.taller_archivo
  for update to authenticated
  using      ( lower(auth.jwt() ->> 'email') like '%@curifor.com' )
  with check ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

-- ---------------------------------------------------------------
-- 3 · UNA SOLA VERDAD PARA EL AGENDAMIENTO
--
-- Un agendamiento vivía a la vez en la bandeja (taller_estado.data) y en
-- reservas_web, como dos registros distintos: la agenda leía uno y la
-- recepción por patente leía el otro. Tarde o temprano discrepan y nadie sabe
-- cuál creer.
--
-- La decisión: reservas_web es la fila de LA CITA (quién, qué auto, cuándo,
-- en qué estado); la bandeja guarda el estado OPERATIVO del taller (etapa
-- JPCB, técnico, picking). Para eso toda cita tiene que poder nacer en
-- reservas_web, incluidas las internas — y esas pueden no tener teléfono,
-- porque el asesor tiene al cliente al frente.
--
-- La garantía del teléfono no se pierde: se mueve de la columna a la policy
-- del público, que es donde de verdad importa (una reserva web sin forma de
-- contactar al cliente no sirve).
-- ---------------------------------------------------------------
alter table public.reservas_web alter column fono drop not null;

alter table public.reservas_web drop constraint if exists reservas_web_fono_check;
alter table public.reservas_web add constraint reservas_web_fono_check
  check (fono is null or char_length(fono) between 8 and 20);

drop policy if exists reservas_web_insert_publico on public.reservas_web;
create policy reservas_web_insert_publico on public.reservas_web
  for insert to anon
  with check (
    fecha >= current_date and fecha <= current_date + 60
    and fono is not null and char_length(fono) between 8 and 20
  );

-- Sellos de anulación, para cerrar la traza de quién hizo qué.
alter table public.reservas_web
  add column if not exists cancelado_en  timestamptz,
  add column if not exists cancelado_por text;

-- La reconciliación agenda ↔ reservas filtra por sucursal + fecha, y la
-- recepción autónoma busca por patente.
create index if not exists reservas_web_suc_fecha_idx on public.reservas_web (sucursal, fecha);
create index if not exists reservas_web_patente_idx   on public.reservas_web (patente);
