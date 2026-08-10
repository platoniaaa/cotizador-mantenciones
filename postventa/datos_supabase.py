# -*- coding: utf-8 -*-
"""
Capa de datos de la app de post venta: Supabase en lugar de GitHub.

QUÉ REEMPLAZA
-------------
Hasta ahora `app.py` usaba el repositorio de GitHub como base de datos: cada
lectura era una llamada a la API de GitHub y cada guardado, un commit. Este
módulo entrega las mismas dos operaciones —leer un documento por nombre y
guardarlo— pero contra la tabla `public.documentos` de Supabase.

**La app no cambia de forma.** Los documentos siguen siendo los mismos JSON
con la misma estructura (`datos_dashboard.json`, `control_taller.json`, …), así
que ninguna pantalla, ningún filtro y ningún cálculo se toca. Lo único que
cambia es dónde se guardan.

POR QUÉ IMPORTA
---------------
1. **Se acaban los cambios que se pisan.** GitHub obligaba a leer el archivo
   entero, modificarlo y volver a subirlo; dos personas guardando a la vez
   dejaban ganar a la última, sin aviso. Aquí el guardado es una sola sentencia
   atómica, y `guardar_si_igual()` permite además rechazar el guardado si otro
   alcanzó a escribir primero (el equivalente al `sha` de GitHub).
2. **Se acaba el token de GitHub en el navegador.** El tablero embebido traía
   un token con permiso de escritura dentro del HTML que recibía cada uno de
   los 63 usuarios. Ese camino desaparece.
3. **Es más rápido.** Una consulta a Postgres en vez de dos o tres llamadas
   HTTP encadenadas a la API de GitHub, cada una con su tiempo de espera.

CREDENCIALES
------------
En Streamlit Cloud, en *Settings → Secrets*:

    SUPABASE_DB_PASSWORD = "..."

También sirve la variable de entorno `SUPABASE_DB_PASSWORD` (para correrlo en
un PC) o un archivo `supabase_pwd.txt` junto a este archivo, que el .gitignore
ya excluye. El host/usuario/puerto tienen valores por defecto; se pueden
sobrescribir con SUPABASE_DB_HOST / _USER / _PORT / _NAME.

Sin credencial, `disponible()` devuelve False y la app puede seguir usando
GitHub: así se puede desplegar el código sin cortar nada y encender la
migración cuando se quiera.
"""
import json
import os
import ssl
import threading

# Defaults del session pooler de Curifor (IPv4: la red corporativa no tiene IPv6).
_DEF_HOST = "aws-0-us-east-1.pooler.supabase.com"
_DEF_USER = "postgres.ordgsglujssgzmnlmcus"
_DEF_PORT = 5432
_DEF_NAME = "postgres"

_DIR = os.path.dirname(os.path.abspath(__file__))
_PWD_FILE = os.path.join(_DIR, "supabase_pwd.txt")

_cfg = None
_local = threading.local()      # una conexión por hilo: Streamlit atiende en varios
_lock = threading.Lock()


