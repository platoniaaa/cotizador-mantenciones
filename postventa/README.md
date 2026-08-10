# Post Venta — la app de gestión

Control y Gestión de OT, Cuenta Ficha, Informes, Loaners, Indicadores, Campañas
y el Planificador de Taller. Es la app que el equipo usa a diario.

Está escrita en **Streamlit** (Python). El resto de la plataforma —cotizador,
agenda y recepción— es HTML y JavaScript, y se sirve aparte. Las dos comparten
lo que importa: **el mismo proyecto de Supabase**, o sea los mismos clientes,
vehículos, sucursales y órdenes.

## Cómo desplegarla en tu cuenta

Hoy corre desde el repositorio de Cristian, en su cuenta. Estos pasos la dejan
corriendo desde **este** repositorio, en **tu** cuenta, sin cambiar el código.

1. Entra a [share.streamlit.io](https://share.streamlit.io) con tu cuenta de GitHub.
2. **Create app** → **Deploy a public app from GitHub** y completa:

   | Campo | Valor |
   |---|---|
   | Repository | `platoniaaa/cotizador-mantenciones` |
   | Branch | `main` |
   | Main file path | `postventa/app.py` |
   | Python version | 3.11 |

3. Antes de darle *Deploy*, abre **Advanced settings → Secrets** y pega:

   ```toml
   SUPABASE_DB_PASSWORD = "la clave de la base"
   ```

   La clave está en Supabase → *Project Settings* → *Database*. Es la única
   que hace falta: la app ya no necesita el token de GitHub.

4. **Deploy**. La primera vez demora unos minutos instalando las librerías.

Queda en `https://<nombre-que-elijas>.streamlit.app`.

## Qué revisar la primera vez

- Que la tabla de OT muestre las **2.069 órdenes**.
- Que el Planificador de Taller cargue el tablero de tu sucursal.
- Que al editar la categoría o las notas de una OT y recargar, el cambio siga ahí.
- Que Cuenta Ficha muestre los saldos.

Si algo sale vacío, casi siempre es el secreto: sin él la app vuelve a buscar
los datos en GitHub y no los encuentra.

## De dónde salen los datos

Los documentos viven en la tabla `documentos` de Supabase, y los lee y escribe
`datos_supabase.py`. La app **no toca GitHub**.

Quien los actualiza a diario sigue siendo el consolidador de Cristian, que corre
en su máquina. Ese script no está en este repositorio a propósito: es su
proceso, y además lleva credenciales que no pueden vivir en un repo público.

## El tablero del taller

El Planificador va embebido y guarda solo. Antes lo hacía con un token de
GitHub **con permiso de escritura sobre todo el repositorio**, metido en el
HTML que recibía cada usuario. Ahora usa un *vale*: dura 12 horas, queda a
nombre de quien lo pidió y solo abre los dos documentos del tablero. Está en
`herramientas/setup_supabase_tablero.sql`.

## Volver atrás

Si se saca el secreto `SUPABASE_DB_PASSWORD`, la app vuelve a usar GitHub tal
como funcionaba antes. No hay que tocar código para revertir.
