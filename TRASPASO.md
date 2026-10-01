# Traspaso de la Plataforma de Postventa

Documento de entrega. Octubre 2026.

Quien reciba esto puede operar y mantener la plataforma sin depender de quien la
construyó. Está escrito para alguien que sabe de sistemas pero no conoce este
proyecto.

---

## 1. Qué es

Tres módulos que comparten una misma base de datos.

| Módulo | Para qué sirve | Quién lo usa |
|---|---|---|
| **Agenda** (`agendar.html`) | El cliente pide hora de taller: sus datos, su auto, el servicio, la sucursal y el horario | Clientes, sitio público |
| **Cotizador** (`cotizador.html`) | Arma el presupuesto de una mantención según marca, modelo y kilometraje | Asesores de servicio |
| **Taller** (`taller.html`) | Centro de agendamiento interno, recepción del vehículo y acta con fotos | Personal, requiere cuenta |

Además, un **sistema de correos** que avisa al cliente automáticamente: el
comprobante al agendar, un recordatorio a los 7 días y otro a las 24 horas.

---

## 2. Dónde vive cada cosa

| Pieza | Dónde | Detalle |
|---|---|---|
| Código | GitHub, repositorio `cotizador-mantenciones` | Público |
| Sitio en vivo | GitHub Pages | https://platoniaaa.github.io/cotizador-mantenciones/ |
| Base de datos | Supabase, proyecto `ordgsglujssgzmnlmcus` | Organización *Curifor-Sistemas*, proyecto *Cotizador*, plan Pro |
| Envío de correos | GitHub Actions, flujo *Avisos de agenda* | Corre solo |
| Casilla de salida | serviciotecnico@curifor.cl | Servidor smtp14.mycloudmailbox.com, puerto 587 |

**No hay servidor propio.** El sitio son archivos estáticos (HTML, CSS,
JavaScript) y los datos se consultan directo contra Supabase desde el navegador.
Eso significa que no hay nada que mantener encendido, pero también que todo
depende de esas dos cuentas.

---

## 3. LO URGENTE: accesos que hay que traspasar

**Todo lo anterior cuelga hoy de una cuenta personal de GitHub (`platoniaaa`).**
Si esa cuenta se cierra o se pierde, la empresa se queda sin plataforma y sin
acceso a los datos de sus clientes. Esto es lo primero que hay que resolver.

### 3.1 La cuenta de GitHub

El repositorio, el sitio publicado y el envío de correos viven ahí.

**Qué hacer:** crear una organización de GitHub a nombre de Curifor (es gratis) y
transferir el repositorio. En *Settings → General → Danger Zone → Transfer
ownership*. Se conserva el historial completo.

Al transferir, **la dirección del sitio cambia** (deja de ser
`platoniaaa.github.io/...`). Hay que avisar a quien tenga el enlace publicado.

### 3.2 La cuenta de Supabase

Ahí están **todos los datos de clientes**: nombres, RUT, teléfonos, correos,
patentes y el historial de reservas. Hoy se entra con la cuenta de GitHub
mencionada.

**Qué hacer:** agregar a otra persona de la empresa como miembro de la
organización *Curifor-Sistemas* en Supabase, con rol de administrador, **antes**
de que la cuenta original deje de usarse. Sin esto, nadie puede entrar a la base
de datos ni recuperar la información.

### 3.3 Los secretos del envío de correos

En el repositorio hay seis valores guardados (*Settings → Secrets and variables →
Actions*):

```
SUPABASE_URL           SMTP_HOST
SUPABASE_SERVICE_KEY   SMTP_PORT
SMTP_USER              SMTP_PASS
```

Los valores no se pueden leer desde GitHub una vez guardados, solo reemplazar.
**Quien reciba la plataforma debe tener a mano la contraseña de
serviciotecnico@curifor.cl y la clave de servicio de Supabase**, porque si se
transfiere el repositorio hay que volver a cargarlos.

> La contraseña de la casilla la entrega TI (la tiene Jhomny Rodríguez). La clave
> de servicio de Supabase está en el panel del proyecto, en *Settings → API*.

### 3.4 Dos credenciales que conviene rotar

Por el camino, dos credenciales quedaron escritas en correos y conversaciones:
la contraseña de la casilla serviciotecnico@ y la clave de servicio de Supabase.
**Conviene cambiarlas durante el traspaso**, y de paso queda la plataforma con
credenciales que solo conoce quien la recibe.

---

## 4. Cómo publicar un cambio

El sitio se actualiza solo al subir código. No hay que copiar archivos a ningún
servidor.

```bash
git add .
git commit -m "lo que se cambió"
python herramientas/bump_cache.py     # fuerza a los navegadores a tomar lo nuevo
git add -u && git commit -m "Bump cache"
git push origin main
```

El paso del `bump_cache` **no es opcional**: GitHub Pages le dice al navegador
que guarde los archivos por diez minutos. Sin ese paso se publica un cambio y la
gente sigue viendo el anterior.

El sitio tarda entre 30 segundos y 2 minutos en reflejar el cambio.

