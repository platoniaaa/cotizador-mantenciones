# Cotizador de Mantenciones · Curifor

Plataforma web para cotizar mantenciones preventivas por **marca → modelo → versión → (año)**, replicando el flujo de la calculadora de precios de Ford Chile, adaptada a las 8 marcas que atiende Curifor.

## Cómo usarla

1. Doble clic en **`INICIAR.bat`** (Windows). Abre `http://localhost:8010` en el navegador.
   - Alternativa manual: en esta carpeta, `python -m http.server 8010` y abrir esa URL.
2. Elige marca, modelo, versión (y año en el caso de Ford).
3. Presiona **Ver plan de mantención**: aparece el carrusel de revisiones con precio, operaciones incluidas, desglose de repuestos/lubricantes/mano de obra, **disponibilidad de stock por repuesto**, servicios adicionales y packs (Omoda/Jaecoo).
4. **Descargar cotización (Excel)**: genera un `.xlsx` con la mantención seleccionada (detalle + stock + adicionales), el plan completo y los packs.

> Debe abrirse a través del servidor local (no con doble clic al `index.html`), porque el navegador bloquea la carga de los archivos JSON con el protocolo `file://`.

## Búsqueda por patente

En el paso 1 se puede escribir la patente y el cotizador consulta el registro del
vehículo ([boostr.cl](https://boostr.cl/patente)) para dejar puestos **marca, modelo y año**.

El registro entrega el modelo todo junto (`"RANGER XLT 3.2 4X4"`), así que el
cotizador lo parte contra el catálogo: gana el nombre de modelo más largo que
calce, de modo que *Grand Santa Fe* no se confunda con *Santa Fe* ni *X55 PLUS*
con *X55*. La **versión no la informa el plan gratuito**: si el modelo tiene una
sola, queda elegida; si tiene varias, el selector se resalta en ámbar para que el
asesor la elija de la lista ya filtrada.

Requiere una API key (gratuita, con registro). Cómo se entrega según dónde corra:

| Entorno | Quién llama a la API | Dónde va la key |
|---|---|---|
| App de Curifor (Streamlit) | el servidor, en Python | `st.secrets["BOOSTR_API_KEY"]` |
| Local / GitHub Pages | el navegador | `window._COTIZ_BOOSTR_KEY` |

**La key nunca se commitea.** En la app va en los secrets del deploy; el bloque a
insertar en `app.py` está en `herramientas/integracion_patente_streamlit.py`.
Sin key configurada el campo avisa y el catálogo sigue funcionando normal.

## Publicar en la app de Curifor (`curifor-ots`)

El cotizador también vive **dentro de la app Streamlit de Curifor**
(`Cjerez-curi/curifor-ots`), embebido en un iframe. Ahí no corre esta carpeta:
va compilado en `cotizador_data.json` (HTML+CSS+JS+XLSX+logo+índice+stock+pautas,
todo gzip+base64). Para regenerarlo y publicarlo:

```bash
python herramientas/publicar_bundle.py              # simulación: construye y compara
python herramientas/publicar_bundle.py --escribir   # lo deja en el clon del repo
python herramientas/publicar_bundle.py --publicar   # pull --rebase + commit + push
```

Espera el clon en `C:\dev\curifor-ots` (configurable con `--repo` o la variable
`CURIFOR_OTS_REPO`). Requiere permiso de escritura en ese repo.

Dos cosas que conviene saber de ese repo: la app **commitea sola** sus JSON de
datos cada pocos minutos (por eso el script hace `pull --rebase` antes de subir),
y el cotizador **tarda ~10 min en reflejar el cambio** (`_cargar_cotizador_gz`
cachea 600 s), o hasta reiniciar la app en Streamlit Cloud.

## Cotizador para clientes (`cliente.html`)

Cara pública del cotizador, pensada para que la use el cliente final (o el asesor
frente a él). Usa **los mismos datos** (`data/indice.json` y `data/pautas/`), pero
solo muestra el **precio oficial de la pauta con IVA**: nunca costos, códigos de
repuesto, stock ni el modo interno.

Flujo en 3 pasos, mobile-first: **tu auto** (marca → modelo → versión → año) →
**kilometraje** (grilla con el valor de cada mantención) → **cotización** (precio
grande, qué se cambia y qué se revisa, servicios adicionales, plan completo y FAQ).
Cierra con **"Agendar por WhatsApp"**, que abre el chat con el mensaje ya escrito
(auto, mantención, adicionales y valor), y con **"Descargar cotización"** (imprimir a PDF).

> **Antes de publicarla hay que poner el número de WhatsApp real** en `CONTACTO.wsp`,
> al inicio de `js/cliente.js` (formato `56912345678`). Viene con un placeholder.

Los textos de las pautas vienen del Excel del fabricante con anotaciones internas
(`(Ver nota 2)`, `(Costo cliente)`, `(Sugerida a Inspección (I)`): `cliente.js` las
limpia antes de mostrarlas, porque "costo cliente" dentro de lo que sí está incluido
se lee como un cobro extra. Cuando una pauta no trae operaciones detalladas, lo que
se cambia se deduce de los repuestos y lubricantes de esa mantención (solo el nombre).

## Sistema de Taller y Agendamiento (`taller.html`)

Módulo integrado al cotizador (enlace **"Taller y agenda"** en el topbar) con 7 pestañas:
Agendamiento → Recepción → Preparación de citas → Planificador → JPCB → Bodega (pre-picking) → Reportes.
El agendamiento pasa directo a Recepción con el botón **"Ingresar"** de la tabla; la entrega del vehículo se registra desde el detalle de la orden en el JPCB (etapa "En espera por pago").

- **Integración con el cotizador**: el botón **"Agendar"** del paso 2 lleva la cotización activa
  (marca/modelo/versión/año/revisión/valor) al taller; al elegir una hora libre el formulario
  se abre pre-llenado. El vehículo del agendamiento se elige con los mismos selectores
  encadenados del catálogo (`data/indice.json`).
- **Bodega / pre-picking**: el kit de repuestos de cada orden de mantención se calcula desde la
  **pauta real** (`data/pautas/<id>.json`) y muestra la **disponibilidad de stock** por código
  (`data/stock.json`, giros Curifor y Frontera).
- **Persistencia**: agendamientos y órdenes se guardan en `localStorage` (por navegador/estación;
  no se comparten entre PCs ni se suben al repo). Botones para cargar datos de demostración y
  para borrar todo.
- **Pendiente (fase posterior)**: backend compartido, integración ERP, notificaciones al cliente,
  fotos y firma digital en la recepción.

## Estructura

```
plataforma/
  index.html            Cotizador interno (2 pasos: selección → resultados)
  cliente.html          Cotizador para clientes (3 pasos, sin costos ni stock)
  taller.html           Sistema de Taller y Agendamiento (8 pestañas)
  css/estilos.css       Estilos compartidos (paleta azul corporativa, responsive)
  css/cliente.css       Estilos del cotizador para clientes
  css/taller.css        Estilos del módulo Taller
  js/app.js             Lógica del cotizador: selector encadenado, carrusel, totales, adicionales
  js/cliente.js         Lógica del cotizador para clientes (incluye el número de WhatsApp)
  js/taller.js          Lógica del taller: agenda, recepción, JPCB, planificador, bodega
  js/vendor/xlsx.full.min.js  Librería SheetJS (generación de Excel, offline)
  data/
    indice.json         Catálogo marca → modelo → versión
    pautas/*.json        Detalle por versión (precios, ítems, operaciones)
    stock.json           Disponibilidad de repuestos por código (Curifor / Frontera)
  herramientas/
    generar_datos.py     Parser de los Excel de pautas → JSON
    actualizar_stock.py  Cruza el stock de SharePoint con los códigos de las pautas → stock.json
    stock_fuente/        Snapshot de las 2 tablas de stock (no se versiona)
    validacion.md        Reporte de parseo y cuadratura de totales
    stock_reporte.md     Reporte de cobertura del cruce de stock
  INICIAR.bat            Arranque rápido del servidor local
```

## Actualizar el stock

El stock vive en dos tablas de SharePoint que se van actualizando:
`Stock bodegas.xlsx` (giro Curifor, autos livianos) y `Stock bodegas Frontera.xlsx` (giro Frontera, camiones).

```bash
python herramientas/actualizar_stock.py --descargar   # baja las tablas frescas y regenera stock.json
python herramientas/actualizar_stock.py               # usa el último snapshot local
```

La descarga reutiliza la sesión de SharePoint del proyecto Data BI (perfil Playwright ya
logueado en `...\3. Actualizacion\automatizacion\`). Si la sesión expiró, refrescarla con
`python subir_sharepoint.py login` en ese proyecto.

El cruce empareja el código del repuesto de la pauta con el stock (Curifor usa `Producto` =
`"<rubro> <código>"`; se quita el rubro). Los lubricantes a granel se cruzan por presentación
o por código en la descripción. Cobertura actual: ~260 de ~320 códigos con stock. Los que no
cruzan se muestran como *s/d* (sin dato).

## Actualizar precios / datos

Cuando cambien las pautas de mantención en Excel (están en la carpeta superior a `plataforma/`):

```bash
python herramientas/generar_datos.py
```

Regenera todos los JSON y el reporte `herramientas/validacion.md`. No hay que tocar el código de la interfaz.

## Fuentes de datos

Las 8 pautas de mantención (enero 2026; Ford junio 2026; Omoda/Jaecoo julio 2025):
BAIC, JAC, JIM, Mahindra, Shineray, SWM, Omoda/Jaecoo, Ford.

La plataforma **siempre muestra el total oficial** que trae cada hoja Excel. El parser además recalcula la suma de componentes como control de calidad (ver `validacion.md`).

## Notas de alcance

- Los valores son **referenciales, con IVA incluido, en CLP**.
- Ford es la única marca con **año** como dimensión (año modelo). En el resto, la vigencia va por versión (Activo / Hasta 2023 / etc.).
- La disponibilidad de repuestos en stock (`StockCurifor_*.xlsx`) queda para una fase posterior.
