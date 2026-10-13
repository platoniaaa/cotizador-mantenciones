-- ============================================================
-- Arreglar el disparo inmediato de los correos
-- ============================================================
--
-- Síntoma: el cliente agenda y su comprobante llega horas después.
--
-- Causa: la base sí le avisa a GitHub al crear la reserva, pero GitHub
-- responde 403 "Resource not accessible by personal access token". El
-- token guardado es de tipo *fine-grained* (empieza con github_pat_),
-- y el endpoint de dispatches no acepta ese tipo: la documentación de
-- GitHub solo garantiza el token clásico con scope "repo".
--
-- Sin el disparo, el envío queda a merced del reloj de GitHub Actions,
-- que está configurado cada 5 minutos pero en la práctica corre cada
-- 3 a 7 horas (medido sobre las últimas 15 corridas, promedio 5h 30m).
--
-- Antes de correr esto, crea el token:
--   1. https://github.com/settings/tokens/new   (pestaña "Tokens (classic)")
--   2. Note        : Supabase - disparo de avisos
--   3. Expiration  : No expiration
--   4. Marca SOLO la casilla  repo  (la de arriba, marca las de adentro sola)
--   5. Generate token y cópialo. Empieza con  ghp_
--
-- Ojo: tiene que decir ghp_ al principio. Si dice github_pat_ es el tipo
-- equivocado y va a fallar igual.
-- ============================================================


-- ------------------------------------------------------------
-- PASO 1 — Guardar el token nuevo
-- ------------------------------------------------------------
-- Reemplaza  PEGA_EL_TOKEN_AQUI  por el token (deja las comillas).

do $$
declare
  v_id    uuid;
  v_token text := 'PEGA_EL_TOKEN_AQUI';   -- <<< EL TOKEN
begin
  if v_token not like 'ghp_%' then
    raise exception 'Ese no es un token clásico. Debe empezar con ghp_ (el tuyo empieza con %)',
                    left(v_token, 12);
  end if;

  select id into v_id from vault.secrets where name = 'GITHUB_DISPATCH_TOKEN';

  if v_id is null then
    perform vault.create_secret(v_token, 'GITHUB_DISPATCH_TOKEN',
                                'Token clásico scope repo: dispara el workflow de avisos');
    raise notice 'Token creado.';
  else
    perform vault.update_secret(v_id, v_token);
    raise notice 'Token reemplazado.';
  end if;
end $$;


-- ------------------------------------------------------------
-- PASO 2 — Confirmar que quedó guardado
-- ------------------------------------------------------------
-- Debe mostrar  ghp_  en la columna tipo. No muestra el token completo.

select name,
       left(decrypted_secret, 4) as tipo,       -- esperado: ghp_
       length(decrypted_secret)  as largo
from vault.decrypted_secrets
where name in ('GITHUB_DISPATCH_TOKEN', 'GITHUB_REPO');


-- ------------------------------------------------------------
-- PASO 3 — Probar el disparo de verdad
-- ------------------------------------------------------------
-- Esto le pide a GitHub que arranque el envío, igual que haría una
-- reserva nueva. Si no hay correos pendientes, no se manda nada:
-- el flujo arranca, no encuentra nada en cola y termina.

select net.http_post(
  url     := 'https://api.github.com/repos/'
             || (select decrypted_secret from vault.decrypted_secrets where name = 'GITHUB_REPO')
             || '/dispatches',
  headers := jsonb_build_object(
               'Authorization', 'Bearer ' || (select decrypted_secret
                                              from vault.decrypted_secrets
                                              where name = 'GITHUB_DISPATCH_TOKEN'),
               'Accept',        'application/vnd.github+json',
               'Content-Type',  'application/json',
               'User-Agent',    'curifor-agenda'),
  body    := jsonb_build_object('event_type', 'aviso_nuevo'),
  timeout_milliseconds := 5000
) as id_peticion;


-- ------------------------------------------------------------
-- PASO 4 — Leer qué contestó GitHub
-- ------------------------------------------------------------
-- pg_net responde aparte, no en el momento. Espera unos 5 segundos
-- después del paso 3 y recién ahí ejecuta esto.
--
--   204  ->  funcionó. El disparo quedó arreglado.
--   403  ->  el token sigue sin servir (revisa que diga ghp_ y que
--            tenga marcado el scope repo completo).
--   401  ->  el token está mal copiado o fue revocado.
--   404  ->  GITHUB_REPO está mal escrito.

select status_code,
       left(content, 300) as respuesta,
       created
from net._http_response
order by created desc
limit 3;
