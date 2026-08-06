# -*- coding: utf-8 -*-
"""Carga la nomina de postventa (tecnicos y asesores) en Supabase.

Lee el Excel de RRHH y llena public.personal. Los datos personales NO pasan por
el repositorio: van directo del archivo a la base, que tiene RLS @curifor.com.

Uso:
    set PGPASSWORD=...
    python cargar_personal.py "ruta\\Nomina Area PV (Clasificada).xlsx"

Es idempotente: reejecutarlo actualiza (upsert por RUT) y marca `activo=false`
a quien ya no aparezca en la nomina, sin borrar filas -- las ordenes viejas
tienen que seguir resolviendo a quien las atendio.
"""
import os
import ssl
import sys
import unicodedata
from pathlib import Path

import openpyxl
import pg8000.dbapi

# Cargos que marco Ignacio (06-ago-2026)
CARGOS_TECNICO = {
    "MECANICO", "MECANICO 1", "MECANICO - ALINEADOR",
    "MECANICO TALLER MOVIL", "AYUDANTE MECANICO",
}
CARGOS_ASESOR = {"ASESOR"}

# "Lugar de Trabajo" de RRHH -> el nombre EXACTO de sucursal que usa la
# plataforma (taller_estado, reservas_web y el selector de taller.html).
LUGARES = {
    "CURICO":        "CURIFOR CURICÓ",
    "LINDEROS":      "CURIFOR LINDEROS",
    "CHILLAN":       "CURIFOR CHILLÁN",
    "CHILLAN VIEJO": "CURIFOR CHILLÁN VIEJO",
    "TALCA":         "CURIFOR TALCA",
    "RANCAGUA":      "CURIFOR RANCAGUA",
    "PLACILLA":      "CURIFOR PLACILLA",
    "LO BLANCO":     "CURIFOR LO BLANCO",
    "AUTOPARK":      "CURIFOR MACUL (AUTO-PARK)",
}
# El centro de costo manda cuando el lugar de trabajo no es un taller: los
# mecanicos de taller movil figuran en CD REPUESTOS pero pertenecen al movil.
CENTRO_COSTO = {"TALLER MOVIL": "CURIFOR TALLER MOVIL"}

S = lambda v: ("" if v is None else str(v)).strip()


def nombre_corto(completo):
    """'AVALOS GARRIDO JORGE ALONZO' -> 'Jorge Avalos'.

    La nomina viene como APELLIDO1 APELLIDO2 NOMBRE1 [NOMBRE2], que es como lo
    exporta RRHH pero no como se le habla a nadie. La grilla del planificador
    tiene 132 px por fila: el nombre completo no entra.
    """
    p = [x for x in completo.split() if x]
    if len(p) >= 3:
        return f"{p[2].capitalize()} {p[0].capitalize()}"
    if len(p) == 2:
        return f"{p[1].capitalize()} {p[0].capitalize()}"
    return completo.title()


def titulo(s):
    return " ".join(w.capitalize() for w in s.split())


def leer(ruta):
    ws = openpyxl.load_workbook(ruta, read_only=True, data_only=True).worksheets[0]
    filas = [r for r in ws.iter_rows(min_row=2, values_only=True) if S(r[1]) and S(r[2])]
    out, sin_sucursal = [], []
    for r in filas:
        cargo = S(r[2]).upper()
        rol = "tecnico" if cargo in CARGOS_TECNICO else ("asesor" if cargo in CARGOS_ASESOR else None)
        if not rol:
            continue
        rut = S(r[0])
        if not rut:
            continue
        lugar, cc = S(r[6]).upper(), S(r[5]).upper()
        suc = None
        for clave, destino in CENTRO_COSTO.items():
            if clave in cc:
                suc = destino
                break
        if not suc:
            suc = LUGARES.get(lugar)
        nombre = titulo(S(r[1]))
        reg = {
            "rut": rut, "nombre": nombre, "nombre_corto": nombre_corto(S(r[1])),
            "cargo": S(r[2]), "rol": rol, "sucursal": suc,
            "email": S(r[11]).lower() or None,
        }
        (out if suc else sin_sucursal).append((reg, lugar))
    return out, sin_sucursal


def main():
    if len(sys.argv) < 2:
        sys.exit("Uso: python cargar_personal.py <nomina.xlsx>")
    pwd = os.environ.get("PGPASSWORD")
    if not pwd:
        sys.exit("Falta la variable de entorno PGPASSWORD.")

    listos, huerfanos = leer(Path(sys.argv[1]))
    print(f"con sucursal reconocida: {len(listos)}")
    if huerfanos:
        print(f"SIN mapear ({len(huerfanos)}) -- no se cargan, hay que decidir su sucursal:")
        for reg, lugar in huerfanos:
            print(f"   {reg['rol']:8} {reg['nombre_corto']:22} lugar='{lugar}'")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    conn = pg8000.dbapi.connect(user="postgres.ordgsglujssgzmnlmcus", password=pwd,
                                host="aws-0-us-east-1.pooler.supabase.com", port=5432,
                                database="postgres", ssl_context=ctx, timeout=40)
    conn.autocommit = True
    cur = conn.cursor()

    for reg, _ in listos:
        cur.execute("""
            insert into public.personal (rut, nombre, nombre_corto, cargo, rol, sucursal, email, activo, actualizado)
            values (%s, %s, %s, %s, %s, %s, %s, true, now())
            on conflict (rut) do update set
              nombre = excluded.nombre, nombre_corto = excluded.nombre_corto,
              cargo = excluded.cargo, rol = excluded.rol, sucursal = excluded.sucursal,
              email = excluded.email, activo = true, actualizado = now()
        """, (reg["rut"], reg["nombre"], reg["nombre_corto"], reg["cargo"],
              reg["rol"], reg["sucursal"], reg["email"]))

    ruts = [r["rut"] for r, _ in listos]
    cur.execute("update public.personal set activo = false, actualizado = now() "
                "where activo and not (rut = any(%s))", (ruts,))
    if cur.rowcount:
        print(f"dados de baja (ya no estan en la nomina): {cur.rowcount}")

    print()
    cur.execute("""select sucursal,
                          count(*) filter (where rol='tecnico') tec,
                          count(*) filter (where rol='asesor')  ase
                   from public.personal where activo
                   group by sucursal order by sucursal""")
    print(f"{'SUCURSAL':28} TEC  ASE")
    for suc, tec, ase in cur.fetchall():
        print(f"  {str(suc):26} {tec:<4} {ase}")
    conn.close()


if __name__ == "__main__":
    main()
