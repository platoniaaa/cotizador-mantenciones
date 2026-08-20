-- =============================================================
--  Autorización de datos personales del cliente
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_consentimiento.sql
--
--  Dos cosas distintas viajan acá:
--
--  1) marketing — si el cliente autorizó publicidad. Va SEPARADO de las
--     comunicaciones del servicio: los avisos del estado de su Orden de
--     Trabajo son necesarios para prestarle el servicio que vino a contratar;
--     la publicidad no, y por eso requiere una autorización voluntaria que
--     puede revocar. Un solo "acepto todo" es lo que después vuelve la
--     autorización discutible.
--
--  2) cond_version — QUÉ TEXTO se le mostró. Si mañana Legal cambia una
--     cláusula, hay que poder responder qué firmó este cliente en agosto, no
--     cuál está vigente hoy. Sin esto la autorización no se puede acreditar.
--
--  Mientras esta migración no se aplique, la casilla no se pide en la página
--  pública: capturar una autorización que no se puede guardar es peor que no
--  pedirla.
--
--  ADITIVO e idempotente: se puede correr sobre la base en producción.
-- =============================================================

alter table public.reservas_web
  add column if not exists marketing    boolean,
  add column if not exists cond_version text;

comment on column public.reservas_web.marketing is
  'Autorización VOLUNTARIA para comunicaciones comerciales (ofertas, promociones, recordatorios) por WhatsApp, correo o teléfono. NULL = nunca se preguntó; false = dijo que no. Los avisos del estado de la OT no dependen de esto: son necesarios para el servicio.';
comment on column public.reservas_web.cond_version is
  'Versión del texto de condiciones y tratamiento de datos que se le mostró al cliente (ver js/acta-condiciones.js). Es lo que permite acreditar QUÉ aceptó, y no solo que aceptó algo.';
