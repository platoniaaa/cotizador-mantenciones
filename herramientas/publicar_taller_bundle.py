# -*- coding: utf-8 -*-
"""
publicar_taller_bundle.py — empaqueta los módulos Agenda/Recepción (taller.html)
y los deja como bundle `taller_data.json` en el repo de Cristian (curifor-ots),
para que la app los sirva EMBEBIDOS (components.html) igual que el cotizador, SIN
iframe a platoniaaa.

Mismo mecanismo que publicar_bundle.py: HTML+CSS+JS+datos viajan comprimidos
gzip+base64 en el campo 'gz'; el navegador los descomprime con DecompressionStream
(la CSP de Streamlit Cloud bloquea CDNs). Los datos (índice/stock/pautas) se
incluyen para que la recepción calcule pautas sin fetch.

    python herramientas/publicar_taller_bundle.py             # construye y compara
    python herramientas/publicar_taller_bundle.py --escribir  # escribe taller_data.json

El único archivo que toca del repo es `taller_data.json`. El cargador en app.py
(que reemplaza el components.iframe de platoniaaa por components.html) es
territorio de Cristian y se integra/valida con él.
"""
from __future__ import annotations
import argparse, base64, gzip, io, json, os, re, sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent           # .../plataforma
REPO_POR_DEFECTO = os.environ.get("CURIFOR_OTS_REPO", r"C:\dev\curifor-ots")
ARCHIVO_BUNDLE = "taller_data.json"

# --- Adaptación del JS del taller: de "web estática" (fetch data/*.json) a
#     "componente embebido" (los datos ya vienen en window._COTIZ). Cada parche
#     DEBE calzar exactamente una vez; si no, el script aborta.
PARCHES_JS = [
    (
        "carga de pauta por id",
        '''  return fetch("data/pautas/" + id + ".json")
    .then(function (r) { if (!r.ok) throw new Error("pauta"); return r.json(); })
    .then(function (j) { PAUTAS[id] = j; return j; })
    .catch(function () { return null; });''',
        '''  var _p = (window._COTIZ && window._COTIZ.pautas && window._COTIZ.pautas[id]) || null;
  if (_p) PAUTAS[id] = _p;
  return Promise.resolve(_p);''',
    ),
    (
        "carga del índice",
        'var pIdx = fetch("data/indice.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });',
        'var pIdx = Promise.resolve((window._COTIZ && window._COTIZ.indice) || null);',
    ),
    (
        "carga del stock",
        'var pStk = fetch("data/stock.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });',
        'var pStk = Promise.resolve((window._COTIZ && window._COTIZ.stock) || null);',
    ),
    (
        "arranque (el host llama a __tallerInit; DOMContentLoaded ya pasó)",
        'document.addEventListener("DOMContentLoaded", init);',
        'window.__tallerInit = init;',
    ),
]


# --- Cromo que sobra en modo embebido: la app de OTs ya pinta su propio header
#     Curifor encima del componente y la navegación entre módulos la hace su
#     menú, así que la topbar, el sub-header y las pestañas del taller quedan
#     duplicados (además, el logo de la topbar es una ruta relativa que dentro
#     del componente no resuelve, y su link "← Cotizador" apunta a index.html,
#     que ahí tampoco existe). Se ocultan por CSS y no borrando los nodos: el JS
#     del taller escribe en #footFecha y no queremos null-references.
#     Va solo en el bundle; el sitio estático (taller.html) no se toca.
CSS_EMBEBIDO = """
/* --- modo embebido (bundle en la app de OTs) --- */
.topbar, .foot, .taller-head, .tabs { display: none !important; }
"""


def _aplicar(parches, texto, que):
    for nombre, patron, reemplazo in parches:
        n = texto.count(patron)
        if n != 1:
            sys.exit(f"ERROR: el parche de {que} '{nombre}' calzó {n} veces (esperaba 1).\n"
                     f"       {Path(__file__).name}: el fuente cambió; ajusta el parche antes de publicar.")
        texto = texto.replace(patron, reemplazo)
    return texto


def _leer(ruta):
    if not ruta.exists():
        sys.exit(f"ERROR: falta {ruta}")
    return ruta.read_text(encoding="utf-8")


def _data_uri_png(ruta):
    return "data:image/png;base64," + base64.b64encode(ruta.read_bytes()).decode("ascii")


