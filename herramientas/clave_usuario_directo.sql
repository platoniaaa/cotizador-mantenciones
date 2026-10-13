-- ============================================================
-- Definir la contraseña de un usuario sin pasar por el correo
-- ============================================================
--
-- Para qué: cuando a alguien se le olvida la clave y el correo de
-- recuperación no sirve (por ejemplo, porque la Site URL del proyecto
-- apunta a localhost y el enlace lleva a una página que no existe).
--
-- Esto escribe el hash directo en auth.users. Es lo mismo que hace
-- Supabase cuando el usuario define su clave, solo que sin el correo
-- de por medio.
--
-- Cómo se usa: pega este archivo en el editor SQL de Supabase,
-- cambia los dos valores marcados y ejecuta cada paso por separado.
--
-- Quien ejecuta esto ve la contraseña. Entrégala por un canal aparte
-- (teléfono, en persona) y pide que la cambie al entrar.
-- ============================================================


-- ------------------------------------------------------------
-- PASO 1 — Confirmar que el usuario existe y cómo está escrito
-- ------------------------------------------------------------
-- Si no devuelve ninguna fila, el correo está distinto en la base.
-- Quita el filtro y busca con  where email ilike '%apellido%'.

select id,
       email,
       email_confirmed_at,                  -- si está vacío, el paso 2 lo llena
       last_sign_in_at,
       created_at
from auth.users
where lower(email) = lower('usuario@curifor.com');   -- <<< CORREO


-- ------------------------------------------------------------
-- PASO 2 — Escribir la contraseña nueva
-- ------------------------------------------------------------
-- Reemplaza  CLAVE_NUEVA_AQUI  por la contraseña (mínimo 8 caracteres).
-- Si la contraseña lleva una comilla simple, escríbela doble: don''t
--
-- El search_path cubre las dos ubicaciones posibles de pgcrypto:
-- Supabase la instala en "extensions", pero en proyectos antiguos
-- puede estar en "public". Sin esto, crypt() no se encuentra.

set search_path = public, extensions;

update auth.users
   set encrypted_password = crypt('CLAVE_NUEVA_AQUI', gen_salt('bf', 10)),
       -- Sin esta fecha, Supabase rechaza el acceso por correo sin confirmar.
       email_confirmed_at = coalesce(email_confirmed_at, now()),
       updated_at         = now()
 where lower(email) = lower('usuario@curifor.com');   -- <<< CORREO

-- Debe decir: UPDATE 1
-- Si dice UPDATE 0, el correo no coincide: vuelve al paso 1.


-- ------------------------------------------------------------
-- PASO 3 — Verificar
-- ------------------------------------------------------------
-- updated_at debe ser de hace unos segundos y email_confirmed_at
-- no puede estar vacío.

select email,
       email_confirmed_at,
       updated_at,
       left(encrypted_password, 7) as formato_hash   -- debe partir con $2a$10$
from auth.users
where lower(email) = lower('usuario@curifor.com');   -- <<< CORREO


-- ------------------------------------------------------------
-- Opcional — Cerrar las sesiones abiertas de ese usuario
-- ------------------------------------------------------------
-- Solo si sospechas que alguien más entró con la clave vieja.
-- Lo obliga a entrar de nuevo con la contraseña nueva.
--
-- delete from auth.sessions
--  where user_id = (select id from auth.users
--                    where lower(email) = lower('usuario@curifor.com'));
