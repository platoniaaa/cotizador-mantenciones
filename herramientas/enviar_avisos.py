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


def diagnostico():
    """Cuenta lo que se enviaria, sin mandar nada. Sirve para saber que pasaria
    al encender el sistema, antes de encenderlo."""
    pend = rpc("avisos_pendientes", {}) or []
    print(f"Avisos en cola ahora mismo: {len(pend)}")
    if not pend:
        print("Nada pendiente: encender no dispara ningun correo.")
        return 0
    from collections import Counter
    for tipo, n in Counter(p["tipo"] for p in pend).most_common():
        print(f"  {tipo}: {n}")
    print("Destinatarios (parcial, por privacidad):")
    for p in pend[:15]:
        e = p.get("destinatario") or ""
        m = (e[:2] + "***@" + e.split("@")[-1]) if "@" in e else "(sin correo)"
        print(f"    {p['tipo']:<18} {m}")
    if len(pend) > 15:
        print(f"    ... y {len(pend)-15} mas")
    return 0


def conectar_smtp():
    """Abre la sesion SMTP ya autenticada. 587 va con STARTTLS."""
    srv = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30)
    srv.ehlo()
    srv.starttls(context=ssl.create_default_context())
    srv.ehlo()
    srv.login(SMTP_USER, SMTP_PASS)
    return srv


def prueba(destino):
    """Manda UN correo de prueba. No toca la base ni las reservas: sirve para
    comprobar que la casilla autentica y que el mensaje llega de verdad."""
    if not destino:
        print("Falta indicar a que direccion mandar la prueba.")
        return 1
    msg = EmailMessage()
    msg["Subject"] = "Prueba del sistema de avisos · Curifor Postventa"
    msg["From"] = formataddr((REMITENTE_NOM, REMITENTE))
    msg["To"] = destino
    msg.set_content("Prueba del sistema de avisos de la agenda de Curifor. "
                    "Si lees esto, el envio quedo funcionando.")
    msg.add_alternative(
        '<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;'
        'border:1px solid #dfe6f2;border-radius:14px;overflow:hidden">'
        '<div style="background:#001b6c;color:#fff;padding:20px 24px">'
        '<div style="font-size:11px;letter-spacing:2px;color:#9fb2ff;font-weight:700">'
        'SERVICIO Y POSTVENTA</div>'
        '<div style="font-size:22px;font-weight:800;letter-spacing:2px">CURIFOR</div></div>'
        '<div style="padding:24px;color:#16233a;font-size:15px;line-height:1.55">'
        '<p style="margin:0 0 12px"><b>Prueba del sistema de avisos.</b></p>'
        '<p style="margin:0 0 12px">Si recibiste este correo, el envio automatico '
        'de la agenda quedo funcionando: la casilla autentica y los mensajes llegan.</p>'
        '<p style="margin:0;color:#5a6880;font-size:13px">Este correo es de prueba. '
        'No corresponde a ninguna hora agendada.</p></div></div>', subtype="html")
    try:
        srv = conectar_smtp()
    except Exception as e:
        print(f"NO se pudo autenticar en {SMTP_HOST}:{SMTP_PORT}")
        print(f"  motivo: {e}")
        return 1
    try:
        srv.send_message(msg)
        print(f"Correo de prueba enviado a {destino}.")
        print("Revisa la bandeja (y la carpeta de spam, por si acaso).")
        return 0
    except Exception as e:
        print(f"Autentico bien, pero fallo al entregar: {e}")
        return 1
    finally:
        try:
            srv.quit()
        except Exception:
            pass


def interruptor(encender_lo):
    """Enciende o apaga el envio, escribiendo avisos_config.activo."""
    import urllib.request as _u
    cuerpo = json.dumps({"activo": bool(encender_lo)}).encode()
    req = _u.Request(f"{SUPABASE_URL}/rest/v1/avisos_config?id=eq.true",
                     data=cuerpo, method="PATCH",
                     headers={"apikey": SERVICE_KEY,
                              "Authorization": f"Bearer {SERVICE_KEY}",
                              "Content-Type": "application/json",
                              "Prefer": "return=representation"})
    try:
        with _u.urlopen(req, timeout=30) as r:
            fila = json.loads(r.read().decode() or "[]")
        estado = fila[0].get("activo") if fila else None
        print(f"Sistema de avisos: {'ENCENDIDO' if estado else 'APAGADO'}")
        return 0
    except Exception as e:
        print(f"No se pudo cambiar el interruptor: {e}")
        return 1


def main():
    modo = os.environ.get("MODO", "normal").lower()
    if modo == "diagnostico":
        return diagnostico()
    if modo == "prueba":
        return prueba(os.environ.get("DESTINO", "").strip())
    if modo == "encender":
        return interruptor(True)
    if modo == "apagar":
        return interruptor(False)

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
