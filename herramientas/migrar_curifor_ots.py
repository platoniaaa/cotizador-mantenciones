# -*- coding: utf-8 -*-
"""
Migración inicial de curifor-ots (la app Streamlit que guardaba todo en JSON
dentro de GitHub) a tablas reales de Supabase — Fase 1 del plan del 10-08-2026.

Uso:
    python migrar_curifor_ots.py [--origen RUTA_curifor-ots-main]

La conexión usa la variable de entorno PGPASSWORD (igual que los demás
scripts de esta carpeta).

Qué hace, en orden:
  1. Aplica el esquema (setup_supabase_ots.sql, junto a este script).
  2. Carga sucursales canónicas + alias del mundo viejo.
  3. Carga: ots (2.069), ots_gestion (~1.461), ots_comentarios (~308),
     notificaciones (~99), auditoria (~2.000), stock_repuestos (~30.044).
  4. Copia la restricción por sucursal de cada usuario -> personal (por correo).
  5. Refresca en `documentos` los JSON aún no modelados y borra los obsoletos.
  6. Verifica: conteos, RLS como anon y como personal.

OJO: ots/stock se recargan completos (propiedad del ETL). Los datos "humanos"
(gestión, comentarios, notificaciones, auditoría) TAMBIÉN se recargan aquí,
porque la fuente de verdad sigue siendo la app vieja hasta el corte de cada
módulo. Después del corte, NO volver a correr este script sin pensarlo.
"""
import argparse
import json
import os
import re
import ssl
import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo

import pg8000.dbapi

AQUI = os.path.dirname(os.path.abspath(__file__))
TZ = ZoneInfo("America/Santiago")

ORIGEN_DEF = (r"C:\Users\icalderon\OneDrive - Curifor S.A\Documentos\Desarrollos"
              r"\Plataformas\CURIFOR\CURIFOR POST VENTA\curifor-ots-main\curifor-ots-main")

# ---------------------------------------------------------------- sucursales
# El nombre canónico es el de la agenda (taller.html). El mundo viejo se mapea
# por alias; lo que no calce hace fallar la carga A PROPÓSITO (mejor saberlo).
CANON = [
    # (id, nombre canónico, nota)
    ("chillan",         "CURIFOR CHILLÁN",            None),
    ("chillan-viejo",   "CURIFOR CHILLÁN VIEJO",      None),
    ("curico",          "CURIFOR CURICÓ",             None),
    ("linderos",        "CURIFOR LINDEROS",           None),
    ("lo-blanco",       "CURIFOR LO BLANCO",          None),
    ("macul",           "CURIFOR MACUL (AUTO-PARK)",  None),
    ("placilla",        "CURIFOR PLACILLA",           None),
    ("rancagua",        "CURIFOR RANCAGUA",           None),
    ("talca",           "CURIFOR TALCA",              None),
    ("talca-bmw",       "CURIFOR TALCA BMW",          "en la agenda; sin personal asignado aún"),
    ("talca-camiones",  "CURIFOR TALCA CAMIONES",     "en la agenda; sin personal asignado aún"),
    ("taller-movil",    "CURIFOR TALLER MOVIL",       None),
    # Solo existen en el mundo viejo (OTs / tableros):
    ("cd-repuestos",    "CD REPUESTOS",    "centro de distribución; no agenda citas"),
    ("talca-2",         "TALCA (2)",       "PENDIENTE Ignacio: ¿es Talca BMW o Talca Camiones?"),
    ("la-florida",      "LA FLORIDA",      "solo OTs del mundo viejo"),
    ("ovalle-mall",     "OVALLE MALL",     "solo OTs del mundo viejo"),
    ("rancagua-2",      "RANCAGUA 2",      "solo OTs del mundo viejo"),
    ("rancagua-usados", "RANCAGUA USADOS", "solo OTs del mundo viejo"),
]

