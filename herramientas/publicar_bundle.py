# -*- coding: utf-8 -*-
"""
publicar_bundle.py — empaqueta el Cotizador de Mantenciones y lo publica en la
app Streamlit de Curifor (repo Cjerez-curi/curifor-ots).

La app de Cristian no ejecuta la carpeta `plataforma/`: la embebe como un
componente HTML dentro de un iframe (app.py, modo "cotizador"). Todo el
cotizador —HTML, CSS, JS, la librería XLSX, el logo, el índice, el stock y las
273 pautas— viaja comprimido gzip+base64 en el campo 'gz' de
`cotizador_data.json`, y el navegador lo descomprime con DecompressionStream
(la CSP de Streamlit Cloud bloquea la salida a CDN).

Este script regenera ese bundle desde la carpeta `plataforma/` y lo deja en el
clon del repo, listo para commitear.

    python herramientas/publicar_bundle.py              # regenera y compara
    python herramientas/publicar_bundle.py --escribir   # escribe cotizador_data.json
    python herramientas/publicar_bundle.py --publicar   # escribe + commit + push

Requiere que el repo esté clonado (por defecto en C:\\dev\\curifor-ots; se puede
cambiar con --repo o con la variable de entorno CURIFOR_OTS_REPO).

El único archivo que se toca del repo es `cotizador_data.json`. `app.py` es
territorio de Cristian: no se modifica nunca desde acá.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import io
import json
import os
import re
import subprocess
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent          # .../plataforma
REPO_POR_DEFECTO = os.environ.get("CURIFOR_OTS_REPO", r"C:\dev\curifor-ots")
ARCHIVO_BUNDLE = "cotizador_data.json"


# ============================================================
#   Adaptación del JS: de "web estática" a "componente embebido"
# ============================================================
#   En la plataforma el JS pide los datos con fetch() a data/*.json. Dentro del
#   iframe no hay servidor que responda: los datos ya vienen en window._COTIZ.
#   Estos 4 parches hacen la traducción. Cada uno DEBE encontrar su patrón; si
#   alguno no calza (porque app.js cambió), el script aborta en vez de publicar
#   un cotizador roto.

PARCHES_JS = [
    (
        "carga del índice y el stock",
        """    try {
      const r = await fetch("data/indice.json");
      if (!r.ok) throw new Error("indice");
      state.indice = await r.json();
    } catch (e) {
      el.errorBox.hidden = false;
      return;
    }
""",
        """    const D = (window._COTIZ || {});
    state.indice = D.indice || null;
    if (!state.indice) { el.errorBox.hidden = false; return; }
    state.stock = D.stock || null;
""",
    ),
    (
        "fetch del stock (ya viene en _COTIZ)",
        """    // stock es opcional: si falta, la plataforma funciona igual (sin disponibilidad)
    try {
      const rs = await fetch("data/stock.json");
      if (rs.ok) state.stock = await rs.json();
    } catch (e) { state.stock = null; }
""",
        "",
    ),
    (
        "carga de la pauta por id",
        """    try {
      const r = await fetch(`data/pautas/${id}.json`);
      if (!r.ok) throw new Error("pauta");
      state.pauta = await r.json();
    } catch (e) {
      state.pauta = null;
      el.errorBox.hidden = false;
    }
""",
        """    const P = (window._COTIZ && window._COTIZ.pautas) || {};
    state.pauta = P[id] || null;
    if (!state.pauta) el.errorBox.hidden = false;
