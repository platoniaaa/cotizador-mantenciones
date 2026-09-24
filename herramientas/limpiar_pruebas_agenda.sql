-- Borra las reservas que se crearon probando el sistema el 24-09-2026.
-- Los avisos asociados se van solos (la clave foranea borra en cascada).
delete from public.reservas_web
 where patente in ('ZZTEST9', 'ZZFINAL9', 'ZZMOTOR9', 'ZZREAL01');

-- Debe quedar vacio.
select patente, nombre, fecha from public.reservas_web
 where patente like 'ZZ%';
