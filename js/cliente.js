/* ============================================================
   Cotizador para clientes · Curifor
   Cara pública: usa el mismo catálogo (data/indice.json y las
   pautas), pero solo muestra el precio oficial CON IVA y lo que
   incluye la mantención. Nunca costos, códigos ni stock.
   ============================================================ */
(() => {
  "use strict";

  // ---- configuración del taller (ajustar antes de publicar) ----
  const CONTACTO = {
    wsp: "56900000000",          // TODO: número real de WhatsApp, formato 56 9 XXXX XXXX sin signos
    saludo: "Hola, cotizé mi mantención en la web y quiero agendar.",
  };

  // servicios opcionales, iguales a los del cotizador interno (precios NETOS)
  const EXTRAS = [
    { id: "airlife",   nombre: "Airlife",   detalle: "Higienización del sistema de climatización", precio: 16000 },
    { id: "nitrosafe", nombre: "NitroSafe", detalle: "Inflado de neumáticos con nitrógeno",        precio: 18000 },
  ];

  const IVA = 0.19;
  const conIva = (n) => (n == null ? null : Math.round(n * (1 + IVA)));
  const CLP = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const money = (n) => (n == null ? "—" : CLP.format(Math.round(n)));
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
    listaVersiones: $("#listaVersiones"), gridAnios: $("#gridAnios"),
    ecoMarca: $("#ecoMarca"), ecoModelo: $("#ecoModelo"),
    chipAuto: $("#chipAuto"), gridKm: $("#gridKm"),
    pcAuto: $("#pcAuto"), pcRev: $("#pcRev"), pcValor: $("#pcValor"),
    pcExtrasResumen: $("#pcExtrasResumen"), pcTotalBox: $("#pcTotalBox"), pcTotal: $("#pcTotal"),
    listaCambios: $("#listaCambios"), listaRevisiones: $("#listaRevisiones"),
    opsCambios: $("#opsCambios"), opsRevisiones: $("#opsRevisiones"), opsVacio: $("#opsVacio"),
    btnVerRevs: $("#btnVerRevs"),
    gridExtras: $("#gridExtras"), cardExtras: $("#cardExtras"), tbodyPlan: $("#tbodyPlan"),
    btnWsp: $("#btnWsp"), navWsp: $("#navWsp"), btnPdf: $("#btnPdf"),
    btnCambiarAuto: $("#btnCambiarAuto"), btnCambiarKm: $("#btnCambiarKm"),
    pieFecha: $("#pieFecha"),
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
    el.pieFecha.textContent = "Precios actualizados al " + (state.indice.actualizado || "");
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
  }

  // ============================================================
  //  Paso 1 — el auto
  // ============================================================
  function pintarMarcas() {
    const marcas = [...state.indice.marcas].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    el.gridMarcas.innerHTML = marcas.map((m) => {
      const n = m.modelos.length;
      return `<button type="button" class="marca" data-marca="${m.id}">
          <span class="marca__nombre">${m.nombre}</span>
          <span class="marca__n">${n} ${n === 1 ? "modelo" : "modelos"}</span>
        </button>`;
    }).join("");
    el.gridMarcas.querySelectorAll(".marca").forEach((b) =>
      b.addEventListener("click", () => elegirMarca(b.dataset.marca)));
  }

  function elegirMarca(id) {
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
    el.ecoModelo.textContent = state.modelo ? "· " + state.modelo.nombre : "";
    el.subAnio.hidden = true;

    const vs = state.modelo.versiones || [];
    el.listaVersiones.innerHTML = vs.map((v, i) => {
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
      b.addEventListener("click", () => elegirVersion(vs[+b.dataset.v])));
    el.subVersion.hidden = false;

    if (vs.length === 1) { elegirVersion(vs[0]); return; }   // una sola versión: se salta el paso
    scrollA(el.subVersion);
  }

  async function elegirVersion(v) {
    state.version = v;
    state.anio = null;
    await cargarPauta(v.id);
    if (!state.pauta) return;

    const anios = state.pauta.anios || [];
    if (anios.length > 1) {
      el.gridAnios.innerHTML = anios.map((a) =>
        `<button type="button" class="chip-op" data-anio="${a}">${a}</button>`).join("");
      el.gridAnios.querySelectorAll(".chip-op").forEach((b) =>
        b.addEventListener("click", () => { state.anio = b.dataset.anio; abrirKilometrajes(); }));
      el.subAnio.hidden = false;
      scrollA(el.subAnio);
      return;
    }
    if (anios.length === 1) state.anio = anios[0];
    abrirKilometrajes();
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
    if (donde === "marca") { el.subModelo.hidden = true; el.subVersion.hidden = true; el.subAnio.hidden = true; scrollA(el.p1); }
    if (donde === "modelo") { el.subVersion.hidden = true; el.subAnio.hidden = true; scrollA(el.subModelo); }
    if (donde === "version") { el.subAnio.hidden = true; scrollA(el.subVersion); }
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
      const valor = itv.gratis ? "Sin costo"
        : (itv.totalConIva ? money(itv.totalConIva) : "Consultar");
      return `<button type="button" class="km${gratis ? " km--gratis" : ""}" data-i="${i}">
          <span class="km__km">${titulo}</span>
          <span class="km__meses">Mantención ${itv.n}${itv.meses ? " · " + itv.meses + " meses" : ""}</span>
          <span class="km__valor">${valor}${itv.gratis || !itv.totalConIva ? "" : "<small>IVA incluido</small>"}</span>
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
    el.pcValor.textContent = itv.gratis ? "Sin costo" : (itv.totalConIva ? money(itv.totalConIva) : "A confirmar");

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
    recalcular();
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
            <span class="extra-c__precio">${money(conIva(x.precio))}</span>
            <span class="extra-c__cta">${on ? "Agregado ✓" : "+ Agregar"}</span>
          </span>
        </button>`;
    }).join("");
    el.gridExtras.querySelectorAll(".extra-c").forEach((b) => b.addEventListener("click", () => {
      const id = b.dataset.x;
      if (state.extras.has(id)) state.extras.delete(id); else state.extras.add(id);
      pintarExtras();
      recalcular();
    }));
  }

  function recalcular() {
    const itv = state.itv;
    const base = itv.gratis ? 0 : (itv.totalConIva || 0);
    const sel = elegidos();
    const extraIva = sel.reduce((t, x) => t + conIva(x.precio), 0);

    el.pcExtrasResumen.hidden = !sel.length;
    el.pcExtrasResumen.innerHTML = sel.map((x) =>
      `<div><span>+ ${x.nombre}</span><span>${money(conIva(x.precio))}</span></div>`).join("");
    el.pcTotalBox.hidden = !sel.length;
    el.pcTotal.textContent = money(base + extraIva);
    // marca para la impresión: sin adicionales elegidos, esa tarjeta no se imprime
    el.cardExtras.toggleAttribute("data-sel", sel.length > 0);

    el.btnWsp.href = linkWsp(mensajeWsp(base + extraIva, sel));
  }

  function pintarPlan() {
    el.tbodyPlan.innerHTML = state.plan.map((itv) => {
      const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
      const cada = itv.meses ? `${itv.meses} meses` : "—";
      const valor = itv.gratis ? '<span class="gratis">Sin costo</span>'
        : (itv.totalConIva ? money(itv.totalConIva) : "Consultar");
      const sel = itv === state.itv ? ' class="is-sel"' : "";
      return `<tr${sel}><td>${km}</td><td>${cada}</td><td class="ta-r">${valor}</td></tr>`;
    }).join("");
  }

  // ============================================================
  //  WhatsApp
  // ============================================================
  function linkWsp(texto) {
    return `https://wa.me/${CONTACTO.wsp}?text=${encodeURIComponent(texto)}`;
  }

  function mensajeWsp(total, sel) {
    const p = state.pauta, itv = state.itv;
    if (!p || !itv) return CONTACTO.saludo;
    const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
    const l = [
      "Hola, quiero agendar la mantención que cotizé en la web:",
      `• Auto: ${p.marcaNombre} ${p.modelo} ${p.version}${state.anio ? " (" + state.anio + ")" : ""}`,
      `• Mantención: ${km}`,
    ];
    if (sel.length) l.push(`• Adicionales: ${sel.map((x) => x.nombre).join(", ")}`);
    l.push(`• Valor cotizado: ${itv.gratis && !sel.length ? "sin costo" : money(total)} (IVA incluido)`);
    l.push("¿Qué días tienen hora disponible?");
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
