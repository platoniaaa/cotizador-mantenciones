# -*- coding: utf-8 -*-
"""
Auditoría de fidelidad de SKU: Excel de origen  vs  lo que muestra la plataforma.

Distinta de auditar_codigos.py (esa compara pautas vs STOCK). Esta responde:
  "¿el repuesto/SKU que muestra la plataforma es EXACTAMENTE el del Excel?"

Dos niveles:
  N1 (todas las marcas): ¿cada código de la plataforma existe literalmente en el
      libro Excel de origen? Detecta códigos inventados o transformados.
  N2 (familias de layout uniforme): comparación fila a fila dentro de la hoja de
      origen (vía el campo `fuente` de cada pauta):
        - FALTA   : fila con valores en el Excel que no aparece en la plataforma
        - SOBRA   : ítem en la plataforma sin fila equivalente en el Excel
        - DISTINTO: mismo repuesto pero el código no coincide con la fila

Uso:
  python herramientas/auditar_sku.py [carpeta_con_los_excel]
  (por defecto usa la carpeta padre del proyecto; pásale otra si los originales
   están bloqueados y trabajas sobre copias)

Salida: herramientas/auditoria_sku.md
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

AQUI = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(AQUI, "..", "data"))
BASE_DEFECTO = os.path.normpath(os.path.join(AQUI, "..", ".."))

# el material/insumo genérico no lleva SKU en las pautas
SIN_SKU = ("MATERIAL", "INSUMO")
PLACEHOLDERS = ("COMPRA EN PLAZA", "PENDIENTE", "INGRESAR", "MAT-", "N/A", "NA", "MAT")


def norm(c):
    return re.sub(r"[^A-Z0-9]", "", str(c).upper()) if c is not None else ""


def nnom(s):
    import unicodedata
    s = unicodedata.normalize("NFD", str(s or ""))
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")   # quita tildes
    s = re.sub(r"\s+", " ", s).strip().upper()
    return re.sub(r"[^A-Z0-9 ]", "", s)


def es_placeholder(cod):
    c = str(cod).upper().strip()
    return any(c.startswith(p) or c == p for p in PLACEHOLDERS)


# --------------------------------------------------------------------------- lectura Excel

def celdas_libro(ruta):
    """Devuelve {hoja: [filas]} con todos los valores del libro (xlsx/xlsm/xlsb)."""
    hojas = {}
    if ruta.lower().endswith(".xlsb"):
        from pyxlsb import open_workbook
        with open_workbook(ruta) as wb:
            for nombre in wb.sheets:
                with wb.get_sheet(nombre) as ws:
                    filas = []
                    for row in ws.rows():
                        f = [None] * 40
                        for c in row[:40]:
                            if c.c is not None and c.c < 40:
                                f[c.c] = c.v
                        filas.append(f)
                        if len(filas) > 200:
                            break
                    hojas[nombre.strip()] = filas
        return hojas
    import openpyxl
    wb = openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    for ws in wb.worksheets:
        filas = []
        for row in ws.iter_rows(min_row=1, max_row=200, max_col=40, values_only=True):
            filas.append(list(row))
        hojas[ws.title.strip()] = filas
    wb.close()
    return hojas


def tokens_libro(hojas):
    """Todos los valores de celda del libro, normalizados (para el chequeo N1)."""
    t = set()
    for filas in hojas.values():
        for f in filas:
            for v in f:
                if v is None:
                    continue
                n = norm(v)
                if n:
                    t.add(n)
    return t


# --------------------------------------------------------------------------- N2: fila a fila

def eje_km(filas):
    """(idx_fila, [cols]) del eje de kilometraje. Reglas simples y comunes a las
    familias de layout uniforme (estándar/GAC/Hyundai)."""
    for i, f in enumerate(filas[:15]):
        etiqueta = " ".join(str(v).lower() for v in f[:12] if v is not None)
        if "kilometraje" not in etiqueta and "kilometros" not in etiqueta:
            continue
        for cand in (i, i + 1):
            if cand >= len(filas):
                continue
            cols = []
            for c in range(1, len(filas[cand])):
                v = filas[cand][c]
                if isinstance(v, (int, float)) and not isinstance(v, bool) and v and v == int(v):
                    if 1 <= v <= 300000:
                        cols.append(c)
            if len(cols) >= 4:
                return cand, cols
    return None, []


def filas_item_excel(filas, idx_eje, cols_km):
    """Filas de repuesto del Excel: nombre + celdas crudas previas al eje + si aplica
    en algún kilometraje. Devuelve [{nombre, crudas:set, aplica:bool}]."""
    primera = min(cols_km)
    out = []
    for f in filas[idx_eje + 1:]:
        # nombre = primer texto no numérico antes del eje
        nombre = None
        crudas = set()
        for c in range(0, primera):
            v = f[c] if c < len(f) else None
            if v is None:
                continue
            s = str(v).strip()
            if not s:
                continue
            crudas.add(norm(s))
            if nombre is None and not isinstance(v, (int, float)):
                nombre = s
        if not nombre:
            continue
        nn = nnom(nombre)
        if not nn or len(nn) < 3:
            continue
        # a partir del bloque de tempario/operaciones ya no hay repuestos
        # (Omoda/Jaecoo listan ahí las operaciones con sus minutos)
        if nn.startswith("TEMPARIO") or nn.startswith("OPERACION"):
            break
        # cortes: encabezados, totales, notas, y las filas que la plataforma
        # muestra en OTRA sección (mano de obra, materiales, adicionales)
        # 'PASTILLA': Omoda/Jaecoo las listan como referencia bajo el total, pero la
        # propia pauta aclara que las mantenciones NO las incluyen.
        if any(nn.startswith(x) for x in ("TOTAL", "NETO", "NOTA", "DESCUENTO", "VALORES",
                                          "KILOMETROS", "KILOMETRAJE", "MESES", "MANO", "TEMPARIO",
                                          "HORAS", "REPUESTOS", "LUBRICANTES", "CODIGO",
                                          "N REPUESTO", "MATERIAL", "INSUMO", "ALINEACION",
                                          "VALOR MANO", "COSTO", "EMITIDO", "FECHA", "PASTILLA")):
            continue
        aplica = False
        for c in cols_km:
            v = f[c] if c < len(f) else None
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v and v > 0:
                aplica = True
                break
        out.append({"nombre": nombre, "nn": nn, "crudas": crudas, "aplica": aplica})
    return out


# --------------------------------------------------------------------------- main

def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    base = sys.argv[1] if len(sys.argv) > 1 else BASE_DEFECTO
    print(f"Excel de origen: {base}\n")

    # cache de libros
    libros, toks = {}, {}

    def cargar(archivo):
        if archivo not in libros:
            ruta = os.path.join(base, archivo)
            if not os.path.exists(ruta):
                libros[archivo] = None
                toks[archivo] = set()
            else:
                libros[archivo] = celdas_libro(ruta)
                toks[archivo] = tokens_libro(libros[archivo])
        return libros[archivo]

    n1_ok = n1_no = 0
    n1_fallos = defaultdict(list)          # marca -> [(cod, nombre, version)]
    n2 = defaultdict(lambda: {"falta": [], "sobra": [], "distinto": []})
    versiones_n2 = 0
    sin_hoja = []

    for f in sorted(glob.glob(os.path.join(DATA, "pautas", "*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        marca = d["marcaNombre"]
        fuente = d.get("fuente") or ""
        m = re.match(r"^(.*?)\s*/\s*hoja '(.*)'\s*$", fuente)
        archivo = m.group(1).strip() if m else None
        hoja = m.group(2).strip() if m else None
        if not archivo:
            continue
        hojas = cargar(archivo)
        if hojas is None:
            continue

        # ítems distintos de la plataforma
        items = {}
        for pl in d["planes"]:
            for itv in pl["intervalos"]:
                for it in (itv.get("items") or []):
                    cod = it.get("codigo")
                    nom = it.get("nombre") or ""
                    # los materiales/insumos se muestran en su propia sección y se
                    # excluyen también del lado Excel -> fuera de esta comparación
                    if it.get("tipo") == "material" or any(x in nnom(nom) for x in SIN_SKU):
                        continue
                    items[(nnom(nom), norm(cod))] = (nom, cod)

        # ---- N1: el código existe en el libro
        for (nn, nc), (nom, cod) in items.items():
            if not cod or es_placeholder(cod):
                continue
            if nc in toks[archivo]:
                n1_ok += 1
            else:
                n1_no += 1
                n1_fallos[marca].append((cod, nom, d["version"]))

        # ---- N2: fila a fila (solo si encuentro la hoja y su eje km)
        filas = hojas.get(hoja)
        if filas is None:
            sin_hoja.append((marca, d["version"], hoja))
            continue
        idx, cols = eje_km(filas)
        if idx is None:
            continue
        versiones_n2 += 1
        exc = filas_item_excel(filas, idx, cols)
        por_nombre = defaultdict(list)
        for e in exc:
            por_nombre[e["nn"]].append(e)

        vistos = set()
        for (nn, nc), (nom, cod) in items.items():
            cands = por_nombre.get(nn)
            if not cands:
                # ¿coincide parcialmente por prefijo? (nombres truncados en la hoja)
                cands = [e for e in exc if e["nn"].startswith(nn[:18]) or nn.startswith(e["nn"][:18])]
            if not cands:
                n2[marca]["sobra"].append((d["version"], nom, cod))
                continue
            vistos.update(id(c) for c in cands)
            # Omoda/Jaecoo: la hoja del modelo NO tiene columna de código (los SKU
            # se toman de la hoja 'REPUESTOS 2025'), así que comparar contra la
            # fila no aplica. El Nivel 1 igual verifica que el código exista.
            if marca in ("OMODA", "JAECOO"):
                continue
            if cod and not es_placeholder(cod):
                if not any(nc in c["crudas"] for c in cands):
                    n2[marca]["distinto"].append((d["version"], nom, cod,
                                                  sorted(cands[0]["crudas"])[:4]))
        for e in exc:
            if e["aplica"] and id(e) not in vistos:
                n2[marca]["falta"].append((d["version"], e["nombre"]))

    # ---------------- reporte ----------------
    R = ["# Auditoría de SKU: Excel de origen vs plataforma\n"]
    R.append("## Nivel 1 — ¿el código que muestra la plataforma existe en el Excel?\n")
    tot = n1_ok + n1_no
    pct = (n1_ok / tot * 100) if tot else 0
    R.append(f"- Códigos revisados: **{tot}**")
    R.append(f"- **Existen literalmente en el Excel de origen: {n1_ok} ({pct:.1f}%)**")
    R.append(f"- **No se encontraron: {n1_no}**\n")
    if n1_fallos:
        R.append("| Marca | Código en plataforma | Repuesto | Versión |")
        R.append("|---|---|---|---|")
        for marca in sorted(n1_fallos):
            for cod, nom, ver in sorted(set(n1_fallos[marca]))[:40]:
                R.append(f"| {marca} | `{cod}` | {str(nom)[:34]} | {str(ver)[:30]} |")
        R.append("")

    R.append("## Nivel 2 — comparación fila a fila dentro de la hoja de origen\n")
    R.append(f"Versiones auditadas fila a fila: **{versiones_n2}**\n")
    R.append("| Marca | Faltan (en Excel, no en plataforma) | Sobran (en plataforma, no en Excel) | Código distinto |")
    R.append("|---|---:|---:|---:|")
    for marca in sorted(n2):
        v = n2[marca]
        R.append(f"| {marca} | {len(v['falta'])} | {len(v['sobra'])} | {len(v['distinto'])} |")
    R.append("")

    for etiq, clave in (("FALTAN en la plataforma", "falta"),
                        ("SOBRAN en la plataforma", "sobra"),
                        ("CÓDIGO DISTINTO al del Excel", "distinto")):
        hay = any(n2[m][clave] for m in n2)
        if not hay:
            continue
        R.append(f"### {etiq}\n")
        for marca in sorted(n2):
            filas_ = n2[marca][clave]
            if not filas_:
                continue
            R.append(f"**{marca}** ({len(filas_)})\n")
            for x in sorted(set(map(str, filas_)))[:30]:
                R.append(f"- {x}")
            R.append("")

    if sin_hoja:
        R.append("## Versiones cuya hoja no se pudo ubicar\n")
        for marca, ver, hoja in sin_hoja[:20]:
            R.append(f"- {marca} / {ver} / hoja `{hoja}`")
        R.append("")

    with open(os.path.join(AQUI, "auditoria_sku.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(R))

    print(f"N1 códigos revisados: {tot} | existen en Excel: {n1_ok} ({pct:.1f}%) | NO: {n1_no}")
    if n1_fallos:
        print("   marcas con códigos no hallados:", {m: len(set(v)) for m, v in n1_fallos.items()})
    print(f"\nN2 versiones auditadas: {versiones_n2}")
    print(f"{'Marca':10} {'faltan':>7} {'sobran':>7} {'distinto':>9}")
    for marca in sorted(n2):
        v = n2[marca]
        print(f"{marca:10} {len(v['falta']):>7} {len(v['sobra']):>7} {len(v['distinto']):>9}")
    print("\nReporte: herramientas/auditoria_sku.md")


if __name__ == "__main__":
    main()
