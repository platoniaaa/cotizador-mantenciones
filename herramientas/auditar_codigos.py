# -*- coding: utf-8 -*-
"""
Auditoría de códigos: compara los códigos de repuesto de las pautas contra el stock.

Responde: cuántos coinciden, por qué vía, y cuáles NO coinciden (con marca y nombre
del repuesto, para que Servicio los pueda revisar).

Salida: herramientas/cobertura_codigos.md + resumen por consola.
  python herramientas/auditar_codigos.py
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

AQUI = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(AQUI, "..", "data"))

# textos que NO son códigos reales (placeholders de la pauta)
PLACEHOLDERS = ("COMPRA EN PLAZA", "PENDIENTE", "INGRESAR", "MAT-", "N/A", "NA", "MAT")

VIA_TXT = {
    "directo": "Código idéntico en stock",
    "producto": "Cruce por nombre (mapeo curado de lubricantes)",
    "difuso": "Misma pieza con SKU interno distinto (código en la descripción o presentación)",
    "equivalente": "Reemplazo / supersesión",
}


def norm(c):
    return re.sub(r"[^A-Z0-9]", "", str(c).upper()) if c is not None else ""


def es_placeholder(cod):
    c = str(cod).upper().strip()
    return any(c.startswith(p) or c == p for p in PLACEHOLDERS)


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    stock = json.load(open(os.path.join(DATA, "stock.json"), encoding="utf-8"))
    items = stock["items"]

    # (marca, codigo) -> {nombres, veces}
    usos = defaultdict(lambda: {"nombres": set(), "veces": 0})
    for f in glob.glob(os.path.join(DATA, "pautas", "*.json")):
        d = json.load(open(f, encoding="utf-8"))
        marca = d["marcaNombre"]
        for pl in d["planes"]:
            for itv in pl["intervalos"]:
                for it in (itv.get("items") or []):
                    cod = it.get("codigo")
                    if not cod:
                        continue
                    k = (marca, str(cod).strip())
                    usos[k]["nombres"].add(it["nombre"].strip())
                    usos[k]["veces"] += 1

    coinciden, no_coinciden, placeholders = [], [], []
    por_marca = defaultdict(lambda: {"ok": 0, "no": 0, "ph": 0})
    por_via = defaultdict(int)

    for (marca, cod), info in sorted(usos.items()):
        nombre = sorted(info["nombres"])[0]
        if es_placeholder(cod):
            placeholders.append((marca, cod, nombre, info["veces"]))
            por_marca[marca]["ph"] += 1
            continue
        s = items.get(norm(cod))
        if s and ((s.get("c") or 0) > 0 or (s.get("f") or 0) > 0):
            via = s.get("via") or "directo"
            alt = s.get("alt") or ""
            coinciden.append((marca, cod, nombre, via, alt, s.get("c"), info["veces"]))
            por_marca[marca]["ok"] += 1
            por_via[via] += 1
        else:
            no_coinciden.append((marca, cod, nombre, info["veces"]))
            por_marca[marca]["no"] += 1

    total_reales = len(coinciden) + len(no_coinciden)
    pct = (len(coinciden) / total_reales * 100) if total_reales else 0

    # ---------------- reporte ----------------
    R = []
    R.append("# Auditoría de códigos: pautas vs stock\n")
    R.append(f"- Códigos de repuesto **reales** en las pautas: **{total_reales}** "
             f"(pares marca+código; un mismo código en 2 marcas cuenta 2 veces)")
    R.append(f"- **Coinciden con el stock: {len(coinciden)} ({pct:.0f}%)**")
    R.append(f"- **No coinciden (s/d): {len(no_coinciden)}**")
    R.append(f"- Placeholders de la pauta (no son códigos): {len(placeholders)}\n")

    R.append("## Cómo coinciden\n")
    R.append("| Vía | Qué significa | Códigos |")
    R.append("|---|---|---|")
    for via in ("directo", "difuso", "producto", "equivalente"):
        if por_via.get(via):
            R.append(f"| {via} | {VIA_TXT[via]} | {por_via[via]} |")
    R.append("")

    R.append("## Cobertura por marca\n")
    R.append("| Marca | Coinciden | No coinciden | % | Placeholders |")
    R.append("|---|---:|---:|---:|---:|")
    for marca in sorted(por_marca):
        m = por_marca[marca]
        tot = m["ok"] + m["no"]
        p = (m["ok"] / tot * 100) if tot else 0
        R.append(f"| {marca} | {m['ok']} | {m['no']} | {p:.0f}% | {m['ph']} |")
    R.append("")

    R.append("## ❌ Códigos que NO coinciden con el stock\n")
    R.append("Estos repuestos se muestran como **s/d** (sin dato) y se valorizan con el precio de la pauta.\n")
    R.append("| Marca | Código (pauta) | Repuesto | Veces en pautas |")
    R.append("|---|---|---|---:|")
    for marca, cod, nombre, veces in sorted(no_coinciden):
        R.append(f"| {marca} | `{cod}` | {nombre[:44]} | {veces} |")
    R.append("")

    R.append("## ⚠️ Coinciden, pero el stock los cataloga con OTRO código interno\n")
    R.append("La plataforma muestra el código de la **pauta** (correcto) y debajo indica el SKU de bodega.\n")
    R.append("| Marca | Código (pauta) | Código en bodega | Repuesto | Vía | Stock |")
    R.append("|---|---|---|---|---|---:|")
    for marca, cod, nombre, via, alt, c, veces in sorted(coinciden):
        if alt and norm(alt) != norm(cod):
            R.append(f"| {marca} | `{cod}` | `{alt}` | {nombre[:34]} | {via} | {c} |")
    R.append("")

    if placeholders:
        R.append("## Placeholders en las pautas (no son códigos reales)\n")
        R.append("| Marca | Texto | Repuesto |")
        R.append("|---|---|---|")
        for marca, cod, nombre, veces in sorted(placeholders):
            R.append(f"| {marca} | `{cod}` | {nombre[:44]} |")
        R.append("")

    with open(os.path.join(AQUI, "cobertura_codigos.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(R))

    # ---------------- consola ----------------
    print(f"Códigos reales en pautas: {total_reales}")
    print(f"  COINCIDEN     : {len(coinciden)} ({pct:.0f}%)")
    print(f"  NO coinciden  : {len(no_coinciden)}")
    print(f"  Placeholders  : {len(placeholders)}")
    print("\nVía de cruce:", dict(por_via))
    print(f"\n{'Marca':10} {'ok':>4} {'no':>4} {'%':>5}  {'ph':>3}")
    for marca in sorted(por_marca):
        m = por_marca[marca]
        tot = m["ok"] + m["no"]
        p = (m["ok"] / tot * 100) if tot else 0
        print(f"{marca:10} {m['ok']:>4} {m['no']:>4} {p:>4.0f}%  {m['ph']:>3}")
    print(f"\nReporte completo: herramientas/cobertura_codigos.md")


if __name__ == "__main__":
    main()
