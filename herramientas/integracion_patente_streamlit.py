# -*- coding: utf-8 -*-
"""
Búsqueda por patente para el Cotizador embebido en la app de Curifor
(repo Cjerez-curi/curifor-ots, `app.py`, modo "cotizador").

NO es un script ejecutable: es el bloque a insertar en `app.py` cuando tengamos
permiso de escritura. Se mantiene acá, junto al cotizador, para que el código
viva con su fuente y no se pierda en un chat.

    ¿Por qué la consulta la hace el servidor y no el navegador?

    El cotizador corre dentro de un iframe (`components.html`). Si el JS llamara
    a api.boostr.cl directamente, la API key tendría que viajar al navegador:
    quedaría a la vista de cualquiera que abra el inspector, y bastaría copiarla
    para agotar la cuota del plan. Haciéndolo en Python la key se queda en
    `st.secrets`, y de paso `@st.cache_data` evita pagar dos veces la misma
    patente.

    El JS del cotizador ya está preparado para este modo: si el host define
    `window._COTIZ_PATENTE_EXTERNA` esconde su propio campo de patente, y si
    define `window._COTIZ_VEHICULO` traduce ese vehículo al catálogo y deja
    marca/modelo/(versión)/(año) preseleccionados.

CONFIGURACIÓN PREVIA (la hace quien administra el deploy, en Streamlit Cloud →
Settings → Secrets):

    BOOSTR_API_KEY = "la-key-de-boostr"

Sin ese secret el módulo no se rompe: simplemente no muestra el buscador.
La key gratuita se saca en https://boostr.cl/patente
"""

# =============================================================================
#  1) Va junto a las demás funciones de datos (cerca de _cargar_cotizador_gz)
# =============================================================================

CONSULTA = '''
BOOSTR_API_KEY = st.secrets.get("BOOSTR_API_KEY", "")

# Formatos chilenos: BBCC12 (desde 2007), AB1234 (antiguo) y los de moto.
_PATENTE_RE = re.compile(r"^([A-Z]{4}\\d{2}|[A-Z]{2}\\d{4}|[A-Z]{3}\\d{2}|[A-Z]{2}\\d{3})$")


def _normalizar_patente(texto: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (texto or "").upper())


@st.cache_data(ttl=60 * 60 * 24 * 30, show_spinner=False)
def _consultar_patente(placa: str):
    """
    Consulta el registro del vehículo en boostr.cl.
    Devuelve (datos, error) — uno de los dos siempre es None.

    Se cachea 30 días porque marca/modelo/año de un vehículo no cambian, y el
    plan gratuito tiene cuota: una patente ya consultada no vuelve a gastarla.
    """
    if not BOOSTR_API_KEY:
        return None, "La consulta por patente no está configurada (falta BOOSTR_API_KEY en los secrets)."
    try:
        r = requests.get(
            f"https://api.boostr.cl/vehicle/{placa}.json",
            headers={"X-API-KEY": BOOSTR_API_KEY, "Accept": "application/json"},
            timeout=12,
        )
        j = r.json()
    except Exception:
        return None, "No pudimos consultar el registro en este momento."

    if j.get("status") == "success" and j.get("data"):
        return j["data"], None

    codigo = (j.get("code") or "").upper()
    if codigo in ("MISSING_API_KEY", "INVALID_API_KEY"):
        return None, "La API key del registro no es válida o está vencida."
    if codigo in ("NOT_FOUND", "PLATE_NOT_FOUND"):
        return None, f"No encontramos el vehículo con patente {placa}."
    return None, j.get("message") or "El registro no devolvió datos para esa patente."
'''


# =============================================================================
#  2) Va DENTRO del bloque `if st.session_state.get("app_mode") == "cotizador":`
#     en el `with st.sidebar:`, después del botón "Volver al inicio".
# =============================================================================

SIDEBAR = '''
        st.divider()
        st.markdown("### 🔎 Buscar por patente")
        with st.form("cot_patente", clear_on_submit=False):
            _pat_txt = st.text_input(
                "Patente", value="", max_chars=8, placeholder="BBCC12",
                label_visibility="collapsed",
            )
            _pat_ok = st.form_submit_button("Buscar vehículo", use_container_width=True)

        if _pat_ok:
            _placa = _normalizar_patente(_pat_txt)
            if not _placa:
                st.session_state.pop("cot_vehiculo", None)
            elif not _PATENTE_RE.match(_placa):
                st.session_state["cot_vehiculo"] = {"_error": "Formato inválido. Usa BBCC12 o AB1234."}
            else:
                _datos, _err = _consultar_patente(_placa)
                st.session_state["cot_vehiculo"] = {"_error": _err} if _err else _datos

        _veh = st.session_state.get("cot_vehiculo")
        if _veh and _veh.get("_error"):
            st.warning(_veh["_error"])
        elif _veh:
            st.success(" ".join(str(_veh.get(k, "")) for k in ("make", "model", "year")).strip())
            if st.button("Limpiar patente", use_container_width=True, key="cot_pat_limpiar"):
                st.session_state.pop("cot_vehiculo", None)
                st.rerun()
'''


# =============================================================================
#  3) Va justo ANTES de `components.html(_cot_html, ...)`, reemplazando la línea
#     `_cot_html = _COT_HTML_TPL.replace("__GZ_B64__", _cot_gz)`
# =============================================================================
#
#  Se inyecta un <script> ANTES del bundle: define las dos banderas que el JS
#  del cotizador lee al iniciar. json.dumps escapa el contenido, así que no hay
#  riesgo de romper el HTML con comillas del registro.

INYECCION = '''
        _cot_html = _COT_HTML_TPL.replace("__GZ_B64__", _cot_gz)

        _veh = st.session_state.get("cot_vehiculo")
        _veh = None if (not _veh or _veh.get("_error")) else _veh
        _flags = "window._COTIZ_PATENTE_EXTERNA = true;"
        if _veh:
            _flags += "window._COTIZ_VEHICULO = " + json.dumps(
                {"make": _veh.get("make"), "model": _veh.get("model"), "year": _veh.get("year")}
            ) + ";"
        _cot_html = _cot_html.replace("<script id=\\"cotizData\\"",
                                      "<script>" + _flags + "</script>\\n<script id=\\"cotizData\\"", 1)

        components.html(_cot_html, height=1500, scrolling=True)
'''

# `re`, `json`, `requests` y `st` ya están importados en app.py — no hay imports
# nuevos que agregar.

if __name__ == "__main__":
    print(__doc__)
    print("Bloques a insertar en app.py:")
    for nombre, bloque in (("1. Consulta (junto a _cargar_cotizador_gz)", CONSULTA),
                           ("2. Sidebar (dentro del modo cotizador)", SIDEBAR),
                           ("3. Inyección (antes de components.html)", INYECCION)):
        print(f"\n{'=' * 70}\n{nombre}\n{'=' * 70}{bloque}")
