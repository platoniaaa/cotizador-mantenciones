# -*- coding: utf-8 -*-
"""
Conector Recepción -> Flexline ERP.

Cuando el asesor aprieta "Ingresar a Taller" en la página de recepción, la
plataforma ya deja la reserva en Supabase con su estado en `en_taller`, su
número de OT (RO) y el acta. Este conector lee esas recepciones y las inyecta a
Flexline como un documento, para que la orden de trabajo quede registrada en el
ERP.

POR QUÉ NO LO HACE EL NAVEGADOR
-------------------------------
Dos razones, y cualquiera de las dos basta:

  1. La API de Flexline usa un certificado TLS autofirmado por Curifor. El
     navegador de un cliente cualquiera mostraría "sitio no seguro" y
     bloquearía la llamada.

  2. Autenticarse contra el ERP necesita un usuario y contraseña. Si esa
     llamada saliera del navegador, la credencial viajaría en el JavaScript, a
     la vista de cualquiera.

Por eso el navegador solo escribe en Supabase (operación segura, con la llave
anónima y RLS), y este conector -que corre en un equipo de confianza dentro de
la operación de Curifor- es el único que le habla a Flexline. La credencial
vive en variables de entorno de ESE equipo, nunca en el repositorio.

QUÉ FALTA PARA ENCENDERLO (lo entrega TI)
------------------------------------------
  · Permiso sobre `Documentos` para el usuario de API `Postventa` en TEST.
    Probado el 28-08-2026: se autentica bien en /api/Security/Auth (con la P
    mayúscula), pero solo tiene permiso sobre `CtaCte`; lo demás responde
    "No autorizado para esta opción". Sin ese permiso, NewDocumento no anda.
  · FLX_TIPO_DOCTO       ->  el tipo de documento que corresponde a una orden
    de trabajo en la configuración de Curifor.
  · el mapeo del cliente ->  ver mapear_documento(); hoy usa una cuenta genérica.
  · un equipo DENTRO de la red de Curifor (o con VPN): desde afuera,
    api-dev.curifor.cl responde 403 y la IP de TEST no se alcanza.

La clave de `Postventa` es la del correo de TI con el instructivo de la API.
Va en la variable FLX_PASS del equipo que corre esto, nunca en el repositorio.

Mientras falte el permiso, --demo arma el documento y lo imprime SIN enviarlo,
para revisar el mapeo; y --probar-login solo intenta autenticarse.

USO
---
    # variables de entorno (en el equipo que corre esto, no en el repo):
    #   FLX_BASE=https://api-dev.curifor.cl      (TEST; NUNCA api.curifor.cl acá)
    #            desde la red interna también sirve la IP de TEST del instructivo
    #   FLX_USER=Postventa   FLX_PASS=...   FLX_TIPO_DOCTO=...   FLX_EMPRESA=E01
    #   SUPABASE_URL=https://ordgsglujssgzmnlmcus.supabase.co
    #   SUPABASE_KEY=<service_role>              (server-side, no la anon)

    python herramientas/conector_flexline.py --probar-login
    python herramientas/conector_flexline.py --demo          # arma sin enviar
    python herramientas/conector_flexline.py --una-vez       # procesa lo pendiente
    python herramientas/conector_flexline.py --loop 60       # cada 60 s
"""
import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone


# ------------------------------------------------------------------ config
def env(nombre, defecto=None, obligatorio=False):
    v = os.environ.get(nombre, defecto)
    if obligatorio and not v:
        sys.exit(f"Falta la variable de entorno {nombre}.")
    return v


# El ambiente de TEST. Se deja fijo a dev como guarda: aunque alguien exporte
# FLX_BASE apuntando a producción por error, este conector escribe documentos y
# no tiene por qué tocar el ERP en vivo desde una herramienta de integración.
FLX_BASE = env("FLX_BASE", "https://api-dev.curifor.cl").rstrip("/")
if "api.curifor.cl" in FLX_BASE and "api-dev" not in FLX_BASE:
    sys.exit("FLX_BASE apunta a PRODUCCIÓN. Este conector es solo para TEST "
             "(api-dev.curifor.cl). Corrige la variable antes de seguir.")

FLX_USER = env("FLX_USER")
FLX_PASS = env("FLX_PASS")
FLX_TIPO_DOCTO = env("FLX_TIPO_DOCTO")            # el que informe TI
FLX_EMPRESA = env("FLX_EMPRESA", "E01")          # Curifor es E01 (visto en TEST, 28-08)
FLX_BODEGA = env("FLX_BODEGA", "")
FLX_CTACTE_GENERICA = env("FLX_CTACTE_GENERICA", "")   # cuenta "público", si aplica

SUPABASE_URL = env("SUPABASE_URL", "https://ordgsglujssgzmnlmcus.supabase.co").rstrip("/")
SUPABASE_KEY = env("SUPABASE_KEY")               # service_role: corre server-side

