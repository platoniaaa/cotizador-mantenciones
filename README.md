# Cotizador de Mantenciones · Curifor

Plataforma web para cotizar mantenciones preventivas por **marca → modelo → versión → (año)**, replicando el flujo de la calculadora de precios de Ford Chile, adaptada a las 8 marcas que atiende Curifor.

## Cómo usarla

1. Doble clic en **`INICIAR.bat`** (Windows). Abre `http://localhost:8010` en el navegador.
   - Alternativa manual: en esta carpeta, `python -m http.server 8010` y abrir esa URL.
2. Elige marca, modelo, versión (y año en el caso de Ford).
3. Presiona **Ver plan de mantención**: aparece el carrusel de revisiones con precio, operaciones incluidas, desglose de repuestos/lubricantes/mano de obra, **disponibilidad de stock por repuesto**, servicios adicionales y packs (Omoda/Jaecoo).
4. **Descargar cotización (Excel)**: genera un `.xlsx` con la mantención seleccionada (detalle + stock + adicionales), el plan completo y los packs.

> Debe abrirse a través del servidor local (no con doble clic al `index.html`), porque el navegador bloquea la carga de los archivos JSON con el protocolo `file://`.

## Sistema de Taller y Agendamiento (`taller.html`)

Módulo integrado al cotizador (enlace **"Taller y agenda"** en el topbar) con 8 pestañas:
Agendamiento → Status Taller → Recepción → Preparación de citas → Planificador → JPCB → Bodega (pre-picking) → Reportes.

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
  index.html            Cotizador (2 pasos: selección → resultados)
  taller.html           Sistema de Taller y Agendamiento (8 pestañas)
  css/estilos.css       Estilos compartidos (paleta azul corporativa, responsive)
  css/taller.css        Estilos del módulo Taller
  js/app.js             Lógica del cotizador: selector encadenado, carrusel, totales, adicionales
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
