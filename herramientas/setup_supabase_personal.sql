-- =============================================================
-- PERSONAL DE POSTVENTA  (técnicos y asesores por sucursal)
--
-- Hasta ahora las listas de TECNICOS y ASESORES estaban escritas a mano en
-- js/taller.js con nombres inventados. Reemplazarlas por los reales tiene dos
-- problemas si se hace en el repo:
--
--   1) El repo es PÚBLICO. Nombre completo + correo corporativo + sucursal de
--      76 personas no puede quedar ahí: son datos personales de terceros.
--   2) Cada alta, baja o traslado obligaría a un commit y un deploy.
--
-- Por eso viven acá, con la misma RLS que el resto: solo las lee un token
-- @curifor.com. La plataforma los carga al entrar y arma la lista de la
-- sucursal que corresponda.
--
-- Fuente: "Nómina Area PV (Clasificada)", cargos marcados por Ignacio el
-- 06-ago-2026: MECANICO, MECANICO 1, MECANICO - ALINEADOR,
-- MECANICO TALLER MOVIL y AYUDANTE MECANICO -> técnicos; ASESOR -> asesores.
--
-- ADITIVO e idempotente.
-- =============================================================

create table if not exists public.personal (
  rut          text        primary key,
  nombre       text        not null,
  nombre_corto text,
  cargo        text        not null,
  rol          text        not null check (rol in ('tecnico', 'asesor')),
  sucursal     text,
  email        text,
  activo       boolean     not null default true,
  actualizado  timestamptz not null default now()
);

comment on table public.personal is
  'Técnicos y asesores de postventa por sucursal. Alimenta el planificador y el selector de asesor. Datos personales: nunca al repo.';
comment on column public.personal.rol is
  'tecnico (la familia MECANICO + AYUDANTE MECANICO) o asesor (cargo ASESOR).';
comment on column public.personal.nombre_corto is
  'Nombre de pila + apellido paterno, para la grilla del planificador, donde el nombre completo no cabe.';
comment on column public.personal.sucursal is
  'Con el MISMO texto que usan taller_estado y reservas_web, si no, no calzan.';
comment on column public.personal.activo is
  'Se da de baja poniendo esto en false; no se borra, para que las órdenes viejas sigan resolviendo a quién las atendió.';

create index if not exists personal_suc_rol_idx on public.personal (sucursal, rol) where activo;

-- ---- RLS: solo el personal @curifor.com, igual que el resto ----
alter table public.personal enable row level security;

drop policy if exists personal_select_staff on public.personal;
create policy personal_select_staff on public.personal
  for select to authenticated
  using ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

-- La nómina se carga desde RRHH, no desde el navegador: sin políticas de
-- insert/update/delete, nadie la modifica con el token de la aplicación.