def construir():
    logo = _data_uri_png(BASE / "img" / "curifor-logo.png")

    # body de taller.html (soporta <body class="...">), sin los <script>
    html = _leer(BASE / "taller.html")
    m = re.search(r"<body[^>]*>(.*)</body>", html, re.S)
    if not m:
        sys.exit("ERROR: taller.html no tiene <body>...</body>")
    body = m.group(1)
    body = re.sub(r"\s*<script[^>]*>.*?</script>", "", body, flags=re.S)

    # CSS: estilos base + taller + los ajustes propios del modo embebido
    css = (_leer(BASE / "css" / "estilos.css") + "\n"
           + _leer(BASE / "css" / "taller.css") + "\n" + CSS_EMBEBIDO)

    # JS en orden: config Supabase -> guard(login) -> taller(parcheado) -> autocompletar
    js_config = _leer(BASE / "js" / "agenda-config.js")
    js_auth = _leer(BASE / "js" / "auth.js")
    js_taller = _aplicar(PARCHES_JS, _leer(BASE / "js" / "taller.js"), "js")
    js_auto = _leer(BASE / "js" / "autocompletar.js")
    js = "\n;\n".join([js_config, js_auth, js_taller, js_auto])

    # datos (para la recepción: pautas/stock/índice) — mismos del cotizador
    indice = json.loads(_leer(BASE / "data" / "indice.json"))
    stock_path = BASE / "data" / "stock.json"
    stock = json.loads(_leer(stock_path)) if stock_path.exists() else None
    dir_pautas = BASE / "data" / "pautas"
    pautas = {p.stem: json.loads(p.read_text(encoding="utf-8"))
              for p in sorted(dir_pautas.glob("*.json"))}
    if not pautas:
        sys.exit(f"ERROR: no hay pautas en {dir_pautas}")

    return {"indice": indice, "stock": stock, "pautas": pautas,
            "css": css, "js": js, "body": body, "logo": logo}


def empaquetar(pkg):
    crudo = json.dumps(pkg, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=9, mtime=0) as gz:
        gz.write(crudo)
    return {"actualizado": pkg["indice"].get("actualizado", ""),
            "gz": base64.b64encode(buf.getvalue()).decode("ascii")}


def verificar(bundle):
    pkg = json.loads(gzip.decompress(base64.b64decode(bundle["gz"])))
    for clave in ("indice", "pautas", "css", "js", "body", "logo"):
        if not pkg.get(clave):
            sys.exit(f"ERROR: el bundle quedó sin '{clave}'")
    if "window.__tallerInit" not in pkg["js"]:
        sys.exit("ERROR: el JS del taller no quedó adaptado al modo embebido (__tallerInit).")
    if "fetch(\"data/" in pkg["js"]:
        sys.exit("ERROR: quedó un fetch a data/ sin parchear en el JS del taller.")
    if "modo embebido" not in pkg["css"]:
        sys.exit("ERROR: al CSS le falta el bloque del modo embebido (cromo duplicado).")
    return pkg


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--escribir", action="store_true", help="escribe taller_data.json en el repo")
    ap.add_argument("--repo", default=REPO_POR_DEFECTO)
    args = ap.parse_args()

    print("Construyendo el bundle del taller desde", BASE)
    pkg = construir()
    bundle = empaquetar(pkg)
    verificar(bundle)
    peso = len(json.dumps(bundle)) / 1024 / 1024
    print(f"  {len(pkg['pautas'])} pautas · css {len(pkg['css'])}B · js {len(pkg['js'])}B · body {len(pkg['body'])}B")
    print(f"  taller_data.json: {peso:.2f} MB")

    repo = Path(args.repo)
    if not (repo / ".git").exists():
        sys.exit(f"ERROR: {repo} no es un clon de git.")
    destino = repo / ARCHIVO_BUNDLE
    if destino.exists():
        actual = json.loads(destino.read_text(encoding="utf-8"))
        if actual.get("gz") == bundle["gz"]:
            print("\nSin cambios respecto a lo que hay en el repo.")
            return
    if not args.escribir:
        print("\n(simulación) Usa --escribir para dejarlo en el repo.")
        return
    destino.write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
    print(f"Escrito: {destino}\n(Queda en la rama local; se revisa/pushea con Cristian en la junta.)")


if __name__ == "__main__":
    main()
