# -*- coding: utf-8 -*-
"""Aplica un archivo .sql de esta carpeta contra Supabase.

Uso:
    python herramientas/aplicar_sql.py setup_supabase_tablero.sql

La clave va en la variable de entorno PGPASSWORD. Todo corre dentro de UNA
transacción: si una sentencia falla, no queda nada a medio aplicar.
"""
import os
import ssl
import sys

import pg8000.dbapi

AQUI = os.path.dirname(os.path.abspath(__file__))


def partir(sql):
    """Separa el archivo en sentencias por `;`.

    Recorre carácter a carácter en vez de hacer `split(";")` porque un punto y
    coma puede ir DENTRO de un texto entre comillas o de un bloque `$$ … $$`, y
    ahí no separa nada. Cortar en esos puntos y coma partía la sentencia por la
    mitad y Postgres respondía "unterminated quoted string".
    """
    sentencias, actual = [], []
    i, n = 0, len(sql)
    en_texto = en_dolar = en_linea = en_bloque = False
    while i < n:
        c = sql[i]
        par = sql[i:i + 2]

        if en_linea:
            if c == "\n":
                en_linea = False
                actual.append(c)
            i += 1
            continue
        if en_bloque:
            if par == "*/":
                en_bloque = False
                i += 2
                continue
            i += 1
            continue
        if en_texto:
            actual.append(c)
            if c == "'":
                if sql[i + 1:i + 2] == "'":      # '' es una comilla escapada
                    actual.append("'")
                    i += 2
                    continue
                en_texto = False
            i += 1
            continue
        if en_dolar:
            actual.append(c)
            if par == "$$":
                actual.append("$")
                en_dolar = False
                i += 2
                continue
            i += 1
            continue

        if par == "--":
            en_linea = True
            i += 2
            continue
        if par == "/*":
            en_bloque = True
            i += 2
            continue
        if par == "$$":
            actual.append(par)
            en_dolar = True
            i += 2
            continue
        if c == "'":
            actual.append(c)
            en_texto = True
            i += 1
            continue
        if c == ";":
            stmt = "".join(actual).strip()
            if stmt:
                sentencias.append(stmt)
            actual = []
            i += 1
            continue

        actual.append(c)
        i += 1

    resto = "".join(actual).strip()
    if resto:
        sentencias.append(resto)
    return sentencias


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Falta el archivo .sql")
    ruta = sys.argv[1]
    if not os.path.isabs(ruta):
        ruta = os.path.join(AQUI, ruta)
    if not os.path.isfile(ruta):
        raise SystemExit(f"No existe: {ruta}")

    pwd = os.environ.get("PGPASSWORD", "")
    if not pwd:
        raise SystemExit("Falta la variable de entorno PGPASSWORD.")

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    c = pg8000.dbapi.connect(
        user="postgres.ordgsglujssgzmnlmcus", password=pwd,
        host="aws-0-us-east-1.pooler.supabase.com", port=5432,
        database="postgres", ssl_context=ctx, timeout=90)
    c.autocommit = False
    cur = c.cursor()

    with open(ruta, "r", encoding="utf-8") as f:
        sentencias = partir(f.read())

    print(f"{os.path.basename(ruta)}: {len(sentencias)} sentencias")
    try:
        for i, stmt in enumerate(sentencias, 1):
            cur.execute(stmt)
            print(f"   {i:>3}. {' '.join(stmt.split())[:78]}")
        c.commit()
        print("\naplicado y confirmado.")
    except Exception as e:
        c.rollback()
        print(f"\nFALLÓ en la sentencia {i}: {e}")
        print("no se aplicó nada (se revirtió todo).")
        raise SystemExit(1)
    finally:
        c.close()


if __name__ == "__main__":
    main()
