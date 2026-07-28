-- =============================================================
-- Reservas web del Cotizador de Mantenciones (cliente.html)
-- Ejecutar UNA VEZ en Supabase: SQL Editor → New query → Run.
--
-- Modelo de seguridad:
--   · el público (clave anon, la que va en js/agenda-config.js)
--     SOLO puede insertar reservas — nunca leerlas ni tocarlas
--   · leerlas requiere un usuario del personal:
--     Authentication → Users → Add user (e-mail + clave), y ese
--     login se ingresa una vez en taller.html por estación
-- =============================================================

create table if not exists public.reservas_web (
  id         uuid primary key default gen_random_uuid(),
  creado_en  timestamptz not null default now(),

  -- contacto del cliente
  nombre     text not null check (char_length(nombre) between 3 and 80),
  fono       text not null check (char_length(fono) between 8 and 20),
  email      text check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  patente    text check (patente is null or char_length(patente) <= 10),

  -- la hora pedida (es una SOLICITUD: el asesor la confirma)
  fecha      date not null,
  hora       text not null check (hora ~ '^[0-2][0-9]:[0-5][0-9]$' or hora = 'indiferente'),
  comentario text check (comentario is null or char_length(comentario) <= 500),

  -- el auto y la mantención que venía cotizando
  marca      text, modelo text, version text, anio text,
  pauta_id   text, rev_n text, km integer,
  extras     text,

  estado     text not null default 'nueva'
);

alter table public.reservas_web enable row level security;

-- el público inserta (solo fechas razonables); sin políticas de
-- select/update/delete para anon, no puede hacer nada más
drop policy if exists reservas_web_insert_publico on public.reservas_web;
create policy reservas_web_insert_publico on public.reservas_web
  for insert to anon
  with check (fecha >= current_date and fecha <= current_date + 60);

-- el personal autenticado lee
drop policy if exists reservas_web_select_staff on public.reservas_web;
create policy reservas_web_select_staff on public.reservas_web
  for select to authenticated
  using (true);
