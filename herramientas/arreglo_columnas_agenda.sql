-- ============================================================
--  ARREGLO URGENTE · la agenda no podia guardar reservas
--
--  Sintoma: al apretar "Confirmar mi agenda" salia "No pudimos enviar tu
--  solicitud". Nadie podia agendar.
--
--  Causa: el formulario se publico pidiendo servicio, kilometraje y los dos
--  consentimientos, pero las columnas correspondientes nunca se crearon en la
--  tabla. PostgREST rechazaba el insert entero con
--  "Could not find the 'km_declarado' column of 'reservas_web'".
--
--  Esto junta las dos migraciones que faltaban:
--    setup_supabase_agenda_servicio.sql  -> servicio, km_declarado
--    setup_supabase_consentimiento.sql   -> marketing, cond_version
--
--  Es seguro repetirlo: todas las columnas van con "if not exists".
-- ============================================================

alter table public.reservas_web
  add column if not exists servicio     text,
  add column if not exists km_declarado integer,
  add column if not exists marketing    boolean,
  add column if not exists cond_version text;

comment on column public.reservas_web.servicio is
  'Que pidio el cliente: mantencion, dip, diagnostico o garantia.';
comment on column public.reservas_web.km_declarado is
  'Kilometraje que declaro el cliente al agendar (el del tablero).';
comment on column public.reservas_web.marketing is
  'Acepto recibir ofertas y promociones. Es un consentimiento aparte del de la atencion.';
comment on column public.reservas_web.cond_version is
  'Version de las condiciones que acepto, para poder probar despues que texto vio.';

-- Limpieza: la reserva que se creo probando el diagnostico.
delete from public.reservas_web where patente = 'ZZTEST9';

-- Comprobacion: las cuatro deben aparecer.
select column_name, data_type
  from information_schema.columns
 where table_schema = 'public'
   and table_name   = 'reservas_web'
   and column_name in ('servicio','km_declarado','marketing','cond_version')
 order by column_name;
