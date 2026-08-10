-- ============================================================
--  Migración de curifor-ots (Streamlit + JSON en GitHub) a
--  tablas reales en Supabase. Fase 1: modelo de datos.
--
--  Idempotente: se puede aplicar más de una vez.
--  Los datos los carga herramientas/migrar_curifor_ots.py.
--
--  Regla de propiedad (la misma que reservas_web vs bandeja:
--  UNA dirección por campo):
--    - `ots` y `stock_repuestos` los fabrica el ETL y se
--      recargan completos; la gente solo los lee.
--    - `ots_gestion`, `ots_comentarios`, `notificaciones` y
--      `auditoria` son de la gente; el ETL jamás los toca.
--  Así el refresco diario no puede pisar trabajo humano.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Sucursales canónicas + alias
--    Arregla el problema real del mundo viejo: "CHILLAN VIEJO"
--    y "Chillán Viejo" conviven como sucursales distintas.
--    El nombre canónico es el de la agenda (taller.html).
-- ------------------------------------------------------------
create table if not exists public.sucursales (
  id     text primary key,          -- slug estable: 'chillan-viejo'
  nombre text not null unique,      -- como lo muestra la plataforma
  activo boolean not null default true,
  nota   text
);

create table if not exists public.sucursal_alias (
  alias       text primary key,     -- cómo aparece en el mundo viejo
  sucursal_id text not null references public.sucursales(id) on update cascade
);

alter table public.sucursales     enable row level security;
alter table public.sucursal_alias enable row level security;

drop policy if exists sucursales_select_personal on public.sucursales;
create policy sucursales_select_personal on public.sucursales
  for select to authenticated using (public.es_personal_curifor());

drop policy if exists sucursal_alias_select_personal on public.sucursal_alias;
create policy sucursal_alias_select_personal on public.sucursal_alias
  for select to authenticated using (public.es_personal_curifor());

-- ------------------------------------------------------------
-- 2) OTs — la sábana del PBI ya cruzada (era datos_dashboard.json)
--    Propiedad del ETL: se recarga completa, nadie la edita.
--    El folio es único a nivel de empresa (verificado: 0 repetidos
--    en 2.069 OTs), así que es la llave natural.
-- ------------------------------------------------------------
create table if not exists public.ots (
  folio_ot       text primary key,
  sucursal       text not null,     -- nombre canónico de `sucursales`
  rango          text,
  dias_apertura  integer,
  fecha_ot       date,
  anio_vehiculo  text,
  tipo_venta     text,
  tipo_cliente   text,
  marca          text,
  modelo         text,
  patente        text,
  asesor         text,
  estado         text,
  importador     text,
  neto           bigint,
  glosa_trabajo  text,
  rut_cliente    text,              -- puede traer varios RUT separados por " / "
  -- documentos posteriores (liquidaciones, facturas, cargos, vales)
  n_liq_st            integer,  folios_liq_st        text,
  n_fact_cliente      integer,  folios_fact_cliente  text,
  n_fact_compania     integer,  folios_fact_compania text,
  n_cargo_int         integer,  folios_cargo_int     text,
  n_cargo_gtia        integer,  folios_cargo_gtia    text,
  n_fact_gtia         integer,  folios_fact_gtia     text,
  n_vale_consumo      integer,  folios_vale_consumo  text,
  fecha_fact_cliente  date,
  fecha_fact_compania date,
  -- detalle anidado que hoy solo se muestra (no se consulta por dentro)
  anticipo            jsonb,
  repuestos_actual    jsonb,
  repuestos_historico jsonb,
  repuestos_compras   jsonb,
  actualizado timestamptz not null default now()
);

create index if not exists ots_sucursal_idx on public.ots (sucursal);
create index if not exists ots_patente_idx  on public.ots (patente);

alter table public.ots enable row level security;
drop policy if exists ots_select_personal on public.ots;
create policy ots_select_personal on public.ots
  for select to authenticated using (public.es_personal_curifor());
-- sin policy de escritura: solo el ETL (conexión directa) escribe

-- ------------------------------------------------------------
-- 3) Gestión humana por OT — las 4 columnas editables del
--    dashboard + color + etapa JPCB. Vive APARTE de `ots` para
--    que el refresco diario no pueda pisarla, y para que la
--    gestión sobreviva aunque la OT salga de la sábana.
--    Sin FK a `ots` a propósito (la OT se cierra; la gestión queda).
-- ------------------------------------------------------------
create table if not exists public.ots_gestion (
  folio_ot       text primary key,
  sucursal       text not null,
  categoria      text,
  observacion_ot text,
  notas          text,
  avance_gestion text,
  marca_color    text,
  etapa_jpcb     text,
  ultima_edicion text,              -- "correo — dd/mm/aaaa hh:mm" (formato heredado)
  actualizado    timestamptz not null default now()
);

create or replace function public.ots_gestion_touch()
returns trigger language plpgsql as $$
begin
  new.actualizado := now();
  return new;
end $$;

drop trigger if exists ots_gestion_touch on public.ots_gestion;
create trigger ots_gestion_touch
  before update on public.ots_gestion
  for each row execute function public.ots_gestion_touch();

