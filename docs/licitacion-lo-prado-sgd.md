# Análisis de licitación — Sistema de Gestión Documental, I. Municipalidad de Lo Prado

**Documento analizado:** Bases Técnicas "Sistema de Gestión Documental" (Propuesta Pública), 25 páginas, firmadas
electrónicamente vía DocDigital (validador `QV8UWL-380`).
**Fecha del análisis:** 4 de septiembre de 2026.
**Rol del análisis:** evaluación técnica y comercial de factibilidad (go / no-go).

---

## 1. Veredicto

**Técnicamente no hay nada aquí que no sepamos construir. Comercialmente, en las condiciones escritas y con el
equipo actual, esta licitación no se puede tomar.**

La razón no es la dificultad del software. Es que la licitación exige **tener el producto ya terminado antes de
ofertar**, y nosotros no lo tenemos:

- Hay que presentar una **Demo funcional** (§10.1.b) pocos días después de la apertura de ofertas, mostrando
  decretos, memorándums, oficios, certificados de disponibilidad presupuestaria, sus flujos, visaciones y
  derivaciones. Sin producto no hay demo, y sin demo no hay puntaje.
- El plazo de **operatividad total es de 30 días corridos** desde el Acta de Inicio (§11.6), migración de datos
  históricos incluida. Eso es un plazo de *despliegue de un producto existente*, no de construcción.

Nuestra estimación de esfuerzo para construir esta solución desde cero es de **26 a 32 meses-desarrollador**
(detalle en §6). Ni comprimiendo ni contratando se llega a una demo creíble en el calendario de esta licitación.

**Recomendación: no ofertar solo.** Hay dos caminos que sí abren la puerta, descritos en §9.

---

## 2. Qué se está pidiendo realmente

No es "un sistema para firmar PDFs". Es una plataforma **ECM + BPM + firma electrónica avanzada**, en modalidad
SaaS, con licenciamiento ilimitado, para la operación administrativa completa de un municipio.

| Dimensión | Cifra de las bases |
|---|---|
| Tipos de documento a soportar | 16, ampliables durante el contrato (§2, §11.3) |
| Documentos procesados en 2025 | 42.136 (~170 por día hábil) |
| Usuarios concurrentes exigidos | 700 simultáneos, cuentas ilimitadas (§5) |
| Almacenamiento inicial | 200 GB, crecimiento ilimitado sin costo (§8.2) |
| Disponibilidad | 99,9% mensual → máx. **43 min de caída al mes** (§7) |
| Respuesta a incidente crítico | ≤ 15 min, solución ≤ 2 h — 24x7x365 (§7, §11.1) |
| Puesta en marcha total | 30 días corridos (§11.6) |
| Modalidad de precio | Suma alzada, en UF |

