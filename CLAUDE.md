# Plataforma de Postventa · Curifor

Contexto para quien continúe este proyecto, con Claude o sin él. Las cuentas, los accesos y el
orden del traspaso están en `TRASPASO.md`: leerlo primero. `README.md` describe solo el cotizador.

## Qué es

Sitio estático (HTML, CSS y JavaScript, sin build) más un sistema de correos. Los datos viven en
Supabase.

| Archivo | Qué es | Quién lo usa |
|---|---|---|
| `agendar.html` | Agenda pública: el cliente pide hora, en 3 pasos | Clientes |
| `confirmar.html` | Confirmación de la hora desde el enlace del correo | Clientes |
| `cliente.html` | Cotizador de mantenciones, vista para el cliente | Clientes |
| `cotizador.html` | Cotizador de mantenciones: marca, modelo y kilometraje dan el presupuesto | Asesores |
| `taller.html` | Agenda interna y recepción del vehículo (acta con fotos y firma, PDF, exportación a Excel) | Personal |
| `ots.html`, `postventa.html` | Control y Gestión Post Venta (órdenes de trabajo, indicadores): versión HTML de la app Streamlit de `postventa/`. Confirmar con el negocio cuál se usa | Personal |
| `login.html`, `clave-nueva.html` | Acceso interno y definición de clave | Personal |
| `index.html` | Portal de entrada interno | Personal |

## Cómo está armado

- **Sin servidor propio.** GitHub Pages sirve los archivos y el navegador habla directo con
  Supabase (PostgREST) con la llave anónima de `js/agenda-config.js`, que es pública por diseño.
  La seguridad la dan las políticas RLS de la base.
- **Acceso interno:** Supabase Auth. Las políticas piden sesión y varias, además, un correo
  `@curifor.com`. No hay roles de administrador en la app: cualquier cuenta con sesión tiene el
  mismo acceso. Quien crea usuarios en Supabase es el administrador de hecho.
- **Correos** (comprobante al agendar, recordatorio a 7 días y a 24 horas):
  1. Se crea la reserva en `reservas_web`.
  2. El trigger `reservas_web_avisar` le avisa a GitHub (`repository_dispatch`, evento
     `aviso_nuevo`) con un token clásico guardado en Vault (`GITHUB_DISPATCH_TOKEN`).
  3. `.github/workflows/avisos.yml` corre `herramientas/enviar_avisos.py`: pide a la base los
     avisos pendientes (`avisos_tomar` los reserva en la misma transacción, así no hay duplicados),
     los manda por SMTP (puerto 587) y anota el resultado (`avisos_marcar`).
  4. El texto del correo se arma en la base (`public.aviso_html`), con `<table>`: Outlook ignora
     `div`, márgenes y bordes redondeados.
  - **Por qué corre en GitHub y no en Supabase:** las Edge Functions de Supabase no salen por el
    puerto 587, el único abierto en el servidor de correo, y `pg_net` solo manda JSON, que el
    login OAuth de Microsoft rechaza. TI no autorizó Microsoft Graph.
  - Un reloj de respaldo corre en teoría cada 5 minutos; en la práctica GitHub lo atrasa horas.
    Por eso importa el disparo inmediato.
  - **Modos del workflow** (*Actions → Avisos de agenda → Run workflow*): `normal`,
    `diagnostico` (cuenta sin enviar), `prueba` (manda un correo de prueba sin tocar la base),
    `apagar` y `encender`.

## El flujo de la reserva y la recepción

Todo gira alrededor de **una tabla central, `reservas_web`**, compartida por todas las estaciones.
La columna `estado` es el ciclo de vida:

`nueva` → `en_gestion` → `agendada` → `recibida` → `en_taller` → `cerrada`
(también `rechazada` y `cancelada`)

- **`nueva`:** la crea el cliente desde `agendar.html`, con la llave anónima.
- **`en_gestion`:** un asesor tomó la solicitud en `taller.html`. Se reclama con un PATCH
  condicional (`?estado=eq.nueva`): si dos estaciones la toman a la vez, solo una gana. Antes se
  marcaba `agendada` de inmediato y, si el asesor abandonaba el modal, el cliente se quedaba sin
  respuesta y sin rastro.
- **`agendada` → `recibida` → `en_taller` → `cerrada`:** las mueve el personal (requiere sesión
  `@curifor.com`) con `webActualizarEstado()` en `js/taller.js`.

**Recepción** (botón *Ingresar a Taller*, función `agIngresarTaller()` en `js/taller.js`):