alter table public.ots_gestion enable row level security;
drop policy if exists ots_gestion_select_personal on public.ots_gestion;
create policy ots_gestion_select_personal on public.ots_gestion
  for select to authenticated using (public.es_personal_curifor());
drop policy if exists ots_gestion_insert_personal on public.ots_gestion;
create policy ots_gestion_insert_personal on public.ots_gestion
  for insert to authenticated with check (public.es_personal_curifor());
drop policy if exists ots_gestion_update_personal on public.ots_gestion;
create policy ots_gestion_update_personal on public.ots_gestion
  for update to authenticated
  using (public.es_personal_curifor()) with check (public.es_personal_curifor());
-- sin delete: la gestión no se borra desde la app

-- ------------------------------------------------------------
-- 4) Comentarios por OT (era comentarios_log.json)
--    Bitácora de la gente: solo se agrega, nunca se edita.
-- ------------------------------------------------------------
create table if not exists public.ots_comentarios (
  id         bigint generated always as identity primary key,
  folio_ot   text not null,
  autor      text not null,
  fecha      timestamptz not null default now(),
  comentario text not null
);

create index if not exists ots_comentarios_folio_idx on public.ots_comentarios (folio_ot);

alter table public.ots_comentarios enable row level security;
drop policy if exists ots_comentarios_select_personal on public.ots_comentarios;
create policy ots_comentarios_select_personal on public.ots_comentarios
  for select to authenticated using (public.es_personal_curifor());
drop policy if exists ots_comentarios_insert_personal on public.ots_comentarios;
create policy ots_comentarios_insert_personal on public.ots_comentarios
  for insert to authenticated with check (public.es_personal_curifor());

-- ------------------------------------------------------------
-- 5) Notificaciones (era notificaciones.json)
--    Leer/crear: todo el personal (igual que hoy: el archivo era
--    visible completo). Marcar leída: solo el destinatario.
-- ------------------------------------------------------------
create table if not exists public.notificaciones (
  id           uuid primary key default gen_random_uuid(),
  remitente    text not null,
  destinatario text not null,
  folio_ot     text,
  extracto     text,
  fecha        timestamptz not null default now(),
  leida        boolean not null default false
);

create index if not exists notificaciones_dest_idx
  on public.notificaciones (destinatario, leida);

alter table public.notificaciones enable row level security;
drop policy if exists notificaciones_select_personal on public.notificaciones;
create policy notificaciones_select_personal on public.notificaciones
  for select to authenticated using (public.es_personal_curifor());
drop policy if exists notificaciones_insert_personal on public.notificaciones;
create policy notificaciones_insert_personal on public.notificaciones
  for insert to authenticated with check (public.es_personal_curifor());
drop policy if exists notificaciones_update_destinatario on public.notificaciones;
create policy notificaciones_update_destinatario on public.notificaciones
  for update to authenticated
  using (public.es_personal_curifor()
         and lower(destinatario) = lower(auth.jwt() ->> 'email'))
  with check (public.es_personal_curifor()
         and lower(destinatario) = lower(auth.jwt() ->> 'email'));

-- ------------------------------------------------------------
-- 6) Auditoría (era audit_log.json)
--    Solo se agrega. Sin update ni delete para nadie.
-- ------------------------------------------------------------
create table if not exists public.auditoria (
  id       bigint generated always as identity primary key,
  fecha    timestamptz not null default now(),
  usuario  text not null,
  accion   text not null,
  detalle  text,
  folio_ot text
);

create index if not exists auditoria_fecha_idx on public.auditoria (fecha desc);

alter table public.auditoria enable row level security;
drop policy if exists auditoria_select_personal on public.auditoria;
create policy auditoria_select_personal on public.auditoria
  for select to authenticated using (public.es_personal_curifor());
drop policy if exists auditoria_insert_personal on public.auditoria;
create policy auditoria_insert_personal on public.auditoria
  for insert to authenticated with check (public.es_personal_curifor());

-- ------------------------------------------------------------
-- 7) Stock de repuestos (era stock_repuestos.json, 30.044 filas)
--    Propiedad del ETL. Llave natural verificada: producto+bodega
--    (el producto solo se repite entre bodegas distintas).
-- ------------------------------------------------------------
create table if not exists public.stock_repuestos (
  producto            text not null,
  bodega              text not null default '',
  descripcion         text,
  stock               numeric,
  stock_proyectado    numeric,
  precio_venta        numeric,
  costo               numeric,
  familia             text,
  subfamilia          text,
  procedencia         text,
  categoria           text,
  clasificacion_stock text,
  actualizado         timestamptz not null default now(),
  primary key (producto, bodega)
);

alter table public.stock_repuestos enable row level security;
drop policy if exists stock_repuestos_select_personal on public.stock_repuestos;
create policy stock_repuestos_select_personal on public.stock_repuestos
  for select to authenticated using (public.es_personal_curifor());
-- sin policy de escritura: solo el ETL

-- ------------------------------------------------------------
-- 8) Restricción por sucursal heredada de usuarios_curifor.json.
--    Vacío/null = sin restricción (ve todas), igual que hoy.
--    Los hash de contraseña NO se migran: eso lo reemplaza
--    Supabase Auth.
-- ------------------------------------------------------------
alter table public.personal
  add column if not exists sucursales_permitidas text[];