# El certificado de Flexline lo firma la propia Curifor (CN=*.curifor.cl,
# O=CURIFOR), así que la validación estándar no lo reconoce. Se puede entregar
# el certificado raíz en FLX_CA_BUNDLE para validar de verdad; si no está, se
# acepta el certificado de todos modos, porque la conexión es a un host interno
# conocido y no a un tercero de internet.
_CA = env("FLX_CA_BUNDLE")
if _CA and os.path.exists(_CA):
    TLS = ssl.create_default_context(cafile=_CA)
else:
    TLS = ssl.create_default_context()
    TLS.check_hostname = False
    TLS.verify_mode = ssl.CERT_NONE


# ------------------------------------------------------------------ http
def _pedir(url, metodo="GET", cuerpo=None, cabeceras=None, contexto=None):
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    h = {"Accept": "application/json"}
    if datos is not None:
        h["Content-Type"] = "application/json"
    h.update(cabeceras or {})
    req = urllib.request.Request(url, data=datos, headers=h, method=metodo)
    try:
        r = urllib.request.urlopen(req, timeout=20, context=contexto)
        cuerpo_r = r.read()
        return r.status, (json.loads(cuerpo_r) if cuerpo_r else None)
    except urllib.error.HTTPError as e:
        detalle = e.read().decode("utf-8", "replace")
        return e.code, detalle


# ------------------------------------------------------------------ Flexline
class Flexline:
    def __init__(self):
        self.token = None

    def login(self):
        if not (FLX_USER and FLX_PASS):
            sys.exit("Faltan FLX_USER / FLX_PASS. El usuario de API es Postventa y "
                     "la clave viene en el correo de TI. Van como variables de "
                     "entorno de este equipo, nunca en el código.")
        estado, resp = _pedir(
            FLX_BASE + "/api/Security/Auth", "POST",
            {"userName": FLX_USER, "password": FLX_PASS}, contexto=TLS)
        if estado != 200:
            raise RuntimeError(f"Auth falló ({estado}): {resp}")
        # el swagger declara la respuesta como {token, userName}
        self.token = resp.get("token") if isinstance(resp, dict) else resp
        if not self.token:
            raise RuntimeError(f"Auth respondió 200 pero sin token: {resp}")
        return self.token

    def _auth(self):
        return {"Authorization": "Bearer " + self.token}

    def nuevo_documento(self, doc):
        estado, resp = _pedir(
            FLX_BASE + "/api/Documentos/NewDocumento", "POST", doc,
            self._auth(), contexto=TLS)
        return estado, resp


