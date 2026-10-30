-- ============================================================
--  Cambio de dirección del sitio
--
--  Se corre UNA vez, cuando el sitio pasa a publicarse desde otra cuenta u
--  otro repositorio de GitHub (por transferencia o porque se montó de nuevo
--  desde el zip). GitHub Pages publica en https://<cuenta>.github.io/<repo>/
--  y no redirige la dirección anterior, así que hay que cambiarla en la base:
--
--    1. GITHUB_REPO en Vault: el repo al que Supabase le avisa para mandar
--       los correos al instante.
--    2. avisos_config.url_confirmar: el botón «confirmar» de los correos.
--    3. Las funciones que tengan escrita la dirección anterior (el logo del
--       correo, en aviso_html). Se reescriben desde su definición ACTUAL en
--       la base, no desde un archivo: así no se arrastra ninguna versión vieja.
--
--  CÓMO SE USA: escribe la cuenta y el repo nuevos en `nuevo_repo` (la
--  primera línea marcada con <<<) y ejecuta todo. Es seguro repetirlo.
-- ============================================================

do $$
declare
  nuevo_repo text := 'CUENTA/REPO';                                   -- <<< p. ej. curiforsa10/plataforma-postventa
  vieja_base text := 'https://platoniaaa.github.io/cotizador-mantenciones/';   -- dirección anterior
  nueva_base text;
  f          record;
  n          int := 0;
begin
  if nuevo_repo = 'CUENTA/REPO' or position('/' in nuevo_repo) = 0 then
    raise exception 'Escribe en nuevo_repo la cuenta y el repo nuevos, por ejemplo curiforsa10/plataforma-postventa';
  end if;
  nueva_base := 'https://' || lower(split_part(nuevo_repo, '/', 1)) || '.github.io/'
                || split_part(nuevo_repo, '/', 2) || '/';

  -- 1. El repo al que avisa Supabase
  perform vault.update_secret((select id from vault.secrets where name = 'GITHUB_REPO'), nuevo_repo);

  -- 2. El botón «confirmar» y su valor por defecto
  update public.avisos_config
     set url_confirmar = replace(url_confirmar, vieja_base, nueva_base),
         actualizado   = now()
   where url_confirmar like vieja_base || '%';
  execute format('alter table public.avisos_config alter column url_confirmar set default %L',
                 nueva_base || 'confirmar.html');

  -- 3. Las funciones con la dirección anterior escrita (pg_get_functiondef
  --    devuelve el CREATE OR REPLACE completo; conserva dueño y permisos)
  for f in
    select p.oid, p.oid::regprocedure::text as firma
      from pg_proc p
      join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public'
       and p.prokind = 'f'
       and pg_get_functiondef(p.oid) like '%' || vieja_base || '%'
  loop
    execute replace(pg_get_functiondef(f.oid), vieja_base, nueva_base);
    n := n + 1;
    raise notice 'actualizada: %', f.firma;
  end loop;

  raise notice 'Listo. Dirección nueva: % | funciones actualizadas: %', nueva_base, n;
end $$;


-- Verificación: las dos primeras filas deben mostrar la cuenta y el repo
-- nuevos, y la tercera debe ser 0.
select 'GITHUB_REPO' as que, decrypted_secret as valor
  from vault.decrypted_secrets where name = 'GITHUB_REPO'
union all
select 'url_confirmar', url_confirmar from public.avisos_config
union all
select 'funciones con la direccion anterior', count(*)::text
  from pg_proc p join pg_namespace s on s.oid = p.pronamespace
 where s.nspname = 'public' and p.prokind = 'f'
   and pg_get_functiondef(p.oid) like '%platoniaaa.github.io/cotizador-mantenciones/%';
