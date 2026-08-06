-- =============================================================
-- ESTADO COMPARTIDO DEL TALLER  (una bandeja por sucursal)
--
-- Hasta ahora el estado del taller (agendamientos + órdenes de trabajo +
-- correlativos) vivía SOLO en el localStorage del navegador de cada estación:
-- nadie veía lo del otro, y al cambiar de origen (del iframe de Pages a la app
-- de OTs) los datos dejaban de verse. Esta tabla lo saca del navegador.
--
-- Un registro por sucursal. El documento completo va en `data` (mismo shape que
-- tenía en localStorage: agendamientos, orders, ocSeq, roSeq, webImp) y `version`
-- da el bloqueo optimista: el cliente actualiza con `where version = N` y, si no
-- afecta filas, es que otra estación guardó primero → relee, fusiona a 3 bandas
-- (base / lo mío / lo del servidor) y reintenta. Nadie pisa a nadie.
--
-- Mismo patrón de acceso que reservas_web: solo personal autenticado con correo
-- @curifor.com. ADITIVO e idempotente.
-- =============================================================

create table if not exists public.taller_estado (
  sucursal        text        primary key,
  data            jsonb       not null default '{}'::jsonb,
  version         bigint      not null default 1,
  actualizado     timestamptz not null default now(),
  actualizado_por text
);

comment on table  public.taller_estado is
  'Bandeja del taller por sucursal (agendamientos, órdenes, correlativos). Bloqueo optimista por version.';
comment on column public.taller_estado.version is
  'Sube de a 1 en cada guardado. El cliente escribe con where version = N para detectar choques.';

-- Sello de auditoría: quién y cuándo dejó la última versión.
create or replace function public.taller_estado_touch()
returns trigger language plpgsql as $$
begin
  new.actualizado := now();
  new.actualizado_por := coalesce(auth.jwt() ->> 'email', new.actualizado_por);
  return new;
end $$;

drop trigger if exists trg_taller_estado_touch on public.taller_estado;
create trigger trg_taller_estado_touch before insert or update on public.taller_estado
  for each row execute function public.taller_estado_touch();

-- ---- RLS: solo el personal @curifor.com, igual que reservas_web ----
alter table public.taller_estado enable row level security;

drop policy if exists taller_estado_select_staff on public.taller_estado;
create policy taller_estado_select_staff on public.taller_estado
  for select to authenticated
  using ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists taller_estado_insert_staff on public.taller_estado;
create policy taller_estado_insert_staff on public.taller_estado
  for insert to authenticated
  with check ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

drop policy if exists taller_estado_update_staff on public.taller_estado;
create policy taller_estado_update_staff on public.taller_estado
  for update to authenticated
  using      ( lower(auth.jwt() ->> 'email') like '%@curifor.com' )
  with check ( lower(auth.jwt() ->> 'email') like '%@curifor.com' );

-- No hay policy de DELETE a propósito: la bandeja no se borra desde el navegador.
