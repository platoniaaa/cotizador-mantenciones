# -*- coding: utf-8 -*-
"""Pone el mismo `?v=<commit>` en TODAS las paginas del sitio.

GitHub Pages manda Cache-Control: max-age=600, asi que el navegador se queda
con el CSS y el JS viejos hasta diez minutos despues de publicar. El `?v=`
fuerza la recarga.

Existe porque el bump se hacia a mano, pagina por pagina, y era cuestion de
tiempo que se olvidara una: el 06-ago-2026 quedaron cuatro numeros distintos
entre index, login, cotizador y taller. Una pagina con el numero viejo sirve
recursos viejos sin que nadie se entere.

Uso (despues de commitear los cambios, antes del commit del bump):
    python herramientas/bump_cache.py
    git add -A && git commit -m "Bump cache"
"""
import re
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
PATRON = re.compile(r"\?v=[0-9a-f]{7}\b")


def main():
    try:
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=RAIZ,
                                capture_output=True, text=True, check=True).stdout.strip()
    except Exception as e:
        sys.exit(f"No se pudo leer el commit actual: {e}")

    if not re.fullmatch(r"[0-9a-f]{7}", commit):
        sys.exit(f"El hash no tiene el formato esperado: {commit!r}")

    tocados = 0
    for html in sorted(RAIZ.glob("*.html")):
        if html.name.startswith("_"):        # archivos de prueba
            continue
        txt = html.read_text(encoding="utf-8")
        nuevo, n = PATRON.subn(f"?v={commit}", txt)
        if n and nuevo != txt:
            html.write_text(nuevo, encoding="utf-8", newline="")
            print(f"  {html.name:18} {n} referencias -> {commit}")
            tocados += 1
        elif n:
            print(f"  {html.name:18} ya estaba en {commit}")
        else:
            print(f"  {html.name:18} sin referencias con version")

    print(f"\npaginas modificadas: {tocados}")


if __name__ == "__main__":
    main()