# ------------------------------------------------------------------ Supabase
def sb(ruta, metodo="GET", cuerpo=None, prefer=None):
    if not SUPABASE_KEY:
        sys.exit("Falta SUPABASE_KEY (service_role) para leer las recepciones.")
    h = {"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY}
    if prefer:
        h["Prefer"] = prefer
    return _pedir(SUPABASE_URL + "/rest/v1/" + ruta, metodo, cuerpo, h,
                  contexto=ssl.create_default_context())


def recepciones_pendientes():
    """Las recepciones ya ingresadas al taller que aún no se llevaron al ERP.

    `erp_sincronizado` marca lo ya inyectado, para no crear el documento dos
    veces si el conector corre de nuevo. Esa columna se crea con
    herramientas/setup_supabase_erp.sql.
    """
    estado, filas = sb(
        "reservas_web?estado=eq.en_taller&erp_sincronizado=is.null"
        "&select=*&order=recibido_en.asc")
    if estado != 200:
        raise RuntimeError(f"No se pudieron leer las recepciones ({estado}): {filas}")
    return filas or []


def marcar_sincronizada(id_reserva, numero_erp):
    sb("reservas_web?id=eq." + id_reserva, "PATCH",
       {"erp_sincronizado": datetime.now(timezone.utc).isoformat(),
        "erp_documento": str(numero_erp) if numero_erp is not None else None},
       prefer="return=minimal")


# ------------------------------------------------------------------ mapeo
def mapear_documento(rec):
    """Traduce una recepción a un documento Flexline.

    Es el corazón del conector y lo que MÁS depende de datos que solo tiene TI:
    el tipoDocto correcto, qué es obligatorio, y cómo se identifica el cliente
    (idCtaCte). Lo que va acá es una traducción razonable con los campos que el
    Swagger declara; los valores concretos se ajustan cuando TI responda.
    """
    if not FLX_TIPO_DOCTO:
        raise RuntimeError("Falta FLX_TIPO_DOCTO: el tipo de documento de la OT "
                           "en la configuración de Curifor. Lo informa TI.")

    fecha = rec.get("recibido_en") or datetime.now(timezone.utc).isoformat()
    veh = " ".join(x for x in [rec.get("marca"), rec.get("modelo"), rec.get("anio")] if x)

    glosa = f"OT {rec.get('ro') or ''} · {rec.get('patente') or ''} · {veh}".strip(" ·")

    doc = {
        "empresa": FLX_EMPRESA,
        "tipoDocto": FLX_TIPO_DOCTO,
        # numero vacío: que Flexline asigne el correlativo. Si TI dice que hay
        # que mandar el RO como número, se pone rec["ro"] acá.
        "numero": "",
        "fecha": fecha,
        "tipoCtaCte": "CL",                       # cliente; confirmar con TI
        "idCtaCte": rec.get("rut") or FLX_CTACTE_GENERICA or "",
        "moneda": "$",
        "paridad": 1,
        "centroCosto": _centro_costo(rec.get("sucursal")),
        "bodega": FLX_BODEGA,
        "glosa": glosa[:250],
        "usuarioCreacion": rec.get("recibido_por") or "plataforma",
        # el acta viaja en campos de análisis, que Flexline expone libres: así
        # el km real y las observaciones quedan en el documento sin inventar
        # una estructura que el ERP no tiene.
        "analisisE1": str(rec.get("km_real") or ""),
        "analisisE2": (rec.get("obs") or "")[:250],
        "analisisE3": rec.get("patente") or "",
        "analisisE4": veh,
        "detalles": _detalles(rec),
    }
    return doc


def _centro_costo(sucursal):
    """La sucursal de la recepción al centro de costo del ERP.

    El mapa real lo tiene TI; hoy devuelve la sucursal tal cual para que el
    documento no salga sin centro de costo, y se corrige con la tabla oficial.
    """
    return (sucursal or "").replace("CURIFOR ", "").strip()


def _detalles(rec):
    """Las líneas del documento.

    Una OT recién ingresada todavía no tiene repuestos cargados -eso ocurre en
    el taller-, así que por ahora va una línea de servicio con el trabajo
    pedido. Cuando se defina si la OT lleva las líneas del cotizador, se arma
    acá desde rec (marca/modelo/servicio).
    """
    return [{
        "secuencia": 1,
        "linea": 1,
        "producto": os.environ.get("FLX_PRODUCTO_SERVICIO", "SERVICIO"),
        "cantidad": 1,
        "precio": rec.get("valor") or 0,
        "comentario": (rec.get("comentario") or rec.get("servicio") or "Recepción")[:250],
    }]


# ------------------------------------------------------------------ proceso
def procesar_una(flx, rec, enviar=True):
    doc = mapear_documento(rec)
    if not enviar:
        return None, doc
    estado, resp = flx.nuevo_documento(doc)
    if estado not in (200, 201):
        raise RuntimeError(f"NewDocumento rechazó RO {rec.get('ro')} "
                           f"({estado}): {resp}")
    numero = None
    if isinstance(resp, dict):
        numero = resp.get("numero") or resp.get("correlativo") or resp.get("id")
    marcar_sincronizada(rec["id"], numero)
    return numero, doc


def correr(enviar=True):
    pendientes = recepciones_pendientes()
    if not pendientes:
        print("Sin recepciones pendientes de llevar al ERP.")
        return
    flx = None
    if enviar:
        flx = Flexline()
        flx.login()
        print(f"Autenticado en {FLX_BASE}.")
    print(f"{len(pendientes)} recepción(es) por procesar.")
    ok = 0
    for rec in pendientes:
        try:
            numero, _ = procesar_una(flx, rec, enviar)
            ok += 1
            print(f"  ✓ RO {rec.get('ro')} · {rec.get('patente')} -> "
                  f"{'documento ' + str(numero) if numero else 'OK'}")
        except Exception as e:
            print(f"  ✗ RO {rec.get('ro')} · {rec.get('patente')}: {e}")
    print(f"Listas {ok} de {len(pendientes)}.")


# ------------------------------------------------------------------ cli
def main():
    ap = argparse.ArgumentParser(description="Conector Recepción -> Flexline ERP (TEST)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--probar-login", action="store_true",
                   help="Solo intenta autenticarse contra la API de TEST.")
    g.add_argument("--demo", action="store_true",
                   help="Arma el documento de las recepciones pendientes y lo imprime SIN enviar.")
    g.add_argument("--una-vez", action="store_true",
                   help="Procesa e inyecta lo pendiente una vez.")
    g.add_argument("--loop", type=int, metavar="SEG",
                   help="Procesa cada SEG segundos, indefinidamente.")
    args = ap.parse_args()

    if args.probar_login:
        flx = Flexline()
        try:
            flx.login()
            print(f"OK: autenticado en {FLX_BASE}. Token de {len(flx.token)} caracteres.")
        except Exception as e:
            print(f"Login falló: {e}")
            sys.exit(1)
        return

    if args.demo:
        pendientes = recepciones_pendientes()
        if not pendientes:
            print("Sin recepciones pendientes para mostrar.")
            return
        print(f"{len(pendientes)} recepción(es). Documentos que se enviarían "
              f"(NO se envía nada):\n")
        for rec in pendientes:
            try:
                _, doc = procesar_una(None, rec, enviar=False)
                print(json.dumps(doc, indent=1, ensure_ascii=False))
                print("-" * 60)
            except Exception as e:
                print(f"  ✗ RO {rec.get('ro')}: {e}")
        return

    if args.una_vez:
        correr(enviar=True)
        return

    if args.loop:
        print(f"Conector en marcha contra {FLX_BASE}, cada {args.loop} s. "
              f"Ctrl+C para detener.")
        while True:
            try:
                correr(enviar=True)
            except Exception as e:
                print(f"[ciclo con error] {e}")
            time.sleep(args.loop)


if __name__ == "__main__":
    main()
