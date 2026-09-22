# -*- coding: utf-8 -*-
"""Envía los correos de la agenda. Corre en GitHub Actions.

POR QUÉ ESTO CORRE AFUERA Y NO EN SUPABASE
-------------------------------------------
Supabase no puede: sus Edge Functions no abren conexiones salientes por los
puertos 25 y 587, y el servidor de correo de Curifor solo tiene el 587 (el 465
está cerrado). Los runners de GitHub no tienen esa restricción.

QUÉ HACE
--------
1. Le pide a la base los avisos que toca mandar. La base, en el mismo acto, los
   reserva: por eso dos corridas simultáneas nunca mandan el mismo correo.
2. Los entrega por SMTP.
3. Anota en la base cómo le fue a cada uno.

El texto del correo se arma en la base (aviso_html), no acá: así el asunto y el
cuerpo no dependen de qué versión de este script esté corriendo.

NO REINTENTA lo que falla. Un correo rechazado queda anotado como 'error' para
revisarlo; reintentarlo cada 15 minutos solo multiplica el problema.

Variables (van como Secrets del repositorio, nunca en el código):
    SUPABASE_URL          https://<ref>.supabase.co
    SUPABASE_SERVICE_KEY  la service_role key del proyecto
    SMTP_HOST             smtp14.mycloudmailbox.com
    SMTP_PORT             587
    SMTP_USER             serviciotecnico@curifor.cl
    SMTP_PASS             la contraseña de esa casilla
    SMTP_FROM             (opcional) remitente; por defecto SMTP_USER
    SMTP_FROM_NAME        (opcional) nombre visible
    AVISOS_LIMITE         (opcional) máximo por corrida, por defecto 25
"""
import json
import os
import smtplib
import ssl
import sys
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formataddr


def env(nombre, defecto=None):
    return os.environ.get(nombre, defecto)


# Mientras no estén cargados los Secrets, el reloj igual dispara este script
# cada 15 minutos. Si se cayera con error, GitHub mandaría un correo de job
# fallido cada vez. Sale bien y sin hacer nada hasta que esté configurado.
FALTAN = [n for n in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "SMTP_HOST",
                      "SMTP_USER", "SMTP_PASS") if not os.environ.get(n)]
if FALTAN:
    print("Avisos todavía sin configurar. Faltan estos Secrets: " + ", ".join(FALTAN))
    sys.exit(0)

SUPABASE_URL = (env("SUPABASE_URL") or "").rstrip("/")
SERVICE_KEY = env("SUPABASE_SERVICE_KEY")
SMTP_HOST = env("SMTP_HOST")
SMTP_PORT = int(env("SMTP_PORT", "587"))
SMTP_USER = env("SMTP_USER")
SMTP_PASS = env("SMTP_PASS")
REMITENTE = env("SMTP_FROM") or SMTP_USER
REMITENTE_NOM = env("SMTP_FROM_NAME", "Curifor Servicio y Postventa")
LIMITE = int(env("AVISOS_LIMITE", "25"))


def rpc(funcion, args):
    """Llama una función de la base. Usa la service_role key: este script corre
    en un runner privado, nunca en el navegador del cliente."""
    pedido = urllib.request.Request(
        f"{SUPABASE_URL}/rest/v1/rpc/{funcion}",
        data=json.dumps(args).encode("utf-8"),
        headers={
            "apikey": SERVICE_KEY,
            "Authorization": f"Bearer {SERVICE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(pedido, timeout=30) as r:
            crudo = r.read().decode("utf-8").strip()
            return json.loads(crudo) if crudo else None
    except urllib.error.HTTPError as e:
        detalle = e.read().decode("utf-8", "replace")[:300]
        sys.exit(f"La base respondió {e.code} en {funcion}: {detalle}")
    except Exception as e:
        sys.exit(f"No se pudo hablar con la base en {funcion}: {e}")


def armar(aviso):
    msg = EmailMessage()
    msg["Subject"] = aviso["asunto"]
    msg["From"] = formataddr((REMITENTE_NOM, REMITENTE))
    msg["To"] = formataddr((aviso.get("nombre") or "", aviso["email"]))
    # Texto plano de respaldo, para los clientes que no muestran HTML.
    msg.set_content(
        "Tienes una hora agendada en Curifor.\n"
        "Este correo se ve mejor en un lector con formato HTML.\n"
    )
    msg.add_alternative(aviso["html"], subtype="html")
    return msg


def main():
    avisos = rpc("avisos_tomar", {"p_limite": LIMITE}) or []
    if not avisos:
        print("No hay avisos pendientes.")
        return 0

    print(f"{len(avisos)} aviso(s) por enviar.")
    enviados = fallidos = 0

    contexto = ssl.create_default_context()
    try:
        servidor = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30)
        servidor.ehlo()
        servidor.starttls(context=contexto)   # 587 usa STARTTLS
        servidor.ehlo()
        servidor.login(SMTP_USER, SMTP_PASS)
    except Exception as e:
        # Si no se pudo ni conectar, los avisos quedan marcados con el motivo
        # para no dejarlos colgando como 'pendiente' para siempre.
        for a in avisos:
            rpc("avisos_marcar", {
                "p_reserva": a["reserva_id"], "p_tipo": a["tipo"],
                "p_ok": False, "p_detalle": f"sin conexion SMTP: {e}"[:300]})
        sys.exit(f"No se pudo conectar a {SMTP_HOST}:{SMTP_PORT} -> {e}")

    try:
        for a in avisos:
            try:
                servidor.send_message(armar(a))
                rpc("avisos_marcar", {
                    "p_reserva": a["reserva_id"], "p_tipo": a["tipo"],
                    "p_ok": True, "p_detalle": "ok"})
                enviados += 1
                print(f"  enviado  {a['tipo']:<16} -> {a['email']}")
            except Exception as e:
                rpc("avisos_marcar", {
                    "p_reserva": a["reserva_id"], "p_tipo": a["tipo"],
                    "p_ok": False, "p_detalle": str(e)[:300]})
                fallidos += 1
                print(f"  FALLO    {a['tipo']:<16} -> {a['email']}: {e}")
    finally:
        try:
            servidor.quit()
        except Exception:
            pass

    print(f"Listo. Enviados: {enviados}. Fallidos: {fallidos}.")
    return 1 if fallidos else 0


if __name__ == "__main__":
    sys.exit(main())