""",
    ),
    (
        "botón Agendar (no existe dentro del iframe)",
        'el.btnAgendar.addEventListener("click", agendarEnTaller);',
        'if (el.btnAgendar) el.btnAgendar.addEventListener("click", agendarEnTaller);',
    ),
    (
        "arranque (el host llama a __cotizInit; DOMContentLoaded ya pasó)",
        'document.addEventListener("DOMContentLoaded", init);',
        "window.__cotizInit = init;",
    ),
]

# Elementos del HTML que no tienen sentido dentro de la app de Cristian: el
# taller ya lo proveen sus propios módulos.
PARCHES_HTML = [
    (
        "link a taller.html",
        re.compile(r'<a href="taller\.html" class="nav-link">Taller y agenda</a>'),
        "",
    ),
    (
        "link a cliente.html",
        re.compile(r'<a href="cliente\.html"[^>]*>Vista cliente</a>'),
        "",
    ),
    (
        "botón Agendar",
        re.compile(r'<button id="btnAgendar".*?</button>', re.S),
        "",
    ),
]


def _aplicar(parches, texto: str, que: str) -> str:
    """Aplica los parches exigiendo que cada uno calce exactamente una vez."""
    for nombre, patron, reemplazo in parches:
        if isinstance(patron, str):
            n = texto.count(patron)
            texto = texto.replace(patron, reemplazo)
        else:
            texto, n = patron.subn(reemplazo, texto)
        if n != 1:
            sys.exit(
                f"ERROR: el parche de {que} '{nombre}' calzó {n} veces (esperaba 1).\n"
                f"       El archivo fuente cambió y el bundle quedaría roto.\n"
                f"       Ajusta PARCHES_{que.upper()} en {Path(__file__).name} "
                f"antes de publicar."
            )
    return texto


def _leer(ruta: Path) -> str:
    if not ruta.exists():
        sys.exit(f"ERROR: falta {ruta}")
    return ruta.read_text(encoding="utf-8")


def _data_uri_png(ruta: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(ruta.read_bytes()).decode("ascii")


# ============================================================
#   Construcción del bundle
# ============================================================
def construir() -> dict:
    logo = _data_uri_png(BASE / "img" / "curifor-logo.png")

    # --- HTML: solo el <body>, sin los <script> (el host inyecta el JS) ---
    html = _leer(BASE / "index.html")
    try:
        body = html.split("<body>", 1)[1].split("</body>", 1)[0]
    except IndexError:
        sys.exit("ERROR: index.html no tiene <body>...</body>")
    body = re.sub(r"\s*<script[^>]*>.*?</script>", "", body, flags=re.S)
    body = _aplicar(PARCHES_HTML, body, "html")
    body = body.replace('src="img/curifor-logo.png"', f'src="{logo}"')

    if "img/" in body or 'src="data' not in body:
        sys.exit("ERROR: quedaron rutas de imagen sin incrustar en el HTML.")

    # --- JS del cotizador, adaptado al modo embebido ---
    js = _aplicar(PARCHES_JS, _leer(BASE / "js" / "app.js"), "js")

    # --- datos ---
    indice = json.loads(_leer(BASE / "data" / "indice.json"))

    stock_path = BASE / "data" / "stock.json"
    stock = json.loads(_leer(stock_path)) if stock_path.exists() else None

    dir_pautas = BASE / "data" / "pautas"
    pautas = {p.stem: json.loads(p.read_text(encoding="utf-8"))
              for p in sorted(dir_pautas.glob("*.json"))}
    if not pautas:
        sys.exit(f"ERROR: no hay pautas en {dir_pautas}")

    # Toda versión del índice debe tener su pauta: si falta una, el usuario la
    # elige en pantalla y el cotizador muestra el error genérico de carga.
    ids_indice = {
        v["id"]
        for m in indice.get("marcas", [])
        for mo in m.get("modelos", [])
        for v in mo.get("versiones", [])
    }
    faltantes = sorted(ids_indice - set(pautas))
    if faltantes:
        sys.exit(
            f"ERROR: {len(faltantes)} versiones del índice no tienen pauta: "
            f"{', '.join(faltantes[:5])}{' ...' if len(faltantes) > 5 else ''}"
        )

    return {
        "indice": indice,
        "stock": stock,
        "pautas": pautas,
        "css": _leer(BASE / "css" / "estilos.css"),
        "js": js,
        "body": body,
        "xlsx": _leer(BASE / "js" / "vendor" / "xlsx.full.min.js"),
        "logo": logo,
    }


def empaquetar(pkg: dict) -> dict:
    crudo = json.dumps(pkg, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    # mtime=0 → el mismo contenido produce siempre el mismo gz, así un rebuild
    # sin cambios reales no genera un commit fantasma.
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(crudo)
    return {
        "actualizado": pkg["indice"].get("actualizado", ""),
        "gz": base64.b64encode(buf.getvalue()).decode("ascii"),
    }


def verificar(bundle: dict) -> dict:
    """Descomprime lo que se va a publicar y confirma que llega entero."""
    pkg = json.loads(gzip.decompress(base64.b64decode(bundle["gz"])))
    for clave in ("indice", "pautas", "css", "js", "body", "xlsx", "logo"):
        if not pkg.get(clave):
            sys.exit(f"ERROR: el bundle quedó sin '{clave}'")
    if "window._COTIZ" not in pkg["js"] or "__cotizInit" not in pkg["js"]:
        sys.exit("ERROR: el JS del bundle no quedó adaptado al modo embebido.")
    return pkg


def _git(repo: Path, *args: str) -> str:
    r = subprocess.run(["git", "-C", str(repo), *args],
                       capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        sys.exit(f"ERROR en git {' '.join(args)}:\n{(r.stderr or r.stdout).strip()}")
    return (r.stdout or "").strip()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--escribir", action="store_true",
                    help="escribe cotizador_data.json en el repo (sin commitear)")
    ap.add_argument("--publicar", action="store_true",
                    help="escribe, commitea y pushea a curifor-ots")
    ap.add_argument("--repo", default=REPO_POR_DEFECTO,
                    help=f"clon de curifor-ots (por defecto {REPO_POR_DEFECTO})")
    ap.add_argument("-m", "--mensaje", default="Cotizador: actualizar bundle",
                    help="mensaje del commit")
    args = ap.parse_args()

    print("Construyendo el bundle desde", BASE)
    pkg = construir()
    bundle = empaquetar(pkg)
    verificar(bundle)

    peso = len(json.dumps(bundle)) / 1024 / 1024
    print(f"  {len(pkg['pautas'])} pautas · "
          f"{sum(len(mo.get('versiones', [])) for m in pkg['indice']['marcas'] for mo in m['modelos'])} versiones · "
          f"{len(pkg['indice']['marcas'])} marcas")
    print(f"  stock: {len(pkg['stock']['items']) if pkg['stock'] else 0} códigos")
    print(f"  cotizador_data.json: {peso:.2f} MB")

    repo = Path(args.repo)
    if not (repo / ".git").exists():
        sys.exit(f"ERROR: {repo} no es un clon de git. Clónalo con:\n"
                 f"       gh repo clone Cjerez-curi/curifor-ots {repo}")

    destino = repo / ARCHIVO_BUNDLE
    if destino.exists():
        actual = json.loads(destino.read_text(encoding="utf-8"))
        if actual.get("gz") == bundle["gz"]:
            print("\nSin cambios respecto a lo publicado. No hay nada que subir.")
            return
        print("\nEl bundle publicado es distinto: hay cambios por subir.")

    if not (args.escribir or args.publicar):
        print("\n(simulación) Usa --escribir para dejarlo en el repo, "
              "o --publicar para subirlo.")
        return

    # Traer primero: la app en producción commitea sus JSON de datos todo el día
    # y el push se rechaza si el clon quedó atrás.
    if args.publicar:
        print("\nActualizando el clon (git pull --rebase)…")
        _git(repo, "pull", "--rebase")

    destino.write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
    print(f"Escrito: {destino}")

    if not args.publicar:
        print("Falta commitear. Usa --publicar para que lo haga el script.")
        return

    if not _git(repo, "status", "--porcelain", "--", ARCHIVO_BUNDLE):
        print("git no ve cambios en el archivo. Nada que commitear.")
        return

    _git(repo, "add", ARCHIVO_BUNDLE)
    _git(repo, "commit", "-m", args.mensaje)
    print("Subiendo…")
    _git(repo, "push")
    print("Publicado. La app lo toma en ~10 min (cache TTL 600s de "
          "_cargar_cotizador_gz) o al reiniciarla desde Streamlit Cloud.")


if __name__ == "__main__":
    main()
