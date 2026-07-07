# Cotizador de Mantenciones · Curifor

Plataforma web para cotizar mantenciones preventivas por **marca → modelo → versión → (año)**, replicando el flujo de la calculadora de precios de Ford Chile, adaptada a las 8 marcas que atiende Curifor.

## Cómo usarla

1. Doble clic en **`INICIAR.bat`** (Windows). Abre `http://localhost:8010` en el navegador.
   - Alternativa manual: en esta carpeta, `python -m http.server 8010` y abrir esa URL.
2. Elige marca, modelo, versión (y año en el caso de Ford).
3. Presiona **Ver plan de mantención**: aparece el carrusel de revisiones con precio, operaciones incluidas, desglose de repuestos/lubricantes/mano de obra, servicios adicionales y packs (Omoda/Jaecoo).

> Debe abrirse a través del servidor local (no con doble clic al `index.html`), porque el navegador bloquea la carga de los archivos JSON con el protocolo `file://`.

## Estructura

```
plataforma/
  index.html            Interfaz (2 pasos: selección → resultados)
  css/estilos.css       Estilos (paleta azul corporativa, responsive)
  js/app.js             Lógica: selector encadenado, carrusel, totales, adicionales
  data/
    indice.json         Catálogo marca → modelo → versión
    pautas/*.json        Detalle por versión (precios, ítems, operaciones)
  herramientas/
    generar_datos.py     Parser de los Excel → JSON
    validacion.md        Reporte de parseo y cuadratura de totales
  INICIAR.bat            Arranque rápido del servidor local
```

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