---

## 5. El sistema de correos

### Cómo funciona

1. Un cliente agenda y la reserva queda en la base.
2. Un flujo en GitHub Actions revisa cada cierto rato qué correos corresponde mandar.
3. Los envía por la casilla de servicio técnico y anota el resultado.

La base **reserva cada envío antes de mandarlo**, así que un cliente nunca recibe
el mismo correo dos veces, aunque el proceso corra dos veces en paralelo.

### Los botones de emergencia

En el repositorio, pestaña **Actions → Avisos de agenda → Run workflow**, hay un
desplegable con cinco modos:

| Modo | Qué hace |
|---|---|
| `normal` | Envía lo que esté pendiente |
| `diagnostico` | Muestra cuántos correos saldrían, **sin enviar nada** |
| `prueba` | Manda un correo de prueba a la dirección que se indique |
| `apagar` | **Corta todos los envíos al instante** |
| `encender` | Los reactiva |

Si algún día salen correos indebidos, **`apagar` es lo primero**: detiene todo sin
tocar nada más y sin perder información.

### Si un correo no llega

1. Entrar a *Actions* y ver si el flujo corrió y quedó verde.
2. Abrir la corrida y leer la salida: dice a qué dirección envió cada correo o por
   qué falló.
3. Si dice "No hay avisos pendientes", la base no encontró nada que mandar: puede
   que el sistema esté apagado o que esa reserva ya tenía su correo enviado.

---

## 6. Pendientes conocidos

Cosas que quedaron a medias o sin resolver, para que nadie las descubra a los
golpes.

| Pendiente | Estado | Impacto |
|---|---|---|
| **Los correos llegan tarde** | El reloj de GitHub debería correr cada 5 min pero se demora hasta 4 horas | Un cliente agenda y su comprobante puede tardar |
| **El disparo inmediato no funciona** | Se configuró un token para que el correo salga en segundos; GitHub lo rechaza con error 403 por permisos | Es la causa de lo anterior |
| **Hospedaje sin definir** | El sitio vive en GitHub Pages, bajo una cuenta personal; estaba en conversación con TI apuntar `agendamiento.curifor.cl` | El sitio actual y el nuevo conviven |
| **Conexión con el ERP** | Se preparó un conector para registrar la orden de trabajo en Flexline, pero el usuario `Postventa` no tiene permiso de *Documentos* en el ambiente de prueba | La recepción no llega al ERP |
| **Logos de BAIC y GAC** | Los demás están; esos dos salen como texto | Cosmético |
| **Servicios por sucursal** | En `js/agenda-servicios.js` está la lista de qué atiende cada taller y qué asesor cubre cada uno; la cargó el desarrollador con un supuesto | **El negocio debe revisarla**: si está mal, se ofrecen horas donde no se puede atender |

### Para destrabar el disparo inmediato

El token de GitHub guardado en Supabase necesita más permisos. Hay que editarlo
(*Settings → Developer settings → Personal access tokens*) y agregarle **Actions:
Read and write**, o bien reemplazarlo por un token clásico con permiso `repo`,
que es el camino que la documentación de GitHub garantiza.

---

## 7. Documentación técnica adicional

El código está comentado explicando **por qué** está hecho así, no solo qué hace.
Donde hay una decisión no obvia, hay un comentario que la justifica.

Archivos que conviene leer antes de tocar algo:

| Archivo | Qué explica |
|---|---|
| `herramientas/enviar_avisos.py` | Por qué el envío corre fuera de Supabase |
| `herramientas/setup_supabase_avisos_smtp.sql` | Cómo se evita mandar correos repetidos |
| `herramientas/setup_supabase_avisos_plantilla2.sql` | El diseño del correo y por qué va armado en tablas |
| `js/agenda-cliente.js` | El flujo de los tres pasos y qué datos NO se autocompletan por seguridad |
| `js/taller.js` | La agenda interna y la exportación a Excel |

Los archivos `herramientas/setup_supabase_*.sql` son las migraciones de la base.
Se aplican pegándolos en el editor SQL de Supabase. Todos están escritos para
poder repetirse sin romper nada.

---

## 8. Checklist del traspaso

- [ ] Crear organización de GitHub a nombre de Curifor
- [ ] Transferir el repositorio a esa organización
- [ ] Dar acceso de administrador en Supabase a alguien de la empresa
- [ ] Recargar los seis secretos en el repositorio ya transferido
- [ ] Cambiar la contraseña de serviciotecnico@curifor.cl y la clave de servicio de Supabase
- [ ] Verificar que el flujo de correos siga corriendo tras la transferencia
- [ ] Avisar la nueva dirección del sitio a quien tenga el enlace publicado
- [ ] Que el negocio revise los servicios y asesores por sucursal
- [ ] Definir con TI dónde queda alojado el sitio y el dominio

**El primero y el tercero son los urgentes.** Lo demás se puede hacer con calma;
esos dos, no: son los que determinan si la empresa conserva el acceso a su
plataforma y a los datos de sus clientes.