ALIAS = {
    # mundo viejo -> id canónico
    "CHILLAN": "chillan",
    "CHILLAN VIEJO": "chillan-viejo",
    "Chillán Viejo": "chillan-viejo",
    "CURICO": "curico",
    "LINDEROS": "linderos",
    "LO BLANCO": "lo-blanco",
    "MACUL": "macul",
    "Autopark": "macul",
    "AUTOPARK": "macul",
    "PLACILLA": "placilla",
    "RANCAGUA": "rancagua",
    "TALCA": "talca",
    "TALCA (2)": "talca-2",
    "CD REPUESTOS": "cd-repuestos",
    "LA FLORIDA": "la-florida",
    "OVALLE MALL": "ovalle-mall",
    "RANCAGUA 2": "rancagua-2",
    "RANCAGUA USADOS": "rancagua-usados",
    # variante con tilde del taller móvil (la etiqueta visible la lleva)
    "CURIFOR TALLER MÓVIL": "taller-movil",
}
# cada nombre canónico también es alias de sí mismo
for _id, _nom, _ in CANON:
    ALIAS.setdefault(_nom, _id)

NOMBRE_POR_ID = {i: n for i, n, _ in CANON}


def _norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s).strip().upper()


ALIAS_NORM = {_norm(a): i for a, i in ALIAS.items()}


def canon_nombre(crudo):
    """Nombre canónico de una sucursal escrita de cualquier forma. Falla si no calza."""
    s = (crudo or "").strip()
    sid = ALIAS.get(s) or ALIAS_NORM.get(_norm(s))
    if not sid:
        raise SystemExit(f"Sucursal sin mapear: {crudo!r} — agregarla a ALIAS antes de cargar.")
    return NOMBRE_POR_ID[sid]


# ---------------------------------------------------------------- parsers
def texto(v):
    s = str(v).strip() if v is not None else ""
    return s or None


def entero(v, avisos, campo):
    s = str(v).strip() if v is not None else ""
    if not s:
        return None
    try:
        return int(s.replace(".", "").replace(",", ""))
    except ValueError:
        avisos[campo] = avisos.get(campo, 0) + 1
        return None


def numero(v, avisos, campo):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return v
    try:
        return float(str(v).strip().replace(",", "."))
    except ValueError:
        avisos[campo] = avisos.get(campo, 0) + 1
        return None


