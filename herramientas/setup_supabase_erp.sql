-- =============================================================
--  Control de sincronización con Flexline ERP
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_erp.sql
--
--  El conector (herramientas/conector_flexline.py) lee las recepciones ya
--  ingresadas al taller y las inyecta a Flexline como documento. Estas dos
--  columnas evitan que una recepción se registre DOS veces si el conector
--  vuelve a correr:
--
--    erp_sincronizado  cuándo se llevó al ERP (null = todavía no).
--    erp_documento     el número que devolvió Flexline, para poder rastrear
--                      la OT en el ERP desde la reserva.
--
--  El conector filtra por `erp_sincronizado is null`, así que una fila ya
--  procesada no vuelve a tomarse aunque siga en estado en_taller.
--
--  ADITIVO e idempotente: se puede correr sobre la base en producción.
-- =============================================================

alter table public.reservas_web
  add column if not exists erp_sincronizado timestamptz,
  add column if not exists erp_documento    text;

comment on column public.reservas_web.erp_sincronizado is
  'Momento en que la recepción se inyectó a Flexline. Null = pendiente. Lo escribe conector_flexline.py; es lo que evita registrar la OT dos veces.';
comment on column public.reservas_web.erp_documento is
  'Número de documento que devolvió Flexline al crear la OT. Enlaza la reserva con el registro del ERP.';