# --------------------------------------------------------------- configuración
def _password():
    """Busca la clave en Streamlit Secrets, en el entorno o en el archivo local."""
    try:
        import streamlit as st
        pwd = str(st.secrets.get("SUPABASE_DB_PASSWORD", "")).strip()
        if pwd:
            return pwd
    except Exception:
        pass                     # fuera de Streamlit, o sin secrets configurados
    pwd = os.environ.get("SUPABASE_DB_PASSWORD", "").strip()
    if pwd:
        return pwd
    try:
        with open(_PWD_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def _cargar_cfg():
    global _cfg
    if _cfg is not None:
        return _cfg
    with _lock:
        if _cfg is not None:
            return _cfg
        pwd = _password()
        if not pwd:
            _cfg = {}
        else:
            _cfg = {
                "host": os.environ.get("SUPABASE_DB_HOST", _DEF_HOST),
                "user": os.environ.get("SUPABASE_DB_USER", _DEF_USER),
                "port": int(os.environ.get("SUPABASE_DB_PORT", _DEF_PORT)),
                "database": os.environ.get("SUPABASE_DB_NAME", _DEF_NAME),
                "password": pwd,
            }
        return _cfg


def disponible():
    """True si hay credencial: la app puede usar Supabase."""
    return bool(_cargar_cfg())


# --------------------------------------------------------------- conexión
def _conn():
    """Conexión por hilo, reutilizada. Reconecta sola si se cayó.

    Sin autocommit a propósito: así un guardado que falla a medias no deja el
    documento a medio escribir. Cada operación confirma o revierte explícitamente.
    """
    cfg = _cargar_cfg()
    if not cfg:
        return None
    c = getattr(_local, "conn", None)
    if c is not None:
        try:
            cur = c.cursor()
            cur.execute("select 1")
            cur.fetchone()
            c.rollback()
            return c
        except Exception:
            try:
                c.close()
            except Exception:
                pass
            _local.conn = None
    import pg8000.dbapi
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    c = pg8000.dbapi.connect(
        user=cfg["user"], password=cfg["password"], host=cfg["host"],
        port=cfg["port"], database=cfg["database"], ssl_context=ctx, timeout=30,
    )
    c.autocommit = False
    _local.conn = c
    return c


# --------------------------------------------------------------- operaciones
def leer(nombre):
    """El documento como dict/list, o None si no existe o falla la conexión.

    None significa "no pude", NUNCA "está vacío": quien llama debe distinguirlo
    para no confundir una caída de red con un documento sin datos y sobrescribir
    algo bueno con algo vacío.
    """
    sello, datos = leer_con_sello(nombre)
    return datos


def leer_con_sello(nombre):
    """(sello, documento). El `sello` identifica esta versión del documento y
    sirve para guardar sin pisar a otro — es el equivalente al `sha` de GitHub.
    Devuelve (None, None) si no se pudo leer."""
    c = _conn()
    if c is None:
        return None, None
    try:
        cur = c.cursor()
        cur.execute(
            "select actualizado, data from public.documentos where nombre = %s",
            (nombre,))
        fila = cur.fetchone()
        c.rollback()
        if not fila:
            return None, None
        sello = fila[0].isoformat() if fila[0] is not None else None
        datos = fila[1]
        if isinstance(datos, str):        # según el driver, jsonb puede venir en texto
            datos = json.loads(datos)
        return sello, datos
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
        return None, None


def guardar(nombre, datos, mensaje=""):
    """Guarda (crea o reemplaza) el documento. True si quedó escrito."""
    c = _conn()
    if c is None:
        return False
    try:
        cur = c.cursor()
        cur.execute(
            """insert into public.documentos (nombre, data, mensaje)
               values (%s, %s::jsonb, %s)
               on conflict (nombre) do update
                 set data = excluded.data,
                     actualizado = now(),
                     mensaje = excluded.mensaje""",
            (nombre, json.dumps(datos, ensure_ascii=False), mensaje or None))
        c.commit()
        return True
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
        return False


def guardar_si_igual(nombre, datos, sello, mensaje=""):
    """Guarda SOLO si el documento sigue igual que cuando se leyó.

    Devuelve (True, sello_nuevo) si escribió, o (False, None) si alguien más
    guardó primero — en ese caso quien llama debe releer y reintentar, en vez
    de pisar el trabajo del otro. Esto es lo que GitHub daba con el `sha` y lo
    que el guardado directo no puede garantizar.

    Con `sello=None` se exige que el documento NO exista todavía.
    """
    c = _conn()
    if c is None:
        return False, None
    try:
        cur = c.cursor()
        blob = json.dumps(datos, ensure_ascii=False)
        if sello is None:
            cur.execute(
                """insert into public.documentos (nombre, data, mensaje)
                   values (%s, %s::jsonb, %s)
                   on conflict (nombre) do nothing
                   returning actualizado""",
                (nombre, blob, mensaje or None))
        else:
            cur.execute(
                """update public.documentos
                      set data = %s::jsonb, actualizado = now(), mensaje = %s
                    where nombre = %s and actualizado = %s::timestamptz
                returning actualizado""",
                (blob, mensaje or None, nombre, sello))
        fila = cur.fetchone()
        if not fila:
            c.rollback()
            return False, None       # otro escribió antes: no se pisa
        c.commit()
        return True, fila[0].isoformat()
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
        return False, None


def listar():
    """[(nombre, actualizado)] de todos los documentos. Para diagnóstico."""
    c = _conn()
    if c is None:
        return []
    try:
        cur = c.cursor()
        cur.execute("select nombre, actualizado from public.documentos order by nombre")
        filas = cur.fetchall()
        c.rollback()
        return [(n, a) for n, a in filas]
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
        return []


def cerrar():
    """Cierra la conexión de este hilo."""
    c = getattr(_local, "conn", None)
    if c is not None:
        try:
            c.close()
        except Exception:
            pass
        _local.conn = None
