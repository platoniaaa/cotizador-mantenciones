# -*- coding: utf-8 -*-
"""
Genera data/stock.json cruzando las 2 tablas de stock de Curifor con los códigos
de repuestos que usan las pautas de mantención.

Fuentes (viven en SharePoint, se van actualizando):
  - Stock bodegas.xlsx           -> giro CURIFOR (autos livianos: repuestos de las pautas)
  - Stock bodegas Frontera.xlsx  -> giro FRONTERA (camiones)

Uso:
  python herramientas/actualizar_stock.py             # usa el snapshot en herramientas/stock_fuente/
  python herramientas/actualizar_stock.py --descargar # baja primero las tablas frescas de SharePoint

La descarga reutiliza el módulo subir_sharepoint.py del proyecto Data BI
(perfil Playwright ya logueado + REST). Si la sesión expiró, correr allá:
  python subir_sharepoint.py login

Salida: data/stock.json  (solo los códigos que aparecen en alguna pauta) y un
resumen impreso + herramientas/stock_reporte.md.
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

AQUI = os.path.dirname(os.path.abspath(__file__))
FUENTE = os.path.join(AQUI, "stock_fuente")
DATA = os.path.normpath(os.path.join(AQUI, "..", "data"))
AUTOM = r"C:\Users\icalderon\OneDrive - Curifor S.A\Documentos\Desarrollos\Automatizaciones\3. Actualizacion\automatizacion"

ARCHIVO_CURIFOR = "Stock bodegas.xlsx"
ARCHIVO_FRONTERA = "Stock bodegas Frontera.xlsx"


def norm(c):
    return re.sub(r"[^A-Z0-9]", "", str(c).upper()) if c is not None else ""


def descargar_de_sharepoint():
    """Baja las 2 tablas desde SharePoint al folder stock_fuente/. Reusa subir_sharepoint."""
    import urllib.request
    from urllib.parse import quote

    sys.path.insert(0, AUTOM)
    cwd = os.getcwd()
    os.chdir(AUTOM)
    try:
        from subir_sharepoint import _cookies, SITE, FOLDER, _SSL_CTX
        ck = _cookies()
        os.makedirs(FUENTE, exist_ok=True)
        for nombre in (ARCHIVO_CURIFOR, ARCHIVO_FRONTERA):
            url = f"{SITE}/_api/web/GetFileByServerRelativeUrl('{quote(FOLDER + '/' + nombre)}')/$value"
            req = urllib.request.Request(url, headers={"Cookie": ck, "Accept": "application/octet-stream"})
            with urllib.request.urlopen(req, timeout=300, context=_SSL_CTX) as r:
                data = r.read()
            with open(os.path.join(FUENTE, nombre), "wb") as f:
                f.write(data)
            print(f"  descargado {nombre}: {len(data)/1024/1024:.2f} MB")
        return True
    except Exception as e:
        print(f"  AVISO: no se pudo descargar de SharePoint ({e}).")
        print("  Se usará el último snapshot en stock_fuente/. Para refrescar la sesión: "
              "python subir_sharepoint.py login (en el proyecto Data BI).")
        return False
    finally:
        os.chdir(cwd)


def leer_stock(ruta, con_rubro):
    """Lee una tabla de stock. Devuelve (idx, crudo):
      idx  = {codigoNorm: {stock, desc, precio, bodegas:set}}  (por código limpio)
      crudo = [ (codigoNorm, descNorm, stock, desc, precio, bodega) ]  (para cruce secundario)
    """
    import openpyxl
    idx = {}
    crudo = []
    if not os.path.exists(ruta):
        return idx, crudo
    wb = openpyxl.load_workbook(ruta, read_only=True, data_only=True)
    ws = wb.worksheets[0]
    filas = ws.iter_rows(min_row=1, values_only=True)
    encab = next(filas)
    col = {str(v).strip().lower(): i for i, v in enumerate(encab) if v is not None}

    def gi(row, *nombres, default=None):
        for n in nombres:
            if n in col and col[n] < len(row):
                return row[col[n]]
        return default

    for row in filas:
        prod = gi(row, "producto")
        if prod is None:
            continue
        prod = str(prod).strip()
        # código limpio: quitar rubro (primer token) en el stock Curifor
        if con_rubro and " " in prod:
            codigo = prod.split(" ", 1)[1].strip()
        else:
            codigo = prod
        nc = norm(codigo)
        if not nc:
            continue
        stock = gi(row, "stock", default=0) or 0
        if not isinstance(stock, (int, float)):
            stock = 0
        desc = gi(row, "descripción", "descripcion")
        precio = gi(row, "precio venta")
        bodega = gi(row, "bodega")
        precio = int(round(precio)) if isinstance(precio, (int, float)) and precio else None
        descs = str(desc).strip() if desc else None
        bod = str(bodega).strip() if bodega and str(bodega).strip() else None
        e = idx.setdefault(nc, {"stock": 0, "desc": None, "precio": None, "bodegas": set()})
        e["stock"] += stock
        if descs and not e["desc"]:
            e["desc"] = descs
        if precio and not e["precio"]:
            e["precio"] = precio
        if bod:
            e["bodegas"].add(bod)
        # tokens de la descripción (separados por no-alfanuméricos) para cruce por código
        tokens = frozenset(t for t in re.split(r"[^A-Z0-9]+", descs.upper()) if t) if descs else frozenset()
        crudo.append((nc, tokens, stock, descs, precio, bod))
    wb.close()
    return idx, crudo


def buscar_secundario(nc, crudo):
    """Cruce difuso para códigos que no matchean directo (típico: lubricantes a granel
    catalogados como presentaciones '104406-AG' o con el código como token de la descripción).
    Evita falsos positivos: el código debe ser un prefijo con sufijo de letras, o un token
    COMPLETO de la descripción (no un substring embebido). Devuelve dict acumulado o None."""
    if len(nc) < 6:
        return None
    acc = {"stock": 0, "desc": None, "precio": None, "bodegas": set()}
    encontrado = False
    for codigoNorm, tokens, stock, desc, precio, bod in crudo:
        match = False
        # presentación con sufijo de letras: 104406 -> 104406-AG (norm 104406AG)
        if codigoNorm.startswith(nc) and (len(codigoNorm) == len(nc) or codigoNorm[len(nc)].isalpha()):
            match = True
        # el código aparece como token completo en la descripción
        elif nc in tokens:
            match = True
        if match:
            encontrado = True
            acc["stock"] += stock or 0
            if desc and not acc["desc"]:
                acc["desc"] = desc
            if precio and not acc["precio"]:
                acc["precio"] = precio
            if bod:
                acc["bodegas"].add(bod)
    return acc if encontrado else None


def codigos_de_pautas():
    """Set de códigos normalizados usados en las pautas + su forma original."""
    usados = {}
    for f in glob.glob(os.path.join(DATA, "pautas", "*.json")):
        d = json.load(open(f, encoding="utf-8"))
        for pl in d["planes"]:
            for itv in pl["intervalos"]:
                for it in (itv.get("items") or []):
                    cod = it.get("codigo")
                    if cod:
                        nc = norm(cod)
                        # placeholders que no son códigos reales
                        if nc and not any(x in str(cod).upper() for x in
                                          ("COMPRA EN PLAZA", "PENDIENTE", "INGRESAR", "MAT-", "N/A")):
                            usados[nc] = str(cod).strip()
    return usados


def main(descargar=False):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if descargar:
        print("Descargando tablas de stock desde SharePoint...")
        descargar_de_sharepoint()

    cur, cur_crudo = leer_stock(os.path.join(FUENTE, ARCHIVO_CURIFOR), con_rubro=True)
    fro, fro_crudo = leer_stock(os.path.join(FUENTE, ARCHIVO_FRONTERA), con_rubro=False)
    print(f"Stock Curifor:  {len(cur)} códigos")
    print(f"Stock Frontera: {len(fro)} códigos")

    usados = codigos_de_pautas()
    print(f"Códigos de repuestos en pautas (reales): {len(usados)}")

    items = {}
    n_cur = n_fro = n_aprox = 0
    for nc, original in usados.items():
        ec = cur.get(nc)
        ef = fro.get(nc)
        aprox = False
        # cruce secundario (lubricantes a granel, presentaciones con sufijo, código en descripción)
        if not ec:
            sec = buscar_secundario(nc, cur_crudo)
            if sec:
                ec = sec
                aprox = True
        if not ef:
            secf = buscar_secundario(nc, fro_crudo)
            if secf:
                ef = secf
                aprox = True
        if not ec and not ef:
            continue
        sc = int(ec["stock"]) if ec else None
        sf = int(ef["stock"]) if ef else None
        if ec:
            n_cur += 1
        if ef:
            n_fro += 1
        if aprox:
            n_aprox += 1
        desc = (ec or ef or {}).get("desc")
        precio = (ec or ef or {}).get("precio")
        bod = sorted((ec or {}).get("bodegas", set()) | (ef or {}).get("bodegas", set()))
        items[nc] = {
            "c": sc,          # stock giro Curifor (None si no está catalogado)
            "f": sf,          # stock giro Frontera
            "desc": desc,
            "precio": precio,
            "bodegas": bod[:4],
            "aprox": aprox,   # match difuso (por presentación/descripción)
        }

    # fecha del snapshot (mtime del archivo Curifor)
    try:
        import datetime
        ts = os.path.getmtime(os.path.join(FUENTE, ARCHIVO_CURIFOR))
        fecha = datetime.datetime.fromtimestamp(ts).strftime("%d-%m-%Y %H:%M")
    except Exception:
        fecha = "desconocida"

    salida = {
        "actualizado": fecha,
        "fuentes": {"curifor": ARCHIVO_CURIFOR, "frontera": ARCHIVO_FRONTERA},
        "items": items,
    }
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, "stock.json"), "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, separators=(",", ":"))

    con_stock = sum(1 for v in items.values() if (v["c"] or 0) > 0 or (v["f"] or 0) > 0)
    rep = [
        "# Reporte de stock", "",
        f"- Snapshot: **{fecha}**",
        f"- Códigos de repuestos en pautas (reales): **{len(usados)}**",
        f"- Con registro en stock: **{len(items)}** (Curifor {n_cur}, Frontera {n_fro})",
        f"- De ellos por cruce aproximado (lubricantes/presentaciones): **{n_aprox}**",
        f"- Con stock disponible (>0): **{con_stock}**",
        f"- Sin catalogar en stock: **{len(usados) - len(items)}**",
        "",
        "La plataforma marca cada repuesto de la cotización con su disponibilidad "
        "en bodega (Curifor / Frontera). Los repuestos sin registro se muestran sin dato de stock.",
    ]
    with open(os.path.join(AQUI, "stock_reporte.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(rep))

    print(f"OK: stock.json con {len(items)} códigos ({con_stock} con stock >0). "
          f"Sin catalogar: {len(usados) - len(items)}.")


if __name__ == "__main__":
    main(descargar="--descargar" in sys.argv)
