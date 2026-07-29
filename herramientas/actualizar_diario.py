# -*- coding: utf-8 -*-
"""
Actualización diaria del Cotizador de Mantenciones (tarea programada).

Hace, en orden:
  1. actualizar_stock.py  -> data/stock.json con el stock del día y los precios
                             de la lista oficial, + herramientas/sku_sin_precio.xlsx
  2. commit + push a GitHub Pages (platoniaaa/cotizador-mantenciones)
  3. publicar_bundle.py --publicar -> curifor-ots (la app Streamlit, producción real)

Si no cambió nada, no commitea ni publica. El push a curifor-ots reintenta
porque esa app commitea sus datos cada pocos minutos y la referencia se mueve.

  python herramientas/actualizar_diario.py            # completo
  python herramientas/actualizar_diario.py --solo-datos   # sin publicar

El log queda en herramientas/logs/diario-AAAA-MM-DD.log y la tarea programada
se llama "Curifor - Cotizador actualizacion diaria".
"""
from __future__ import annotations

import datetime
import io
import os
import subprocess
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
PLAT = os.path.normpath(os.path.join(AQUI, ".."))
LOGS = os.path.join(AQUI, "logs")
PY = sys.executable
OTS = os.environ.get("CURIFOR_OTS_REPO", r"C:\dev\curifor-ots")   # clon de la app Streamlit


class Tee(io.TextIOBase):
    """Escribe a consola y al log a la vez."""

    def __init__(self, *destinos):
        self.destinos = destinos

    def write(self, s):
        for d in self.destinos:
            try:
                d.write(s)
                d.flush()
            except Exception:
                pass
        return len(s)


def correr(cmd, cwd=PLAT, titulo=None):
    """Ejecuta y devuelve (ok, salida). Nunca lanza excepción."""
    if titulo:
        print(f"\n--- {titulo} ---")
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=3600)
    except Exception as e:
        print(f"ERROR ejecutando {cmd[:2]}: {e}")
        return False, str(e)
    salida = (r.stdout or "") + (r.stderr or "")
    print(salida.rstrip())
    return r.returncode == 0, salida


def git(*args, cwd=PLAT):
    return correr(["git", *args], cwd=cwd)


def hay_cambios(rutas):
    ok, out = git("status", "--porcelain", "--", *rutas)
    return ok and bool(out.strip())


def main():
    os.makedirs(LOGS, exist_ok=True)
    hoy = datetime.date.today().isoformat()
    log = open(os.path.join(LOGS, f"diario-{hoy}.log"), "a", encoding="utf-8")
    sys.stdout = sys.stderr = Tee(sys.__stdout__, log)

    inicio = datetime.datetime.now()
    print("=" * 70)
    print(f"Actualización diaria del Cotizador · {inicio:%d-%m-%Y %H:%M:%S}")
    print("=" * 70)

    solo_datos = "--solo-datos" in sys.argv
    problemas = []

    # ---- 1. datos ----
    ok, _ = correr([PY, os.path.join("herramientas", "actualizar_stock.py")],
                   titulo="1/3 · Stock del día + precios de la lista")
    if not ok:
        print("\nFALLÓ la actualización de datos. Se aborta para no publicar algo a medias.")
        log.close()
        return 1

    SEGUIR = ["data/stock.json", "herramientas/stock_reporte.md",
              "herramientas/sku_sin_precio.xlsx"]

    if solo_datos:
        print("\n--solo-datos: no se publica.")
        log.close()
        return 0

    # ---- 2. GitHub Pages ----
    if hay_cambios(SEGUIR):
        print("\n--- 2/3 · Publicando en GitHub Pages ---")
        git("add", *SEGUIR)
        ok, _ = git("commit", "-m", f"Datos del dia {inicio:%d-%m-%Y} (stock + precios)")
        if ok:
            ok, _ = git("push")
            if not ok:
                # el remoto se movió: traer y reintentar una vez
                git("pull", "--rebase")
                ok, _ = git("push")
            if not ok:
                problemas.append("no se pudo pushear a GitHub Pages")
    else:
        print("\n--- 2/3 · GitHub Pages: sin cambios, nada que subir ---")

    # ---- 3. curifor-ots (producción real) ----
    print("\n--- 3/3 · Publicando en curifor-ots (app Streamlit) ---")
    ok, out = correr([PY, os.path.join("herramientas", "publicar_bundle.py"), "--publicar",
                      "-m", f"Cotizador: datos del {inicio:%d-%m-%Y}"])
    # Si el push fue rechazado, el bundle YA quedó commiteado en el clon: no sirve
    # volver a correr el publicador (diría "sin cambios"), hay que sincronizar el
    # clon. Esa app commitea sus datos cada pocos minutos, así que se reintenta.
    if not ok and "Sin cambios" not in out:
        for intento in (1, 2, 3):
            print(f"  push rechazado; rebase y reintento {intento}/3")
            correr(["git", "pull", "--rebase"], cwd=OTS)
            if correr(["git", "push"], cwd=OTS)[0]:
                break
    # verificación: ¿quedó algún commit sin subir?
    _, pend = correr(["git", "rev-list", "--count", "@{u}..HEAD"], cwd=OTS,
                     titulo="commits pendientes en curifor-ots")
    if pend.strip().splitlines() and pend.strip().splitlines()[-1].strip() not in ("0", ""):
        problemas.append(f"quedaron commits sin subir en curifor-ots ({pend.strip()})")

    dur = (datetime.datetime.now() - inicio).total_seconds()
    print("\n" + "=" * 70)
    if problemas:
        print(f"TERMINÓ CON AVISOS en {dur:.0f}s: " + "; ".join(problemas))
    else:
        print(f"OK · todo publicado en {dur:.0f}s")
    print("=" * 70)
    log.close()
    return 1 if problemas else 0


if __name__ == "__main__":
    sys.exit(main())
