/* ============================================================
   Cotizador para clientes · Curifor
   Cara pública: usa el mismo catálogo (data/indice.json y las
   pautas) y muestra QUÉ incluye cada mantención, no el precio.
   El valor lo entrega el asesor por WhatsApp. Nunca se muestran
   precios, costos, códigos ni stock.
   ============================================================ */
(() => {
  "use strict";

  // ---- configuración del taller (ajustar antes de publicar) ----
  const CONTACTO = {
    wsp: "56956887752",          // +56 9 5688 7752, formato wa.me sin signos
    saludo: "Hola, quiero cotizar la mantención de mi auto.",
  };

  // agenda web (Supabase): credenciales en js/agenda-config.js. Sin ellas el
  // botón "Agendar hora en el taller" no se muestra y todo sigue igual.
  const AGENDA = window.CURIFOR_AGENDA || {};
  // mismos bloques de hora que maneja taller.html
  const HORAS_AM = ["08:40", "09:00", "09:20", "09:40", "10:00", "10:20", "10:40", "11:00", "11:20", "11:40", "12:00", "12:20", "12:40"];
  const HORAS_PM = ["14:00", "14:20", "14:40", "15:00", "15:20", "15:40", "16:00", "16:20", "16:40", "17:00"];

  // servicios opcionales, iguales a los del cotizador interno. El `precio` NO se
  // muestra: solo sirve para saber si un adicional de pauta aplica a este km.
  const EXTRAS = [
    { id: "airlife",   nombre: "Airlife",   detalle: "Higienización del sistema de climatización", precio: 16000 },
    { id: "nitrosafe", nombre: "NitroSafe", detalle: "Inflado de neumáticos con nitrógeno",        precio: 18000 },
  ];

  const $ = (s) => document.querySelector(s);

  const state = {
    indice: null,
    marca: null, modelo: null, version: null, anio: null,
    pauta: null, plan: [], itv: null,
    extras: new Set(),      // ids de EXTRAS
    adics: new Set(),       // nombres de adicionales de la pauta
  };

  const el = {
    pasos: $("#pasos"), p1: $("#p1"), p2: $("#p2"), p3: $("#p3"), errorBox: $("#errorBox"),
    subMarca: $("#subMarca"), subModelo: $("#subModelo"), subVersion: $("#subVersion"), subAnio: $("#subAnio"),
    gridMarcas: $("#gridMarcas"), gridModelos: $("#gridModelos"), buscaModelo: $("#buscaModelo"),
    listaVersiones: $("#listaVersiones"), gridAnios: $("#gridAnios"), volverVersion: $("#volverVersion"),
    ecoMarca: $("#ecoMarca"), ecoModelo: $("#ecoModelo"), ecoModeloAnio: $("#ecoModeloAnio"),
    chipAuto: $("#chipAuto"), gridKm: $("#gridKm"),
    pcAuto: $("#pcAuto"), pcRev: $("#pcRev"),
    listaCambios: $("#listaCambios"), listaRevisiones: $("#listaRevisiones"),
    opsCambios: $("#opsCambios"), opsRevisiones: $("#opsRevisiones"), opsVacio: $("#opsVacio"),
    btnVerRevs: $("#btnVerRevs"),
    gridExtras: $("#gridExtras"), cardExtras: $("#cardExtras"), tbodyPlan: $("#tbodyPlan"),
    btnWsp: $("#btnWsp"), navWsp: $("#navWsp"), btnPdf: $("#btnPdf"),
    btnCambiarAuto: $("#btnCambiarAuto"), btnCambiarKm: $("#btnCambiarKm"),
    pieFecha: $("#pieFecha"),
    btnAgendar: $("#btnAgendar"), agwOv: $("#agwOv"), agwCerrar: $("#agwCerrar"),
    agwAuto: $("#agwAuto"), agwForm: $("#agwForm"), agwNombre: $("#agwNombre"),
    agwFono: $("#agwFono"), agwEmail: $("#agwEmail"), agwPatente: $("#agwPatente"),
    agwFecha: $("#agwFecha"), agwHora: $("#agwHora"), agwComent: $("#agwComent"),
    agwWeb: $("#agwWeb"), agwErr: $("#agwErr"), agwEnviar: $("#agwEnviar"),
    agwOk: $("#agwOk"), agwOkDetalle: $("#agwOkDetalle"), agwOkWsp: $("#agwOkWsp"),
  };

  // ============================================================
  //  Arranque
  // ============================================================
  async function init() {
    try {
      const r = await fetch("data/indice.json");
      if (!r.ok) throw new Error("indice");
      state.indice = await r.json();
    } catch (e) {
      el.errorBox.hidden = false;
      return;
    }
    el.pieFecha.textContent = "Información actualizada al " + (state.indice.actualizado || "");
    pintarMarcas();
    el.navWsp.href = linkWsp(CONTACTO.saludo);

    el.buscaModelo.addEventListener("input", () => pintarModelos(el.buscaModelo.value));
    document.querySelectorAll("[data-volver]").forEach((b) =>
      b.addEventListener("click", () => volverA(b.dataset.volver)));
    el.btnCambiarAuto.addEventListener("click", () => irAPaso(1));
    el.btnCambiarKm.addEventListener("click", () => irAPaso(2));
    el.btnPdf.addEventListener("click", () => window.print());
    el.btnVerRevs.addEventListener("click", () => {
      el.listaRevisiones.classList.remove("is-corta");
      el.btnVerRevs.hidden = true;
    });

    if (AGENDA.url && AGENDA.anonKey) {
      el.btnAgendar.hidden = false;
      el.btnAgendar.addEventListener("click", abrirAgenda);
      el.agwCerrar.addEventListener("click", cerrarAgenda);
      el.agwOv.addEventListener("click", (e) => { if (e.target === el.agwOv) cerrarAgenda(); });
      el.agwForm.addEventListener("submit", enviarReserva);
    }
  }

  /* ---- marcas con agenda propia ----
     Ford no se agenda en Curifor: tiene su propio sistema y ahi es donde la
     hora queda tomada de verdad. Pedirle la hora al cliente aca y despues
     tener que re-agendarla alla es prometerle algo que no se cumple.

     El aviso va en la tarjeta ANTES del clic. Un salto silencioso a un sitio
     de otra empresa, con pantalla de login incluida, se lee como un error de
     la pagina. */
  var AGENDA_EXTERNA = {
    ford: {
      nombre: "Ford",
      url: "https://web.agenda.ford.com/#/login",
      nota: "Agenda en el sitio de Ford"
    }
  };

  // ============================================================
  //  Paso 1 — el auto
  // ============================================================
  function pintarMarcas() {
    const marcas = [...state.indice.marcas].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    el.gridMarcas.innerHTML = marcas.map((m) => {
      const n = m.modelos.length;
      const ext = AGENDA_EXTERNA[m.id];
      return `<button type="button" class="marca${ext ? " marca--externa" : ""}" data-marca="${m.id}">
          <span class="marca__nombre">${m.nombre}</span>
          <span class="marca__n">${ext ? ext.nota + " &#8599;" : `${n} ${n === 1 ? "modelo" : "modelos"}`}</span>
        </button>`;
    }).join("");
    el.gridMarcas.querySelectorAll(".marca").forEach((b) =>
      b.addEventListener("click", () => elegirMarca(b.dataset.marca)));
  }

  function elegirMarca(id) {
    /* Antes de cualquier otra cosa: si la marca se agenda afuera, se va para
       alla. Va en la misma pestaña porque el cliente esta yendo a AGENDAR, no
       a consultar algo de paso; dejarlo con dos pestañas abiertas que hacen lo
       mismo es como se termina con la hora pedida dos veces. */
    const ext = AGENDA_EXTERNA[id];
    if (ext) { location.href = ext.url; return; }

    state.marca = state.indice.marcas.find((m) => m.id === id) || null;
    state.modelo = state.version = state.pauta = state.anio = null;
    el.gridMarcas.querySelectorAll(".marca").forEach((b) =>
      b.classList.toggle("is-on", b.dataset.marca === id));
    el.ecoMarca.textContent = state.marca ? "· " + state.marca.nombre : "";
    el.buscaModelo.value = "";
    pintarModelos("");
    el.subModelo.hidden = false;
    el.subVersion.hidden = true;
    el.subAnio.hidden = true;
    scrollA(el.subModelo);
  }

  function modelosOrdenados() {
    return [...state.marca.modelos].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
  }

  function pintarModelos(filtro) {
    const f = (filtro || "").trim().toLowerCase();
    const lista = modelosOrdenados().filter((m) => !f || m.nombre.toLowerCase().includes(f));
    if (!lista.length) {
      el.gridModelos.innerHTML = `<p class="vacio">No encontramos ese modelo en ${state.marca.nombre}. Prueba con otro nombre.</p>`;
      return;
    }
    el.gridModelos.innerHTML = lista.map((m) =>
      `<button type="button" class="chip-op" data-modelo="${escapar(m.nombre)}">${m.nombre}</button>`).join("");
    el.gridModelos.querySelectorAll(".chip-op").forEach((b) =>
      b.addEventListener("click", () => elegirModelo(b.dataset.modelo)));
  }

  function elegirModelo(nombre) {
    state.modelo = state.marca.modelos.find((m) => m.nombre === nombre) || null;
    state.version = state.pauta = state.anio = null;
    el.gridModelos.querySelectorAll(".chip-op").forEach((b) =>
      b.classList.toggle("is-on", b.dataset.modelo === nombre));
    const nom = state.modelo ? "· " + state.modelo.nombre : "";
    el.ecoModelo.textContent = nom;
    el.ecoModeloAnio.textContent = nom;

    // Solo Ford maneja año, y el año FILTRA las versiones (una versión puede
    // existir solo en ciertos años). Por eso, cuando el modelo tiene años, se
    // pregunta el año ANTES que la versión.
    const anios = aniosDeModelo(state.modelo);
    if (anios.length) {
      el.gridAnios.innerHTML = anios.map((a) =>
        `<button type="button" class="chip-op" data-anio="${a}">${a}</button>`).join("");
      el.gridAnios.querySelectorAll(".chip-op").forEach((b) =>
        b.addEventListener("click", () => elegirAnio(b.dataset.anio)));
      el.subVersion.hidden = true;
      el.subAnio.hidden = false;
      scrollA(el.subAnio);
      return;
    }
    // marcas sin año: directo a versión (todas las versiones del modelo)
    el.subAnio.hidden = true;
    pintarVersiones(state.modelo.versiones || [], "modelo");
  }

  function elegirAnio(anio) {
    state.anio = anio;
    state.version = state.pauta = null;
    el.gridAnios.querySelectorAll(".chip-op").forEach((b) =>
      b.classList.toggle("is-on", b.dataset.anio === anio));
    pintarVersiones(versionesDeAnio(state.modelo, anio), "anio");
  }

  // pinta la lista de versiones (ya filtrada por año si aplica) y ajusta a dónde
  // vuelve el botón "cambiar" según de dónde venimos (del año o del modelo)
  function pintarVersiones(lista, volverDest) {
    el.volverVersion.dataset.volver = volverDest;
    el.volverVersion.textContent = volverDest === "anio" ? "Cambiar año" : "Cambiar modelo";
    el.listaVersiones.innerHTML = lista.map((v, i) => {
      const meta = [v.segmento, v.vigencia && v.vigencia !== "Activo" ? v.vigencia : null]
        .filter(Boolean).join(" · ");
      return `<button type="button" class="version" data-v="${i}">
          <span class="version__info">
            <span class="version__nombre">${v.nombre}</span>
            ${meta ? `<span class="version__meta">${meta}</span>` : ""}
          </span>
          <span class="version__flecha" aria-hidden="true">›</span>
        </button>`;
    }).join("");
    el.listaVersiones.querySelectorAll(".version").forEach((b) =>
      b.addEventListener("click", () => elegirVersion(lista[+b.dataset.v])));
    el.subVersion.hidden = false;

    if (lista.length === 1) { elegirVersion(lista[0]); return; }   // una sola: se salta
    scrollA(el.subVersion);
  }

  async function elegirVersion(v) {
    state.version = v;
    await cargarPauta(v.id);
    if (!state.pauta) return;
    // state.anio ya viene del paso de año (o queda null si el modelo no usa año);
    // abrirKilometrajes elige el plan del año y hace fallback al primero si no calza
    abrirKilometrajes();
  }

  // años de un modelo = unión de los años de todas sus versiones (desc)
  function aniosDeModelo(modelo) {
    const set = new Set();
    (modelo && modelo.versiones || []).forEach((v) => (v.anios || []).forEach((a) => set.add(String(a))));
    return [...set].sort((a, b) => b.localeCompare(a, "es", { numeric: true }));
  }
  // versiones de un modelo que aplican a un año (las sin años se dejan pasar)
  function versionesDeAnio(modelo, anio) {
    return (modelo.versiones || []).filter((v) => !v.anios || !v.anios.length || v.anios.indexOf(String(anio)) >= 0);
  }

  async function cargarPauta(id) {
    try {
      const r = await fetch(`data/pautas/${id}.json`);
      if (!r.ok) throw new Error("pauta");
      state.pauta = await r.json();
      el.errorBox.hidden = true;
    } catch (e) {
      state.pauta = null;
      el.errorBox.hidden = false;
    }
  }

  function volverA(donde) {
    if (donde === "marca") { el.subModelo.hidden = true; el.subAnio.hidden = true; el.subVersion.hidden = true; scrollA(el.p1); }
    if (donde === "modelo") { el.subAnio.hidden = true; el.subVersion.hidden = true; scrollA(el.subModelo); }
    if (donde === "anio") { el.subVersion.hidden = true; scrollA(el.subAnio); }
  }

  // ============================================================
  //  Paso 2 — kilometraje
  // ============================================================
  function abrirKilometrajes() {
    const p = state.pauta;
    let plan = (p.planes || [])[0];
    if (state.anio) plan = (p.planes || []).find((pl) => String(pl.anio) === String(state.anio)) || plan;
    state.plan = (plan && plan.intervalos) ? plan.intervalos : [];

    el.chipAuto.innerHTML = `🚗 ${p.marcaNombre} ${p.modelo} · ${p.version}` +
      (state.anio ? ` · ${state.anio}` : "") + (p.motor ? ` · ${p.motor}` : "");

    el.gridKm.innerHTML = state.plan.map((itv, i) => {
      const titulo = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
      const gratis = itv.gratis || !itv.totalConIva;
      return `<button type="button" class="km${gratis ? " km--gratis" : ""}" data-i="${i}">
          <span class="km__km">${titulo}</span>
          <span class="km__meses">Mantención ${itv.n}${itv.meses ? " · " + itv.meses + " meses" : ""}</span>
          ${itv.gratis ? '<span class="km__valor">Sin costo</span>' : ""}
          <span class="km__ver">Ver detalle →</span>
        </button>`;
    }).join("");
    el.gridKm.querySelectorAll(".km").forEach((b) =>
      b.addEventListener("click", () => elegirKm(+b.dataset.i)));

    irAPaso(2);
  }

  // ============================================================
  //  Paso 3 — la cotización
  // ============================================================
  function elegirKm(i) {
    state.itv = state.plan[i];
    state.extras.clear();
    state.adics.clear();
    pintarCotizacion();
    irAPaso(3);
  }

  function pintarCotizacion() {
    const p = state.pauta, itv = state.itv;
    const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");

    el.pcAuto.textContent = `${p.marcaNombre} ${p.modelo}${state.anio ? " · " + state.anio : ""}`;
    el.pcRev.textContent = `Mantención de ${km}`;

    // operaciones: R = lo que se cambia, I = lo que se revisa.
    // No todas las pautas traen operaciones detalladas; cuando faltan, lo que se
    // cambia se deduce de los repuestos y lubricantes de la mantención (solo el
    // nombre: nunca códigos ni valores unitarios).
    const ops = itv.operaciones || [];
    let cambios = ops.filter((o) => o.accion === "R").map((o) => o.nombre);
    const revs = ops.filter((o) => o.accion !== "R").map((o) => o.nombre);
    if (!cambios.length) {
      cambios = (itv.items || [])
        .filter((it) => (it.tipo || "repuesto") !== "material")
        .map((it) => it.nombre);
    }
    const lCambios = limpiarLista(cambios), lRevs = limpiarLista(revs);
    el.listaCambios.innerHTML = lCambios.map((n) => `<li>${n}</li>`).join("");
    el.listaRevisiones.innerHTML = lRevs.map((n) => `<li>${n}</li>`).join("");
    el.opsCambios.hidden = !lCambios.length;
    el.opsRevisiones.hidden = !lRevs.length;
    el.opsVacio.hidden = !!(lCambios.length || lRevs.length);
    colapsarRevisiones(lRevs.length);

    pintarExtras();
    pintarPlan();
    actualizarSeleccion();
  }

  // hay pautas con 30+ revisiones: en pantalla se muestran 10 y el resto queda
  // tras un botón (al imprimir salen todas)
  const TOPE_REVS = 10;
  function colapsarRevisiones(total) {
    const abrir = total > TOPE_REVS;
    el.listaRevisiones.classList.toggle("is-corta", abrir);
    el.btnVerRevs.hidden = !abrir;
    if (abrir) el.btnVerRevs.textContent = `Ver las ${total} revisiones`;
  }

  // extras fijos + adicionales que traiga la pauta para ese kilometraje
  function extrasDisponibles() {
    const lista = EXTRAS.map((x) => ({ id: x.id, nombre: x.nombre, detalle: x.detalle, precio: x.precio, fijo: true }));
    const itv = state.itv;
    (state.pauta.adicionales || []).forEach((a) => {
      let precio = a.precio;
      if (a.porKm && itv.km != null && a.porKm[String(itv.km)] != null) precio = a.porKm[String(itv.km)];
      const aplica = !a.porKm || !Object.keys(a.porKm).length || (itv.km != null && a.porKm[String(itv.km)] != null);
      if (aplica && precio) lista.push({ id: "ad::" + a.nombre, nombre: a.nombre, detalle: "Recomendado para este kilometraje", precio, fijo: false });
    });
    return lista;
  }

  function elegidos() { return extrasDisponibles().filter((x) => state.extras.has(x.id)); }

  function pintarExtras() {
    const lista = extrasDisponibles();
    el.gridExtras.innerHTML = lista.map((x) => {
      const on = state.extras.has(x.id);
      return `<button type="button" class="extra-c${on ? " is-on" : ""}" data-x="${escapar(x.id)}" aria-pressed="${on}">
          <span class="extra-c__nombre">${x.nombre}</span>
          <span class="extra-c__detalle">${x.detalle}</span>
          <span class="extra-c__pie">
            <span class="extra-c__cta">${on ? "Agregado ✓" : "+ Agregar"}</span>
          </span>
        </button>`;
    }).join("");
    el.gridExtras.querySelectorAll(".extra-c").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.x;
      if (state.extras.has(id)) state.extras.delete(id); else state.extras.add(id);
      pintarExtras();
      actualizarSeleccion();
    }));
  }

  // sin precios que sumar: solo refresca el mensaje de WhatsApp con los
  // adicionales elegidos y marca la tarjeta para la impresión
  function actualizarSeleccion() {
    const sel = elegidos();
    el.cardExtras.toggleAttribute("data-sel", sel.length > 0);
    el.btnWsp.href = linkWsp(mensajeWsp(sel));
  }

  function pintarPlan() {
    el.tbodyPlan.innerHTML = state.plan.map((itv) => {
      const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
      const cada = itv.meses ? `${itv.meses} meses` : "—";
      const sel = itv === state.itv ? ' class="is-sel"' : "";
      return `<tr${sel}><td>${km}</td><td>${cada}</td></tr>`;
    }).join("");
  }

  // ============================================================
  //  Agendamiento web (Supabase)
  //  La reserva es una SOLICITUD de hora: queda guardada y el
  //  taller la confirma (la disponibilidad real vive allá).
  /* Aviso de datos personales. El texto viene de js/acta-condiciones.js, el
     mismo que el cliente firma después en el acta de recepción: si acá dijera
     una cosa y allá otra, la autorización no valdría en ninguno de los dos
     lados. Se pinta una sola vez; si el archivo no cargó, el bloque queda
     oculto en vez de mostrar un desplegable vacío. */
  function pintarAvisoDatos() {
    const caja = document.getElementById("agwDatosTexto");
    const det = document.getElementById("agwDatos");
    if (!caja || caja.dataset.listo) return;
    const C = window.ActaCondiciones;
    if (!C || !C.datos) { if (det) det.hidden = true; return; }
    caja.innerHTML = C.datos.map((t) => `<p>${t}</p>`).join("") +
      `<p class="agw-datos__ver">Texto vigente, versión ${C.version}.</p>`;
    caja.dataset.listo = "1";
  }

  // ============================================================
  function abrirAgenda() {
    const p = state.pauta, itv = state.itv;
    if (!p || !itv) return;
    const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
    el.agwAuto.textContent = `${p.marcaNombre} ${p.modelo} ${p.version}` +
      (state.anio ? ` (${state.anio})` : "") + ` · Mantención de ${km}`;

    // día: desde mañana hasta 45 días (domingo se valida al enviar)
    const man = new Date(); man.setDate(man.getDate() + 1);
    const max = new Date(); max.setDate(max.getDate() + 45);
    el.agwFecha.min = isoLocal(man);
    el.agwFecha.max = isoLocal(max);
    if (!el.agwFecha.value) el.agwFecha.value = "";

    if (!el.agwHora.options.length) {
      el.agwHora.innerHTML = '<option value="indiferente">La que tengan disponible</option>' +
        `<optgroup label="Mañana">${HORAS_AM.map((h) => `<option>${h}</option>`).join("")}</optgroup>` +
        `<optgroup label="Tarde">${HORAS_PM.map((h) => `<option>${h}</option>`).join("")}</optgroup>`;
    }
    pintarAvisoDatos();
    el.agwErr.hidden = true;
    el.agwForm.hidden = false;
    el.agwOk.hidden = true;
    el.agwEnviar.disabled = false;
    el.agwEnviar.textContent = "Solicitar la hora";
    el.agwOv.hidden = false;
  }

  function cerrarAgenda() { el.agwOv.hidden = true; }

  function errorAgenda(msg) {
    el.agwErr.textContent = msg;
    el.agwErr.hidden = false;
  }

  // acepta "9 1234 5678", "912345678" o "+56 9 1234 5678" → "+56 9 XXXX XXXX"
  function normalizarFono(v) {
    let d = String(v || "").replace(/\D/g, "");
    if (d.startsWith("56")) d = d.slice(2);
    if (d.length !== 9 || d[0] !== "9") return null;
    return `+56 9 ${d.slice(1, 5)} ${d.slice(5)}`;
  }

  async function enviarReserva(ev) {
    ev.preventDefault();
    if (el.agwWeb.value) return;   // honeypot: lo llenan solo los bots

    const nombre = el.agwNombre.value.trim();
    if (nombre.length < 3) return errorAgenda("Escribe tu nombre y apellido.");
    const fono = normalizarFono(el.agwFono.value);
    if (!fono) return errorAgenda("Revisa el celular: debe ser un móvil chileno de 9 dígitos (9 XXXX XXXX).");
    const email = el.agwEmail.value.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return errorAgenda("Revisa el e-mail.");
    const fecha = el.agwFecha.value;
    if (!fecha) return errorAgenda("Elige el día en que quieres traer tu auto.");
    if (fecha < el.agwFecha.min || fecha > el.agwFecha.max)
      return errorAgenda("Elige un día entre mañana y los próximos 45 días.");
    if (new Date(fecha + "T00:00:00").getDay() === 0)
      return errorAgenda("Los domingos el taller no atiende. Elige otro día.");

    const p = state.pauta, itv = state.itv;
    const reserva = {
      nombre, fono,
      email: email || null,
      patente: el.agwPatente.value.trim().toUpperCase() || null,
      fecha,
      hora: el.agwHora.value || "indiferente",
      comentario: el.agwComent.value.trim() || null,
      marca: p.marcaNombre, modelo: p.modelo, version: p.version,
      anio: state.anio || null,
      pauta_id: state.version ? state.version.id : null,
      rev_n: itv.n != null ? String(itv.n) : null,
      km: itv.km || null,
      extras: elegidos().map((x) => x.nombre).join(", ") || null,
      origen: "cliente_web",   // flujo: el cliente pidió la hora desde la web pública
    };

    el.agwEnviar.disabled = true;
    el.agwEnviar.textContent = "Enviando…";
    let ok = false;
    try {
      const r = await fetch(`${AGENDA.url}/rest/v1/${AGENDA.tabla || "reservas_web"}`, {
        method: "POST",
        headers: {
          apikey: AGENDA.anonKey,
          Authorization: "Bearer " + AGENDA.anonKey,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(reserva),
      });
      ok = r.ok;
    } catch (e) { ok = false; }

    if (!ok) {
      el.agwEnviar.disabled = false;
      el.agwEnviar.textContent = "Solicitar la hora";
      return errorAgenda("No pudimos enviar tu solicitud. Inténtalo de nuevo o escríbenos por WhatsApp.");
    }

    const dia = new Date(fecha + "T00:00:00").toLocaleDateString("es-CL",
      { weekday: "long", day: "numeric", month: "long" });
    el.agwOkDetalle.textContent = `Pediste hora para el ${dia}` +
      (reserva.hora !== "indiferente" ? ` a las ${reserva.hora}` : "") +
      `. Te contactaremos al ${fono} para confirmarla.`;
    el.agwOkWsp.href = linkWsp(`Hola, acabo de agendar hora por la web para mi ${p.marcaNombre} ${p.modelo} (${dia}). Quería consultar algo:`);
    el.agwForm.hidden = true;
    el.agwOk.hidden = false;
  }

  function isoLocal(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
      "-" + String(d.getDate()).padStart(2, "0");
  }

  // ============================================================
  //  WhatsApp
  // ============================================================
  function linkWsp(texto) {
    return `https://wa.me/${CONTACTO.wsp}?text=${encodeURIComponent(texto)}`;
  }

  function mensajeWsp(sel) {
    const p = state.pauta, itv = state.itv;
    if (!p || !itv) return CONTACTO.saludo;
    const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
    const l = [
      "Hola, quiero cotizar esta mantención:",
      `• Auto: ${p.marcaNombre} ${p.modelo} ${p.version}${state.anio ? " (" + state.anio + ")" : ""}`,
      `• Mantención: ${km}`,
    ];
    if (sel.length) l.push(`• Me interesan además: ${sel.map((x) => x.nombre).join(", ")}`);
    l.push("¿Me pueden enviar el valor y las horas disponibles?");
    return l.join("\n");
  }

  // ============================================================
  //  Utilidades
  // ============================================================
  function irAPaso(n) {
    el.p1.hidden = n !== 1;
    el.p2.hidden = n !== 2;
    el.p3.hidden = n !== 3;
    el.pasos.querySelectorAll(".paso").forEach((li) => {
      const p = +li.dataset.p;
      li.classList.toggle("is-active", p === n);
      li.classList.toggle("is-done", p < n);
    });
    scrollA(el.pasos);
  }

  function scrollA(nodo) {
    if (!nodo) return;
    const y = nodo.getBoundingClientRect().top + window.scrollY - 80;
    window.scrollTo({ top: Math.max(0, y), behavior: "smooth" });
  }

  function etiquetaKm(km) {
    if (km >= 1000) return (km / 1000).toLocaleString("es-CL") + ".000 km";
    return km.toLocaleString("es-CL") + " km";
  }

  // Las pautas vienen del Excel del fabricante: mayúsculas, remisiones a las
  // notas de la hoja ("(VER NOTA 2)") y anotaciones de taller ("(COSTO CLIENTE)",
  // "(SUGERIDA A INSPECCIÓN (I)"). Nada de eso le sirve al cliente y "costo
  // cliente" dentro de lo que sí está incluido se lee como un cobro extra.
  const RUIDO = [
    /\s*\((?:ver\s+)?nota[s]?[^)]*\)?/gi,
    /\s*\(\s*sugerida[^)]*\)?/gi,
    /\s*\(\s*costo\s+cliente\s*\)?/gi,
    /\s*\(\s*[ir]\s*\)/gi,
  ];
  function bonito(txt) {
    if (!txt) return "";
    let t = String(txt);
    RUIDO.forEach((re) => { t = t.replace(re, ""); });
    t = t.replace(/\s{2,}/g, " ").replace(/[\s,;.]+$/, "").trim().toLowerCase();
    return escapar(t.charAt(0).toUpperCase() + t.slice(1));
  }

  // la misma revisión aparece repetida en varias pautas ("funcionamiento de
  // luces…" dos veces): al cliente se le muestra una sola vez
  function limpiarLista(nombres) {
    const vistos = new Set(), out = [];
    nombres.map(bonito).forEach((n) => {
      const k = n.toLowerCase();
      if (!n || vistos.has(k)) return;
      vistos.add(k);
      out.push(n);
    });
    return out;
  }

  const escapar = (s) => String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  document.addEventListener("DOMContentLoaded", init);
})();
