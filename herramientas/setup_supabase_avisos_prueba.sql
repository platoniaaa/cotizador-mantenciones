-- ============================================================
--  Modo de prueba de los avisos
--
--  Con `modo_prueba` puesto, TODOS los correos se desvían a esa casilla en vez
--  de ir al cliente. El asunto se marca con [PRUEBA → correo del cliente] para
--  saber a quién le habría llegado.
--
--  Para qué: ver los tres avisos funcionando con citas reales antes de que le
--  llegue nada a un cliente. Un recordatorio mal redactado o con la sucursal
--  equivocada se arregla en dos minutos; disculparse con 40 clientes, no.
--
--  Sirve además mientras el dominio no esté verificado: Resend solo acepta
--  escribir a la casilla dueña de la cuenta, así que sin esto el sistema
--  encendido fallaría en cada intento.
--
--  Aplicar con: python herramientas/aplicar_sql.py setup_supabase_avisos_prueba.sql
-- ============================================================

alter table public.avisos_config
  add column if not exists modo_prueba text;

comment on column public.avisos_config.modo_prueba is
  'Si tiene un correo, TODOS los avisos van ahi en vez de al cliente. Vaciarlo (null) es lo que pone el sistema en modo real.';


create or replace function public.avisos_despachar(p_limite int default 25)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  cfg      record;
  p        record;
  cuerpo   jsonb;
  v_key    text;
  v_req    bigint;
  v_para   text;
  v_asunto text;
  n_ok     int := 0;
  n_omit   int := 0;
begin
  select * into cfg from public.avisos_config where id;
  if not found or not cfg.activo then
    return jsonb_build_object('ok', false, 'motivo', 'avisos desactivados');
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where name = 'RESEND_API_KEY';
  if v_key is null or v_key = '' then
    return jsonb_build_object('ok', false, 'motivo', 'falta RESEND_API_KEY en Vault');
  end if;

  for p in select * from public.avisos_pendientes() limit p_limite loop
    -- Se reserva el envío ANTES de mandarlo. El unique(reserva_id, tipo) impide
    -- que dos vueltas del cron solapadas manden el mismo correo dos veces.
    begin
      insert into public.avisos_enviados (reserva_id, tipo, destinatario, estado)
           values (p.reserva_id, p.tipo, p.destinatario, 'pendiente');
    exception when unique_violation then
      n_omit := n_omit + 1;
      continue;
    end;

    cuerpo := public.aviso_html(p.reserva_id, p.tipo);
    if cuerpo is null then
      update public.avisos_enviados set estado = 'error', detalle = 'no se pudo armar el correo'
       where reserva_id = p.reserva_id and tipo = p.tipo;
      continue;
    end if;

    -- El desvío. Se anota en la bitácora a dónde fue de verdad, para que nadie
    -- crea después que el cliente recibió algo que nunca le llegó.
    if cfg.modo_prueba is not null and cfg.modo_prueba <> '' then
      v_para   := cfg.modo_prueba;
      v_asunto := '[PRUEBA → ' || (cuerpo->>'email') || '] ' || (cuerpo->>'asunto');
      update public.avisos_enviados
         set detalle = 'modo prueba · el cliente NO lo recibió'
       where reserva_id = p.reserva_id and tipo = p.tipo;
    else
      v_para   := cuerpo->>'email';
      v_asunto := cuerpo->>'asunto';
    end if;

    select net.http_post(
      url := 'https://api.resend.com/emails',
      headers := jsonb_build_object('Authorization', 'Bearer ' || v_key,
                                    'Content-Type', 'application/json'),
      body := jsonb_build_object(
        'from', cfg.remitente_nom || ' <' || cfg.remitente || '>',
        'to', jsonb_build_array(v_para),
        'subject', v_asunto,
        'html', cuerpo->>'html',
        'tags', jsonb_build_array(jsonb_build_object('name', 'aviso', 'value', p.tipo))
      ) ||
      case when cfg.responder_a is not null
           then jsonb_build_object('reply_to', cfg.responder_a) else '{}'::jsonb end ||
      -- La copia interna no se manda en modo prueba: la casilla del taller no
      -- tiene por qué llenarse de correos de ensayo.
      case when cfg.copia_interna is not null and coalesce(cfg.modo_prueba, '') = ''
           then jsonb_build_object('bcc', jsonb_build_array(cfg.copia_interna)) else '{}'::jsonb end,
      timeout_milliseconds := 8000
    ) into v_req;

    update public.avisos_enviados
       set estado = 'enviado', enviado_en = now(), request_id = v_req
     where reserva_id = p.reserva_id and tipo = p.tipo;
    n_ok := n_ok + 1;
  end loop;

  return jsonb_build_object('ok', true, 'enviados', n_ok, 'omitidos', n_omit,
                            'modo', case when coalesce(cfg.modo_prueba,'') <> ''
                                         then 'prueba → ' || cfg.modo_prueba else 'real' end);
end $$;

revoke all on function public.avisos_despachar(int) from public, anon, authenticated;


-- ------------------------------------------------------------
--  Cómo va el sistema, en una sola consulta.
--  Para revisar sin tener que recordar cuatro tablas.
-- ------------------------------------------------------------
create or replace view public.avisos_estado as
  select a.tipo,
         a.estado,
         count(*) as cuantos,
         max(a.enviado_en) as ultimo,
         count(*) filter (where a.detalle like 'modo prueba%') as en_prueba
    from public.avisos_enviados a
   group by a.tipo, a.estado;

grant select on public.avisos_estado to authenticated;