**Dato clave que cambia la lectura completa:** el municipio **ya tiene un sistema en producción llamado "Cero
Papel"** — la tabla de §9 son documentos que ya procesó durante 2025, y estas mismas bases están firmadas con
DocDigital. Esto **no es una implementación nueva: es un reemplazo de proveedor**. Hay un incumbente que conoce
los flujos, tiene la data y compite con ventaja en la demo y en la evaluación subjetiva ("si la solución
planteada cumple con los intereses municipales", §10.1.b).

**Volumen técnico: pequeño. Compromiso contractual: grande.** Esa asimetría es el eje de todo el análisis.

---

## 3. Los cinco bloqueadores

### 3.1. Alcance de desarrollo ilimitado a precio fijo — *el más grave*

Cuatro cláusulas que, juntas, forman un contrato de desarrollo sin techo:

> "todo desarrollo adicional o solicitudes deberán ser considerados en el valor de la oferta licitada, no
> permitiendo cobros por licenciamiento, horas de trabajo o ampliación de servidores, memorias, sistemas
> operativos o almacenamiento" — §1

- §11.1.c — mejoras y funcionalidades nuevas a solicitud del municipio, **implementadas en ≤ 5 días corridos**.
- §11.3.d — "desarrollar las API's que sean requeridas por la Municipalidad, tanto de lectura como de escritura
  […] **sin costo adicional**".
- §11.3 (p.19) — nuevos documentos y flujos a demanda, y si hay varias solicitudes **deben implementarse en
  paralelo, no secuencialmente**.
- §8.2 — ampliaciones de almacenamiento sin costo durante toda la vigencia.
- §1 — si cambia la Ley 21.180, los ajustes son sin costo para el municipio.

Traducido: **un backlog infinito, con SLA de 5 días, a precio congelado en UF**. El margen de un contrato así no
se conoce hasta que termina. Es la clase de cláusula que solo soporta un producto multi-tenant ya amortizado
entre varios clientes, donde el desarrollo marginal se reparte. Para un desarrollo a medida de un solo cliente,
el costo marginal es 100% nuestro y el ingreso está fijo.

### 3.2. El plazo de 30 días y la demo

Ya explicado en §1. Es el bloqueador que decide el go/no-go por sí solo.

### 3.3. Migración a ciegas

§11.6: "los datos serán entregados **una vez firmada el Contrato**". Y §11.6 exige además:

> "La carga de la información histórica debe respetar el árbol de directorio (nombres actuales) […] de forma que
> **los links se mantengan en los sitios donde se encuentran publicados**"

O sea: Transparencia Activa tiene URLs publicadas apuntando a las rutas del sistema actual, y hay que
**replicar el esquema de rutas del incumbente** — que no conocemos, y no podemos conocer antes de firmar. Se
está pidiendo cotizar a suma alzada una migración cuyo alcance solo se revela después de comprometerse, con un
plazo duro de 30 días y multas asociadas. Es riesgo no acotable.

### 3.4. SLA 24x7x365 con respuesta en 15 minutos

Disponibilidad 99,9% mensual y respuesta ≤15 min a cualquier hora implica **turno de guardia real**. Eso no lo
sostienen una o dos personas: se necesitan 3 o más en rotación, con escalamiento, monitoreo con paging y
procedimiento de rollback ensayado. Es un costo operacional fijo y permanente que hay que cargar al precio, y
que existe aunque el sistema nunca falle.

Además el 99,9% es *nuestro compromiso*, pero depende de proveedores aguas arriba. Si el proveedor de base de
datos/infraestructura cae, el incumplimiento y la multa son nuestros. Eso obliga a plan de infraestructura con
redundancia real, no al plan más barato.

### 3.5. La cadena de integraciones de terceros

| Integración | Dificultad técnica | Riesgo real |
|---|---|---|
| **FirmaGob** (§4.1) | Baja–media. Es una API REST: `api_token_key` + `Secret`, token de sesión, header OTP (omitible para firma desatendida), documento en base64, firma PKCS#7 incrustada, respuesta con checksum. | **El riesgo no es técnico: es de habilitación.** El registro de la aplicación ante la Secretaría de Gobierno Digital lo gestiona la institución, no el proveedor. Depende de tiempos del Estado dentro de un plazo de 30 días. |
| **Clave Única** (§11.3.c) | Baja. OIDC estándar. | Requiere habilitación previa ante Gobierno Digital. Mismo problema de calendario. |
| **DocDigital** (§4.2) | Media. | Es la propia plataforma del Estado; el alcance de "integrar" no está definido en las bases. |
| **CAS Chile** (§11.3.c) | **Alta / indeterminada.** | ERP municipal propietario y cerrado. La integración depende de la voluntad y los tiempos de un tercero que **no es parte del contrato** y no tiene obligación de cooperar. Riesgo sin mitigación desde nuestro lado. |
| **Active Directory / LDAP** (§11.3.g) | Media. | Requiere acceso a la red municipal o un conector. |
| **SIEM** (§11.10) | Baja. Exportación de eventos. | — |
| **Transparencia Activa** (§11.3.a-b) | Media. | Acoplado al problema de rutas de §3.3. |

Sumadas: **cuatro identidades distintas** (Clave Única, AD/LDAP, cuenta local, MFA) obligan a un IdP de verdad
(Keycloak, Entra, Auth0) — no a autenticación artesanal.

---

## 4. Lo que ya tenemos y sí transfiere

Vale decirlo, porque el problema no es la capacidad del equipo. En la plataforma actual (Curifor) ya están
resueltos, con criterio, varios de los problemas difíciles de este dominio:

| Ya resuelto en el repo | Equivalente en la licitación |
|---|---|
| `siguiente_correlativo()` — numeración atómica por sucursal, en una sola sentencia, sin colisiones | §3.1 numeración secuencial por tipo de documento. **Ya evitamos el bug de dos usuarios tomando el mismo número.** |
| `setup_supabase_flujo.sql` — máquina de estados con trazabilidad y trigger de `actualizado` | §3.4, §3.6 flujo de aprobadores y trazabilidad |
| `setup_supabase_avisos.sql` — pg_cron + pg_net, registro **antes** del envío para no duplicar correos | §3.7 alertas automatizadas al cerrar el flujo |
| `setup_supabase_dominios.sql` — regla de autorización centralizada en una función, no repartida en 17 policies | §5 roles y permisos |
| Storage privado con rutas + firmas persistidas | §4 firma de archivos, adjuntos |
| RLS, políticas por operación, `security definer` acotado | §6, §11.2 protección de datos |

Los comentarios de esos archivos SQL — pensar en idempotencia, en concurrencia, en el peor caso, en el error que
"no rompe nada visible" — son exactamente el criterio que este dominio exige. **El equipo sirve. El calendario y
el contrato, no.**

Lo que **no** transfiere: la generación de PDF en el navegador (`orden-pdf.js`, `acta-pdf.js`). Un documento
oficial firmado debe generarse en el servidor, determinista, en PDF/A, con la firma aplicada por FirmaGob. Ese
código habría que rehacerlo.

---

## 5. Lo que es genuinamente difícil de construir

Más allá del CRUD, estos son los puntos donde se va el tiempo y donde se pierde un proyecto:

1. **Inmutabilidad real del libro de eventos** (§1, §3.7). Las bases piden que cada cambio quede registrado
   "indubitablemente". RLS no basta: quien tenga la llave de servicio puede editar la historia. Se necesita
   bitácora *append-only* encadenada por hash (cada fila sella la anterior), permisos de UPDATE/DELETE revocados
   a nivel de motor, y sellado periódico. Retención mínima **24 meses** (§11.10).

2. **Motor de workflow parametrizable** (§3.4). Devolver al aprobador anterior *o* al creador, corrección de
   forma por el propio aprobador, VºBº, derivaciones, providencias. Y encima **subrogancias** (§3.3): delegación
   temporal con vigencia definida, registrando la identidad del subrogante. Esto no es un campo `estado`: es un
   motor de procesos con versionado de definiciones (un expediente en curso no puede cambiar de reglas a mitad
   de camino).

3. **Editor de documentos tipo Word con control de versiones** (§3.7). "Cada interacción, modificación, adición o
   eliminación de texto" registrada con usuario, timestamp de servidor y naturaleza del cambio. Es un editor
   colaborativo con historial granular — y luego hay que hacerlo **accesible WCAG 2.1 AA** (§4.12), que sobre un
   editor de texto enriquecido es de lo más difícil que hay en accesibilidad web.

4. **Firma con posicionamiento gráfico** (§4.4). Previsualizar el PDF, elegir dónde va la firma, más imagen de
   firma manuscrita. Bounded, pero es trabajo de UI fino sobre renderizado de PDF.

5. **Concurrencia en edición y visación.** Dos visadores sobre el mismo documento a la vez. Bloqueo optimista y
   resolución de conflictos, o corrupción silenciosa.

6. **Tabla de retención documental** (§11.5) — gestión de vigencia y destrucción programada de documentos. Es
   archivística, no solo software.

7. **Respaldo quincenal a servidor municipal** (§11.5) — volcado completo de bases de datos, con diccionario de
   datos, cada 15 días, cambiable por el ITS con 7 días de aviso, sin degradar producción. Automatización
   obligatoria desde el día uno.

8. **Borrado definitivo al término del contrato** (§6, §11.8) en tensión con la retención de respaldos. Se
   resuelve con *crypto-shredding* documentado, pero hay que diseñarlo antes, no después.

---

## 6. Estimación de esfuerzo

Construcción desde cero, equipo senior, incluyendo QA y documentación:

| Módulo | Meses-dev |
|---|---:|
| Ciclo de vida documental + editor + versiones + auditoría encadenada | 5,0 |
| Motor de workflow (visaciones, devoluciones, VºBº, subrogancias) | 4,0 |
| FirmaGob + posicionamiento de firma + QR verificador + PDF/A | 2,5 |
| Expedientes, anexos, relaciones, confidencialidad, tabla de retención | 3,0 |
| Identidad: roles, MFA, Clave Única, AD/LDAP, IdP | 2,0 |
| Plantillas, numeración correlativa, exportación PDF | 1,5 |
| Bandejas, notificaciones, buscador, reportes configurables | 2,0 |
| Migración histórica + preservación de links de Transparencia | 1,5 |
| Accesibilidad WCAG 2.1 AA, responsive, 4 navegadores, 4 SO | 1,5 |
| Infraestructura: 2 ambientes, IaC, backups, DR, monitoreo, SIEM | 2,0 |
| Mesa de ayuda con tickets, manuales, cápsulas de capacitación | 1,5 |
| QA, hardening, pruebas de carga (700 concurrentes), pentest | 2,0 |
| Integración CAS Chile | 1,0 – ∞ |
| **Total** | **≈ 29,5 meses-dev** |

Traducción a calendario:

- 2 personas → **~15 meses**
- 4–5 personas → **~7–8 meses**
- Plazo de la licitación → **1 mes**

No hay forma de cerrar esa brecha. Y ojo: la demo se exige *antes* de la adjudicación, no después.

---

## 7. Contradicciones y vacíos del documento

Estos son puntos concretos para el **foro de preguntas y respuestas** de mercadopublico. Varios son
contradicciones internas que, si no se aclaran, permiten que la comisión evaluadora declare "no cumple" a
cualquiera.

1. **SLA contradictorio.** §7 (tabla) fija falla crítica S1 con solución en **≤ 2 horas**. §11.1.a fija fallas
   graves con solución en **≤ 1 hora**. Son la misma cosa con dos plazos distintos. ¿Cuál rige?
2. **Taxonomías de severidad que no calzan.** §7 usa tres niveles (S1/S2/S3); §11.1 usa dos (graves/menores).
   ¿Dónde cae S2 (≤4 h) en el esquema de §11.1?
3. **Plazo de mejoras.** §11.1.c dice "no podrá superar los 5 días corridos". §11.3 (p.19) dice "un plazo a
   convenir con el ITS". ¿Cuál manda?
4. **"RAID 5" (§11.4)** es un requisito de hardware on-premise, incompatible conceptualmente con el
   almacenamiento de objetos de una arquitectura cloud (que se exige en §4.8 y §8.1). ¿Se acepta acreditar
   durabilidad equivalente o superior mediante certificaciones del proveedor cloud (SOC 2 / ISO 27001)?
5. **"Site Tier III" (§11.1)** — los hiperescalares no se certifican bajo el esquema Uptime Institute Tier.
   ¿Se acepta acreditación equivalente?
6. **"Enlaces de datos: empresa, tipo de enlace, velocidad" (§11.4)** — lenguaje de datacenter propio. ¿Cómo se
   acredita en un modelo SaaS sobre nube pública?
7. **700 usuarios concurrentes (§5)**: ¿son 700 *simultáneos* o 700 cuentas totales? La diferencia cambia el
   dimensionamiento y el costo. ¿Cómo se acredita — informe de prueba de carga?
8. **Migración (§11.6)**: ¿se puede conocer **antes de ofertar** el volumen real, el modelo de datos y la
   estructura de rutas del sistema actual? Sin eso, la migración no es cotizable a suma alzada.
9. **§11.5** pide entregar "acceso y **credenciales** de las personas que han accedido a los servidores".
   Entregar credenciales sería una mala práctica de seguridad. ¿Se entiende como *registro de accesos*?
10. **Marco legal desactualizado.** Las bases citan la Ley 19.628. La **Ley 21.719 entra en plena vigencia el 1
    de diciembre de 2026** — dentro de la vigencia de este contrato — y cambia sustantivamente las obligaciones
    del encargado del tratamiento (notificación de brechas, registro de actividades, subencargados,
    multas hasta 20.000 UTM). También aplica la **Ley 21.663** (Marco de Ciberseguridad). ¿Se incorporan? Si la
    respuesta es "sí, sin costo" (por analogía con la cláusula de Ley 21.180 en §1), eso es costo adicional no
    cotizado que hay que meter en el precio.
11. **Presupuesto y bases administrativas.** Este PDF son solo las Bases *Técnicas*. Falta lo decisivo:
    monto disponible, plazo del contrato, criterios de evaluación y ponderaciones, garantías (seriedad y fiel
    cumplimiento), requisitos de experiencia del oferente y régimen de multas. **Sin eso el go/no-go económico
    no se puede cerrar.** Hay que bajar la ficha completa de mercadopublico.
12. **§11.9** prohíbe usar información municipal para entrenar modelos de IA. Cumplible y correcto, pero si a
    futuro se agrega búsqueda semántica o resumen automático, exige contrato de retención cero con el proveedor
    de modelos. Anotarlo antes, no después.

---

## 8. Riesgo de multas

Con SLA de 15 minutos, plazo de 5 días para mejoras, 30 días de implementación y respaldos quincenales, la
superficie de incumplimiento es amplia y medida en unidades muy pequeñas de tiempo. El régimen de multas está en
las Bases Administrativas — que no tenemos. **Ese documento puede convertir un contrato marginalmente rentable
en uno estructuralmente perdedor**, y es lo primero que hay que leer antes de seguir evaluando.

---

## 9. Escenarios

### A. Ofertar solos, construyendo desde cero — ❌ descartado
29 meses-dev contra 1 mes de plazo, sin producto para la demo. No es viable.

### B. Ofertar sobre una base open source (Alfresco, OpenKM, Nuxeo, Mayan EDMS + Camunda/Flowable) — ❌ para *esta* licitación
Acorta el núcleo documental, pero todo lo chileno (FirmaGob, DocDigital, Clave Única, decretos, transparencia,
UX municipal) sigue siendo desarrollo nuestro, y adaptar un ECM ajeno suele ser más lento que construir. Piso
realista: 6–9 meses. Sirve como estrategia de producto, no como respuesta a este plazo.

### C. Unión Temporal de Proveedores con un proveedor que ya tenga el producto en producción — ✅ único camino para esta licitación
Ellos ponen la plataforma y la demo; nosotros ponemos integración, migración, soporte local y desarrollo a
medida. Requiere encontrar al socio y negociar en el plazo de la licitación, y reparte el margen. Antes de
intentarlo hay que leer las Bases Administrativas: muchas exigen experiencia previa comprobable en
municipalidades, lo que puede dejarnos fuera igual.

### D. No ofertar, y usar estas bases como especificación de producto — ✅ la jugada estratégica
Este documento es una **especificación de requisitos inusualmente completa y gratis**. La Ley 21.180 obliga a
las 345 comunas del país a lo mismo, y estas licitaciones se repiten permanentemente. El plan sería:

1. Construir un **SGD multi-tenant** con este BT como backlog (7–8 meses con equipo de 4–5).
2. Conseguir **una municipalidad chica como socio de diseño** — vía trato directo, convenio marco o una
   licitación de menor exigencia — para tener referencia y producción real.
3. Entrar a las rondas de 2027 con producto, demo y experiencia acreditable.

La cláusula de "desarrollo ilimitado sin costo" solo es sostenible en este modelo: lo que se desarrolla para un
municipio se amortiza entre todos.

---

## 10. Recomendación

**No ofertar esta licitación en solitario.** El impedimento no es de capacidad técnica — es que se pide un
producto terminado, con demo, y un despliegue en 30 días, contra un contrato de alcance de desarrollo abierto y
precio cerrado.

Pasos concretos, en orden:

1. **Bajar las Bases Administrativas y la ficha de mercadopublico.** Monto disponible, plazo, ponderaciones,
   garantías, experiencia exigida y multas. Sin eso ninguna decisión económica es real. *(Bloqueante.)*
2. **Averiguar quién es el incumbente** y desde cuándo. Define si esto es una licitación competitiva o un
   trámite de renovación.
3. Si aun así se quiere entrar: **buscar socio para UTP** y **presentar las 12 preguntas de §7** en el foro —
   varias de esas respuestas cambian el costo de la oferta de forma material.
4. En paralelo, y con independencia de esta licitación: **decidir si entramos al mercado de gestión documental
   municipal como línea de producto**. Si la respuesta es sí, esta especificación es el mejor punto de partida
   que vamos a conseguir, y conviene empezar ahora para llegar a las licitaciones de 2027.
