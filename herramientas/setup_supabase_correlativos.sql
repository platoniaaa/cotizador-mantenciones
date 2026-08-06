-- =============================================================
-- CORRELATIVOS DE OC Y RO  (uno por sucursal, entregado por la base)
--
-- Hasta ahora cada estación llevaba su propio contador en el navegador,
-- arrancando todas del mismo número: dos asesores que agendaban a la vez
-- generaban el MISMO número de agendamiento (OC) o de orden de trabajo (RO),
-- que es justamente el número que se le dicta al cliente.
--
-- Acá el número lo entrega la base, de a uno y sin repetir. `p_minimo` deja que
-- el cliente empuje el contador hacia arriba la primera vez (lo que ya tenía
-- guardado la estación), así ninguna sucursal empieza por debajo de lo que ya
-- usó. Todo ocurre en UNA sola sentencia: dos llamadas simultáneas no pueden
-- llevarse el mismo valor.
--
-- ADITIVO e idempotente.
-- =============================================================

create table if not exists public.correlativos (
  sucursal text not null,
  tipo     text not null check (tipo in ('oc', 'ro')),
  valor    bigint not null,
  primary key (sucursal, tipo)
);

comment on table public.correlativos is
  'Siguiente número libre de OC / RO por sucursal. Se toma con siguiente_correlativo().';

-- Devuelve el número a usar y deja el contador en el siguiente. `security
-- definer` para que pueda escribir la tabla sin abrirla por RLS; el permiso
-- real lo da el chequeo de dominio de acá abajo.
create or replace function public.siguiente_correlativo(
  p_sucursal text,
  p_tipo     text,
  p_minimo   bigint default 0
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare v_num bigint;
begin
  if coalesce(lower(auth.jwt() ->> 'email'), '') not like '%@curifor.com' then
    raise exception 'no autorizado';
  end if;
  if p_tipo not in ('oc', 'ro') then
    raise exception 'tipo invalido: %', p_tipo;
  end if;

  insert into public.correlativos as c (sucursal, tipo, valor)
       values (p_sucursal, p_tipo, greatest(p_minimo, 1) + 1)
  on conflict (sucursal, tipo)
    do update set valor = greatest(c.valor, p_minimo) + 1
  returning c.valor - 1 into v_num;

  return v_num;
end $$;

revoke all on function public.siguiente_correlativo(text, text, bigint) from public, anon;
grant execute on function public.siguiente_correlativo(text, text, bigint) to authenticated;

-- La tabla no se toca directo desde el navegador: solo a través de la función.
alter table public.correlativos enable row level security;
