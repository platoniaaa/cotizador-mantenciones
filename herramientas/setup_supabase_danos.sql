-- =============================================================
--  Mapa de daños en el acta de recepción
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_danos.sql
--
--  El asesor marca los daños sobre un diagrama del vehículo en vez de
--  describirlos en prosa. "Rayón en la puerta trasera derecha" depende de si
--  quien lo escribió contaba las puertas desde adelante y de si "derecha" es
--  mirando el auto o sentado en él; un punto en un dibujo no depende de nada.
--
--  El documento del taller (taller_estado) ya guarda las marcas, porque viaja
--  entero. Esta columna es el ESPEJO en reservas_web, donde ya viven el resto
--  de los campos del acta (acc, comb, km_real, obs): un acta partida en dos
--  lugares, con la mitad de los datos en cada uno, no le sirve a nadie que
--  consulte después.
--
--  ADITIVO e idempotente: se puede correr sobre la base en producción.
-- =============================================================

alter table public.reservas_web
  add column if not exists danos jsonb;

comment on column public.reservas_web.danos is
  'Marcas del mapa de daños del acta. Arreglo de {v,x,y,t}: v = vista (sup|izq|der|fre|pos), x e y en 0..1 dentro de esa vista, t = tipo (R rayón, A abolladura, Q quebrado, F falta pieza, P pintura). Las coordenadas van normalizadas para que no dependan del tamaño del dibujo.';