1. Sin las **fotos obligatorias** no deja ingresar el vehículo: son la prueba del estado en que
   llegó (decisión tomada el 13-08-2026). Si faltan el kilometraje real, el combustible o las
   firmas, avisa pero deja pasar: el taller no puede quedar detenido por un campo.
2. Pide el **número de orden de trabajo (RO)** a la base con la función `siguiente_correlativo`:
   un contador por sucursal y por tipo (`oc` = agendamiento, `ro` = orden de trabajo), de 7
   dígitos. Los pisos son 1190001 (OC) y 2000001 (RO). Si no hay red, a los 6 segundos sigue con un
   contador local y la fusión renumera si hay un choque.
3. Deja la reserva en `en_taller` con su `ro` y guarda el acta **en la misma fila**: `acc`
   (accesorios), `comb`, `km_real`, `obs`, `danos` (mapa de daños), `fotos`, `firmas`, y quién y
   cuándo recibió y entregó (`recibido_en`, `recibido_por`, `entregado_en`, `entregado_por`).
4. Las fotos y las firmas son imágenes en el bucket privado `recepciones` de Supabase Storage (solo
   `@curifor.com`); en la fila queda la ruta.
5. Descarga el **acta de recepción en PDF** (`js/acta-pdf.js`).

**Estado compartido del taller.** `taller_estado` guarda una fila por sucursal: un documento JSON en
`data` y un `version` para el bloqueo optimista. Si otra estación guardó primero, el navegador
relee, fusiona a tres bandas (base, lo mío, lo del servidor) y reintenta; nadie pisa a nadie.
`taller_archivo` guarda lo ya cerrado, una fila por entidad, para que la bandeja no crezca sin
límite.

**ERP.** El conector (ver *Estado*) lee las recepciones en `en_taller` y las registra en Flexline.
Para no registrar dos veces la misma, marca `erp_sincronizado` y `erp_documento` (columnas de
`setup_supabase_erp.sql`, que viaja junto al conector).

Los SQL que definen todo esto: `setup_supabase_reservas.sql`, `setup_supabase_flujo.sql`,
`setup_supabase_acta_archivo.sql`, `setup_supabase_danos.sql`, `setup_supabase_firmas.sql`,
`setup_supabase_storage.sql`, `setup_supabase_correlativos.sql` y `setup_supabase_taller_estado.sql`.

## Reglas que no se rompen

1. **Ninguna credencial en el repo ni en el chat.** El repo es público. Las claves van en los
   *Secrets* de GitHub, en Vault de Supabase o en variables de entorno, y las carga la persona
   responsable, no Claude.
2. **ERP (Flexline): solo el ambiente de pruebas.** Nunca el de producción sin autorización
   escrita de TI y de la jefatura.
3. **No tocar el repo `Cjerez-curi/curifor-ots`** (app Streamlit de otra persona). Publican allá
   `herramientas/publicar_bundle.py`, `herramientas/publicar_taller_bundle.py` y el paso 3 de
   `herramientas/actualizar_diario.py`: no usarlos sin una instrucción explícita.
4. **La agenda pública no autocompleta datos personales desde el RUT.** Cualquiera puede escribir
   un RUT ajeno: autocompletar nombre o teléfono filtraría datos de terceros.
5. **Los datos de clientes no van al repo.** `data/clientes.json` está en `.gitignore`; esos datos
   viven en Supabase.
6. **Antes de publicar un formulario con campos nuevos, probar un INSERT real** contra la base. La
   agenda estuvo semanas sin guardar ninguna reserva porque el formulario pedía columnas que la
   base no tenía.

## Cómo publicar un cambio

```bash
git add <archivos> && git commit -m "lo que se cambió"
python herramientas/bump_cache.py     # pone el mismo ?v=<commit> en todas las páginas
git add -u && git commit -m "Bump cache"
git push origin main
```

El `bump_cache` no es opcional: GitHub Pages manda `max-age=600` y sin él la gente sigue viendo la
versión anterior. Pages tarda entre 30 segundos y 2 minutos en reflejar el cambio.

Para ver el sitio en tu PC: `python -m http.server 8532` y abrir `http://localhost:8532`. Con doble
clic en el HTML el navegador bloquea la carga de los JSON.

Los SQL de `herramientas/setup_supabase_*.sql` se aplican pegándolos en el editor SQL de Supabase y
están escritos para poder repetirse. `setup_correos_todo.sql` reúne el sistema de correos. Los
`arreglo_*.sql` son correcciones puntuales; `arreglo_token_disparo.sql` sirve cada vez que haya que
cambiar el token del disparo.

## Trampas conocidas