def fecha_ddmm(v, avisos, campo):
    s = str(v).strip() if v is not None else ""
    if not s:
        return None
    for fmt in ("%d/%m/%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    avisos[campo] = avisos.get(campo, 0) + 1
    return None


def fecha_hora(v, avisos, campo):
    s = str(v).strip() if v is not None else ""
    for fmt in ("%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).replace(tzinfo=TZ)
        except ValueError:
            pass
    avisos[campo] = avisos.get(campo, 0) + 1
    return datetime.now(TZ)   # la columna es not null; se anota el aviso


def js(v):
    return json.dumps(v, ensure_ascii=False) if v else None


def desmoji(s):
    """Repara texto UTF-8 leído como Latin-1 ('DAÃ‘ADOS' -> 'DAÑADOS')."""
    if isinstance(s, str) and ("Ã" in s or "Â" in s):
        try:
            return s.encode("latin-1").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return s
    return s


# ---------------------------------------------------------------- infraestructura
CONN = None      # la conexión, para poder confirmar/revertir de verdad


def conectar():
    """Conexión SIN autocommit, a propósito.

    Con autocommit encendido, un begin/rollback mandado por el cursor NO
    revierte nada: cada sentencia se confirma sola. Eso significaba que una
    carga a medias (por ejemplo, si el JSON trae una sucursal sin mapear en
    la fila 900) dejaba la tabla con el `delete` hecho y solo parte de las
    filas puestas, sin aviso. Ahora la transacción la maneja la conexión.
    """
    global CONN
    pwd = os.environ.get("PGPASSWORD", "")
    if not pwd:
        raise SystemExit("Falta la variable de entorno PGPASSWORD.")
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    CONN = pg8000.dbapi.connect(
        user="postgres.ordgsglujssgzmnlmcus", password=pwd,
        host="aws-0-us-east-1.pooler.supabase.com", port=5432,
        database="postgres", ssl_context=ctx, timeout=90,
    )
    CONN.autocommit = False
    return CONN


def aplicar_sql(cur, ruta):
    """Ejecuta un .sql sentencia por sentencia (respeta bloques $$...$$)."""
    crudo = open(ruta, "r", encoding="utf-8").read()
    lineas = [l for l in crudo.split("\n") if not l.strip().startswith("--")]
    texto_sql = "\n".join(lineas)
    sentencias, actual, en_dolar = [], [], False
    for trozo in texto_sql.split(";"):
        actual.append(trozo)
        if trozo.count("$$") % 2 == 1:
            en_dolar = not en_dolar
        if not en_dolar:
            stmt = ";".join(actual).strip()
            if stmt:
                sentencias.append(stmt)
            actual = []
    for stmt in sentencias:
        cur.execute(stmt)
    return len(sentencias)


def insertar_lote(cur, tabla, cols, filas, moldes=None, tamano=400):
    """INSERT multifila por lotes. `moldes` permite castear columnas (p.ej. ::jsonb)."""
    if not filas:
        return 0
    moldes = moldes or {}
    ph_fila = "(" + ",".join(moldes.get(c, "%s") for c in cols) + ")"
    base = f"insert into public.{tabla} ({','.join(cols)}) values "
    total = 0
    for i in range(0, len(filas), tamano):
        lote = filas[i:i + tamano]
        cur.execute(base + ",".join([ph_fila] * len(lote)),
                    [v for fila in lote for v in fila])
        total += len(lote)
    return total


def cargar_json(origen, nombre):
    with open(os.path.join(origen, nombre), "r", encoding="utf-8") as f:
        return json.load(f)


# ---------------------------------------------------------------- cargas
def cargar_sucursales(cur):
    for sid, nombre, nota in CANON:
        cur.execute(
            """insert into public.sucursales (id, nombre, nota) values (%s, %s, %s)
               on conflict (id) do update set nombre = excluded.nombre, nota = excluded.nota""",
            (sid, nombre, nota))
    for alias, sid in ALIAS.items():
        cur.execute(
            """insert into public.sucursal_alias (alias, sucursal_id) values (%s, %s)
               on conflict (alias) do update set sucursal_id = excluded.sucursal_id""",
            (alias, sid))
    print(f"  sucursales: {len(CANON)} canónicas, {len(ALIAS)} alias")


CAMPOS_OTS = [
    # (columna, clave JSON, parser: t=texto e=entero f=fecha j=json c=canon)
    ("folio_ot", "FOLIO OT", "t"), ("sucursal", "SUCURSAL", "c"),
    ("rango", "RANGO", "t"), ("dias_apertura", "DIAS APERTURA", "e"),
    ("fecha_ot", "FECHA OT", "f"), ("anio_vehiculo", "AÑO", "t"),
    ("tipo_venta", "TIPO VENTA", "t"), ("tipo_cliente", "TIPO CLIENTE", "t"),
    ("marca", "MARCA", "t"), ("modelo", "MODELO", "t"), ("patente", "PATENTE", "t"),
    ("asesor", "ASESOR", "t"), ("estado", "ESTADO", "t"), ("importador", "IMPORTADOR", "t"),
    ("neto", "NETO", "e"), ("glosa_trabajo", "GLOSA TRABAJO", "t"),
    ("rut_cliente", "rut_cliente", "t"),
    ("n_liq_st", "N_LIQ_ST", "e"), ("folios_liq_st", "FOLIOS_LIQ_ST", "t"),
    ("n_fact_cliente", "N_FACT_CLIENTE", "e"), ("folios_fact_cliente", "FOLIOS_FACT_CLIENTE", "t"),
    ("n_fact_compania", "N_FACT_COMPANIA", "e"), ("folios_fact_compania", "FOLIOS_FACT_COMPANIA", "t"),
    ("n_cargo_int", "N_CARGO_INT", "e"), ("folios_cargo_int", "FOLIOS_CARGO_INT", "t"),
    ("n_cargo_gtia", "N_CARGO_GTIA", "e"), ("folios_cargo_gtia", "FOLIOS_CARGO_GTIA", "t"),
    ("n_fact_gtia", "N_FACT_GTIA", "e"), ("folios_fact_gtia", "FOLIOS_FACT_GTIA", "t"),
    ("n_vale_consumo", "N_VALE_CONSUMO", "e"), ("folios_vale_consumo", "FOLIOS_VALE_CONSUMO", "t"),
    ("fecha_fact_cliente", "FECHA_FACT_CLIENTE", "f"),
    ("fecha_fact_compania", "FECHA_FACT_COMPANIA", "f"),
    ("anticipo", "anticipo", "j"), ("repuestos_actual", "repuestos_actual", "j"),
    ("repuestos_historico", "repuestos_historico", "j"),
    ("repuestos_compras", "repuestos_compras", "j"),
]

CAMPOS_GESTION = [
    ("categoria", "CATEGORIA"), ("observacion_ot", "OBSERVACION OT"),
    ("notas", "NOTAS"), ("avance_gestion", "AVANCE - GESTIÓN"),
    ("marca_color", "_MARCA_COLOR_"), ("etapa_jpcb", "ETAPA_JPCB"),
    ("ultima_edicion", "ULTIMA_EDICION"),
]


def cargar_ots(cur, origen):
    d = cargar_json(origen, "datos_dashboard.json")
    avisos = {}
    filas, gestion = [], []
    for o in d["ots"]:
        fila = []
        for col, clave, tipo in CAMPOS_OTS:
            v = o.get(clave)
            if tipo == "t":
                fila.append(texto(v))
            elif tipo == "e":
                fila.append(entero(v, avisos, col))
            elif tipo == "f":
                fila.append(fecha_ddmm(v, avisos, col))
            elif tipo == "j":
                fila.append(js(v))
            elif tipo == "c":
                fila.append(canon_nombre(v))
        filas.append(fila)
        g = [texto(o.get(clave)) for _, clave in CAMPOS_GESTION]
        if any(g):
            gestion.append([texto(o.get("FOLIO OT")), canon_nombre(o.get("SUCURSAL"))] + g)

    cols = [c for c, _, _ in CAMPOS_OTS]
    moldes = {c: "%s::jsonb" for c, _, t in CAMPOS_OTS if t == "j"}
    cur.execute("delete from public.ots")
    n = insertar_lote(cur, "ots", cols, filas, moldes, tamano=100)
    cur.execute("delete from public.ots_gestion")
    cols_g = ["folio_ot", "sucursal"] + [c for c, _ in CAMPOS_GESTION]
    ng = insertar_lote(cur, "ots_gestion", cols_g, gestion)
    CONN.commit()
    print(f"  ots: {n} filas (actualizado: {d.get('fecha_actualizacion')})")
    print(f"  ots_gestion: {ng} filas con trabajo humano")
    if avisos:
        print(f"    avisos de parseo: {avisos}")


def cargar_comentarios(cur, origen):
    d = cargar_json(origen, "comentarios_log.json")["comentarios"]
    avisos = {}
    filas = sorted(
        ([texto(c.get("folio_ot")) or "?", texto(c.get("autor")) or "?",
          fecha_hora(c.get("fecha"), avisos, "fecha"), texto(c.get("comentario")) or ""]
         for c in d), key=lambda f: f[2])
    cur.execute("truncate table public.ots_comentarios restart identity")
    n = insertar_lote(cur, "ots_comentarios", ["folio_ot", "autor", "fecha", "comentario"], filas)
    CONN.commit()
    print(f"  ots_comentarios: {n} filas" + (f" (avisos: {avisos})" if avisos else ""))


def cargar_notificaciones(cur, origen):
    d = cargar_json(origen, "notificaciones.json")["notificaciones"]
    avisos = {}
    filas = [[texto(x.get("id")), texto(x.get("remitente")) or "?",
              texto(x.get("destinatario")) or "?", texto(x.get("folio_ot")),
              texto(x.get("extracto")), fecha_hora(x.get("fecha"), avisos, "fecha"),
              bool(x.get("leida"))] for x in d]
    cur.execute("delete from public.notificaciones")
    n = insertar_lote(cur, "notificaciones",
                      ["id", "remitente", "destinatario", "folio_ot", "extracto", "fecha", "leida"],
                      filas, {"id": "%s::uuid"})
    CONN.commit()
    print(f"  notificaciones: {n} filas" + (f" (avisos: {avisos})" if avisos else ""))


def cargar_auditoria(cur, origen):
    d = cargar_json(origen, "audit_log.json")["registros"]
    avisos = {}
    filas = sorted(
        ([fecha_hora(r.get("fecha"), avisos, "fecha"), texto(r.get("usuario")) or "?",
          texto(r.get("accion")) or "?", texto(r.get("detalle")), texto(r.get("folio_ot"))]
         for r in d), key=lambda f: f[0])
    cur.execute("truncate table public.auditoria restart identity")
    n = insertar_lote(cur, "auditoria", ["fecha", "usuario", "accion", "detalle", "folio_ot"], filas)
    CONN.commit()
    print(f"  auditoria: {n} filas" + (f" (avisos: {avisos})" if avisos else ""))


def cargar_stock(cur, origen):
    d = cargar_json(origen, "stock_repuestos.json")
    avisos, vistos, filas, dupes = {}, set(), [], 0
    for p in d["productos"]:
        prod = texto(desmoji(p.get("producto"))) or ""
        bod = texto(desmoji(p.get("bodega"))) or ""
        if (prod, bod) in vistos:      # duplicados que crea la reparación de mojibake
            dupes += 1
            continue
        vistos.add((prod, bod))
        filas.append([
            prod, bod, texto(desmoji(p.get("descripcion"))),
            numero(p.get("stock"), avisos, "stock"),
            numero(p.get("stock_proyectado"), avisos, "stock_proyectado"),
            numero(p.get("precio_venta"), avisos, "precio_venta"),
            numero(p.get("costo"), avisos, "costo"),
            texto(desmoji(p.get("familia"))), texto(desmoji(p.get("subfamilia"))),
            texto(desmoji(p.get("procedencia"))), texto(desmoji(p.get("categoria"))),
            texto(desmoji(p.get("clasificacion_stock"))),
        ])
    cur.execute("delete from public.stock_repuestos")
    n = insertar_lote(cur, "stock_repuestos",
                      ["producto", "bodega", "descripcion", "stock", "stock_proyectado",
                       "precio_venta", "costo", "familia", "subfamilia", "procedencia",
                       "categoria", "clasificacion_stock"], filas, tamano=800)
    CONN.commit()
    extra = f", {dupes} duplicados tras reparar codificación" if dupes else ""
    print(f"  stock_repuestos: {n} filas (actualizado: {d.get('fecha_actualizacion')}{extra})"
          + (f" (avisos: {avisos})" if avisos else ""))


def cargar_permitidas(cur, origen):
    usuarios = cargar_json(origen, "usuarios_curifor.json")["usuarios"]
    aplicados, sin_fila, sin_mapa = 0, [], set()
    for u in usuarios:
        email = (u.get("email") or "").strip().lower()
        crudas = u.get("sucursales_permitidas") or []
        if not email or not crudas:
            continue
        nombres = []
        for s in crudas:
            try:
                nombres.append(canon_nombre(s))
            except SystemExit:
                sin_mapa.add(s)
                nombres.append(s)      # se conserva tal cual para no perder la restricción
        cur.execute("update public.personal set sucursales_permitidas = %s where lower(email) = %s",
                    (nombres, email))
        if cur.rowcount:
            aplicados += 1
        else:
            sin_fila.append(email)
    print(f"  personal.sucursales_permitidas: {aplicados} usuarios con restricción aplicada")
    if sin_fila:
        print(f"    con restricción pero SIN fila en personal ({len(sin_fila)}): {', '.join(sorted(sin_fila))}")
    if sin_mapa:
        print(f"    sucursales sin mapa canónico (se dejaron tal cual): {sorted(sin_mapa)}")


DOCS_REFRESCAR = [
    "agenda_hoy.json", "campanas_curifor.json", "control_taller.json",
    "cuenta_ficha.json", "cuenta_ficha_revisados.json", "historial_cierres.json",
    "informes_gestion.json", "loaners.json", "prepicking_estados.json",
    "produccion_tecnicos.json", "ranking_cierres.json",
    "tecnicos_sucursal_manual.json", "tempario.json",
]
# ya modelados como tablas, o muertos con la app vieja
DOCS_BORRAR = [
    "datos_dashboard.json", "stock_repuestos.json", "audit_log.json",
    "comentarios_log.json", "notificaciones.json", "usuarios_curifor.json",
    "online_users.json", "cotizador_data.json", "taller_data.json",
]


def refrescar_documentos(cur, origen):
    for nombre in DOCS_REFRESCAR:
        datos = cargar_json(origen, nombre)
        cur.execute(
            """insert into public.documentos (nombre, data, mensaje)
               values (%s, %s::jsonb, %s)
               on conflict (nombre) do update
                 set data = excluded.data, actualizado = now(), mensaje = excluded.mensaje""",
            (nombre, json.dumps(datos, ensure_ascii=False), "migración fase 1 (copia local 07-08-2026)"))
    cur.execute("delete from public.documentos where nombre = any(%s)", (DOCS_BORRAR,))
    print(f"  documentos: {len(DOCS_REFRESCAR)} refrescados, {cur.rowcount} obsoletos borrados")


# ---------------------------------------------------------------- verificación
def verificar(cur):
    print("\n=== VERIFICACIÓN ===")
    for t in ["sucursales", "sucursal_alias", "ots", "ots_gestion", "ots_comentarios",
              "notificaciones", "auditoria", "stock_repuestos", "documentos"]:
        cur.execute(f"select count(*) from public.{t}")
        print(f"  {t:18} {cur.fetchone()[0]:>7,} filas")

    print("\n  OTs por sucursal (canónica):")
    cur.execute("select sucursal, count(*) from public.ots group by 1 order by 2 desc")
    for s, n in cur.fetchall():
        print(f"    {s:28} {n:>5}")

    cur.execute("""select count(*) from public.ots o
                   join public.ots_gestion g using (folio_ot)""")
    print(f"\n  join ots<->gestion: {cur.fetchone()[0]} coinciden")

    # RLS: anon no ve nada; el personal ve todo
    cur.execute("set local role anon")
    visibles = []
    for t in ["ots", "ots_gestion", "stock_repuestos", "auditoria", "notificaciones"]:
        cur.execute(f"select count(*) from public.{t}")
        visibles.append((t, cur.fetchone()[0]))
    CONN.rollback()
    print("  como anon:", ", ".join(f"{t}={n}" for t, n in visibles),
          "(correcto: todo 0)" if not any(n for _, n in visibles) else "<- ¡DEBE SER TODO 0!")
    cur.execute("select set_config('request.jwt.claims', '{\"email\":\"icalderon@curifor.com\"}', true)")
    cur.execute("set local role authenticated")
    cur.execute("select count(*) from public.ots")
    n_staff = cur.fetchone()[0]
    CONN.rollback()
    print(f"  como personal (@curifor.com): ots={n_staff} <- debe ser el total")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--origen", default=ORIGEN_DEF, help="carpeta curifor-ots-main con los JSON")
    ap.add_argument("--solo-verificar", action="store_true", help="no carga nada; solo muestra conteos y RLS")
    args = ap.parse_args()

    if not args.solo_verificar and not os.path.isfile(os.path.join(args.origen, "datos_dashboard.json")):
        raise SystemExit(f"No encuentro datos_dashboard.json en {args.origen}")

    c = conectar()
    cur = c.cursor()
    try:
        if not args.solo_verificar:
            n = aplicar_sql(cur, os.path.join(AQUI, "setup_supabase_ots.sql"))
            print(f"esquema aplicado ({n} sentencias)")
            print("cargando:")
            cargar_sucursales(cur)
            cargar_ots(cur, args.origen)
            cargar_comentarios(cur, args.origen)
            cargar_notificaciones(cur, args.origen)
            cargar_auditoria(cur, args.origen)
            cargar_stock(cur, args.origen)
            cargar_permitidas(cur, args.origen)
            refrescar_documentos(cur, args.origen)
            c.commit()          # cierra lo que no confirmó cada carga
        verificar(cur)
    except Exception:
        # Si algo revienta a mitad de camino, no dejar tablas con el `delete`
        # hecho y las filas a medio poner.
        try:
            c.rollback()
            print("\n>>> ERROR: se revirtió todo lo no confirmado.")
        except Exception:
            pass
        raise
    finally:
        c.close()


if __name__ == "__main__":
    main()
