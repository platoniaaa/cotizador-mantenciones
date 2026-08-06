-- =============================================================
-- FIRMAS DEL ACTA DE RECEPCIÓN
--
-- La recepción ya guarda la inspección fotográfica en el bucket privado
-- `recepciones` y refleja las rutas en reservas_web.fotos. Las firmas del
-- cliente y del asesor siguen el mismo camino: el PNG va a Storage y acá queda
-- dónde encontrarlo, para que cualquier estación (y el acta impresa, cuando se
-- haga) sepa que la recepción está respaldada.
--
-- Forma del valor:  {"cliente": "<carpeta>/firma-cliente.png",
--                    "asesor":  "<carpeta>/firma-asesor.png"}
--
-- ADITIVO e idempotente: la columna es opcional, así que el INSERT anónimo del
-- cliente web y las policies existentes siguen igual.
-- =============================================================

alter table public.reservas_web
  add column if not exists firmas jsonb;

comment on column public.reservas_web.firmas is
  'Rutas en el bucket `recepciones` de las firmas del acta, por rol (cliente/asesor).';