Cosas que ya costaron tiempo y no se ven en el código.

- **PowerShell 5.1 y los acentos.** `Get-Content -Raw` sin `-Encoding UTF8` lee un UTF-8 sin BOM
  como Windows-1252: un SQL pegado así guardó «MaÃ±ana» en la base. Leer siempre con
  `-Encoding UTF8` (o con Python) y comprobar una palabra con tilde.
- **`css/taller.css` no es UTF-8 válido** (falla en el byte 41864, verificado el 13-10-2026).
  Editarlo en modo binario o convertirlo antes: un editor que lo regrabe como UTF-8 rompe las
  tildes.
- **Estado de la reserva.** Nace como `nueva` (valor por defecto de la columna);
  `avisos_pendientes()` acepta `nueva` y `agendada`.
- **Leer la respuesta del disparo.** `pg_net` responde aparte, unos 5 segundos después. En el editor
  SQL de Supabase: `select status_code, left(content, 160), created from net._http_response order
  by created desc limit 5;`
  - `204`: funciona.
  - `404`: la cuenta dueña del token no tiene acceso al repo, o `GITHUB_REPO` está mal escrito.
  - `401`: token mal copiado, vencido o revocado.
  - `403`: token *fine-grained*. GitHub solo acepta el clásico (`ghp_`) en este servicio.
- **GitHub apaga el reloj de respaldo** tras 60 días sin actividad en un repo público; el disparo
  inmediato sigue funcionando. Los avisos de las corridas programadas llegan a quien editó el cron
  por última vez.
- **La dirección del sitio está escrita en tres lugares de la base:** la plantilla del correo (el
  logo), `avisos_config.url_confirmar` y `GITHUB_REPO` en Vault. GitHub no redirige los sitios de
  Pages si el repo se transfiere o se renombra: cambiar la dirección exige actualizar los tres.
- **Pruebas en producción.** Usar patentes `ZZ…` y borrarlas después con
  `herramientas/limpiar_pruebas_agenda.sql` (editar la lista de patentes).
- **El envío no avisa si faltan los secretos:** el flujo termina en verde. Revisar con el modo
  `diagnostico`.

## Estado al traspaso (13-10-2026)

**Funciona:** agenda del cliente; correo de comprobante y recordatorios de 7 días y 24 horas, con
disparo inmediato; agenda interna con exportación a Excel; recuperación de clave por correo y, si
el correo falla, por SQL (`herramientas/clave_usuario_directo.sql`).

**Pendiente:**

1. **Site URL de Supabase** sigue en `localhost:3000`: el correo de «olvidé mi contraseña» lleva a
   una página que no existe. Lo cambia el dueño de la organización de Supabase
   (*Authentication → URL Configuration*); hay que agregar la dirección del sitio a *Redirect URLs*.
2. **Inventario del cotizador congelado** al 07-08-2026. Lo actualizaba una tarea de Windows
   (*Curifor Cotizador actualizacion diaria*, que corre `herramientas/actualizar_diario.py`) en el
   PC del desarrollador. Apunta a una carpeta que ya no existe y falla con `0x8007010B`. Si se
   repara o se mueve, correrla con `--solo-datos`: sin eso también publica en el repo de otra
   persona (regla 3). Decidir si se mantiene el inventario o se saca del cotizador.
3. **ERP:** el conector `herramientas/conector_flexline.py` (registra la recepción como documento
   en Flexline) está listo pero apagado, y **no está en el repo** porque trae datos internos: se
   entrega aparte. Falta que TI dé el permiso *Documentos* al usuario `Postventa` en el ambiente de
   pruebas y el tipo de documento de una orden de trabajo.
4. **Servicios y asesores por sucursal** (`js/agenda-servicios.js`): los cargó el desarrollador con
   un supuesto. El negocio debe validarlos.
5. **Logos de BAIC y GAC** salen como texto en la franja de marcas.

Las cuentas (GitHub, Supabase, casilla de salida), qué hay que rotar y el orden del traspaso están
en `TRASPASO.md`.

## Cómo trabajar aquí (para Claude)

- Responder en español, directo y sin relleno.
- Verificar antes de afirmar: leer el archivo, probar contra la base, mostrar la salida real. Lo que
  no se comprobó se dice que no se comprobó.
- Pedir confirmación antes de tocar producción: SQL que escribe o borra, correos reales, cambios de
  cuentas o de secretos.
- Los comentarios del código explican el *por qué*: leerlos antes de cambiar algo que parece raro.
- Antes de dar por listo un cambio visible, abrirlo en el navegador y revisar la consola.
