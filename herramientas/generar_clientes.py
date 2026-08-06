# -*- coding: utf-8 -*-
"""
Construye el índice de clientes/vehículos para el autocompletado de la Agenda y
la Recepción, a partir del reporte de agendamientos históricos (CSV export).

Cuando el asesor escribe un RUT o una patente, la plataforma rellena los campos
faltantes (nombre, teléfono, e-mail, marca/modelo, año, km, VIN) con el ÚLTIMO
registro conocido de ese cliente/vehículo.

Salida: data/clientes.json  →  { porPatente: {...}, porRut: {...}, actualizado }
Lo consumen taller.js (agenda/recepción). Se regenera cuando llegue un CSV nuevo:
    python herramientas/generar_clientes.py "<ruta del CSV>"
"""
import csv, io, json, sys, re
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent           # .../plataforma
DEFAULT_CSV = BASE.parent / "datos-reporte_2026_07_29_07_06.csv"
CSV = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CSV
OUT = BASE / "data" / "clientes.json"

normPat = lambda s: re.sub(r"[^A-Z0-9]", "", (s or "").upper())
normRut = lambda s: re.sub(r"[^0-9K]", "", (s or "").upper())
cap = lambda s: " ".join(w.capitalize() for w in (s or "").split())

def _reparar_encabezados(fieldnames):
    """
    El export viene con un desajuste de codificación: el CUERPO del archivo es
    cp1252 (así vienen "Curicó", "CAMPAÑAS", etc.), pero la fila de ENCABEZADOS
    llegó en UTF-8. Al abrir todo el archivo como cp1252 (necesario para el
    cuerpo), un encabezado como "Año" —2 bytes UTF-8 para la ñ— se parte en dos
    caracteres sueltos ("AÃ±o", 4 caracteres) y r.get("Año") nunca calza: el
    campo queda vacío en el 100% de las filas sin que nada avise el error.

    Se repara re-codificando cada encabezado con el codec equivocado (cp1252,
    el que se usó para decodificarlo) y decodificándolo de nuevo con el
    correcto (utf-8): si el resultado difiere, es que estaba mal decodificado.
    Un encabezado normal sin tildes queda idéntico (round-trip nulo), así que
    esto no afecta a los otros 31 encabezados aunque no se sepa cuál viene mal.
    """
    reparados = []
    for nombre in fieldnames:
        try:
            candidato = nombre.encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            candidato = nombre
        reparados.append(candidato)
    return reparados


def leer_filas(path):
    # el cuerpo del archivo es cp1252, delimitador ';', y la 1ª línea viene vacía
    with open(path, "r", encoding="cp1252", errors="replace", newline="") as f:
        primera = f.readline()
        if primera.strip():          # por si algún export no trae la línea vacía
            f.seek(0)
        reader = csv.DictReader(f, delimiter=";")
        reader.fieldnames = _reparar_encabezados(reader.fieldnames)
        yield from reader

def fecha_key(r):
    return (r.get("FechaAgendamiento") or "") + (r.get("Fecha Ingresa") or "")

por_patente, por_rut = {}, {}
n = 0
for r in leer_filas(CSV):
    n += 1
    rut = normRut(r.get("rutCliente", "")) + (r.get("Dv", "").strip().upper() if r.get("rutCliente") else "")
    pat = normPat(r.get("Patente", ""))
    nombre = cap(" ".join(x for x in (r.get("NombreCliente"), r.get("ApellidoPaterno"),
                                      r.get("ApellidoMaterno")) if x and x.strip()))
    cel = (r.get("Celular") or "").strip()
    fono = (r.get("Fono") or "").strip()
    mail = (r.get("Mail") or "").strip()
    modelo = (r.get("Modelo") or "").strip()
    anio = (r.get("Año") or "").strip()
    km = (r.get("Km") or "").strip()
    vin = (r.get("Vin") or "").strip()
    tipo = (r.get("Tipo cliente") or "").strip()
    fk = fecha_key(r)

    # datos del cliente (por RUT) — nos quedamos con el registro más reciente
    if rut and rut != "":
        prev = por_rut.get(rut)
        if not prev or fk >= prev["_fk"]:
            por_rut[rut] = {"_fk": fk, "rut": rut, "nombre": nombre or (prev or {}).get("nombre", ""),
                            "cel": cel, "fono": fono, "mail": mail, "tipo": tipo}
        # completar huecos con lo que haya
        for c, v in (("nombre", nombre), ("cel", cel), ("fono", fono), ("mail", mail)):
            if v and not por_rut[rut].get(c):
                por_rut[rut][c] = v

    # datos del vehículo (por patente) — vincula al cliente por RUT
    if pat and pat != "" and not re.match(r"^SP\d{4}$", pat):   # excluye patentes de prueba
        prev = por_patente.get(pat)
        if not prev or fk >= prev["_fk"]:
            por_patente[pat] = {"_fk": fk, "patente": pat, "modelo": modelo, "anio": anio,
                                "km": km, "vin": vin, "rut": rut, "nombre": nombre,
                                "cel": cel, "fono": fono, "mail": mail}

# limpiar la clave interna _fk
for d in (por_patente, por_rut):
    for v in d.values():
        v.pop("_fk", None)

out = {"actualizado": CSV.name, "porPatente": por_patente, "porRut": por_rut}
OUT.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

peso = OUT.stat().st_size / 1024 / 1024
print(f"filas procesadas: {n:,}")
print(f"patentes únicas:  {len(por_patente):,}")
print(f"RUTs únicos:      {len(por_rut):,}")
print(f"clientes.json:    {peso:.2f} MB  ->  {OUT}")
# muestra un par de ejemplos
for k in list(por_patente)[:2]:
    print("  ej patente", k, "->", {x: por_patente[k][x] for x in ("modelo","anio","nombre","cel")})
