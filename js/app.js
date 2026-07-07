/* ============================================================
   Cotizador de Mantenciones Curifor — lógica de la SPA
   Sin dependencias. Datos servidos como JSON estático.
   ============================================================ */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const CLP = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const money = (n) => (n == null ? "—" : CLP.format(Math.round(n)));

  // ---- estado ----
  const state = {
    indice: null,
    marca: null,     // objeto marca del índice
    modelo: null,    // objeto modelo
    version: null,   // {id, nombre, ...}
    pauta: null,     // JSON detalle de la versión
    anio: null,      // año seleccionado (Ford)
    plan: null,      // intervalos del año/plan activo
    activo: 0,       // índice de revisión activa
    adicionales: new Set(),
  };

  // ---- referencias DOM ----
  const el = {
    paso1: $("#paso1"), paso2: $("#paso2"),
    selMarca: $("#selMarca"), selModelo: $("#selModelo"),
    selVersion: $("#selVersion"), selAnio: $("#selAnio"), fieldAnio: $("#fieldAnio"),
    btnCotizar: $("#btnCotizar"), btnVolver: $("#btnVolver"), btnReiniciar: $("#btnReiniciar"),
    vehiculoMeta: $("#vehiculoMeta"),
    rvMarca: $("#rvMarca"), rvTitulo: $("#rvTitulo"), rvSub: $("#rvSub"),
    rvAnioBox: $("#rvAnioBox"), selAnio2: $("#selAnio2"),
    track: $("#carruselTrack"), navPrev: $("#navPrev"), navNext: $("#navNext"),
    detTitulo: $("#detTitulo"), detSub: $("#detSub"), detPrecio: $("#detPrecio"),
    detOperaciones: $("#detOperaciones"), detDesglose: $("#detDesglose"),
    adicionalesBox: $("#adicionalesBox"), detAdicionales: $("#detAdicionales"),
    totalConAdicionales: $("#totalConAdicionales"),
    packsBox: $("#packsBox"), packsList: $("#packsList"),
    detNotas: $("#detNotas"), detFuente: $("#detFuente"),
    errorBox: $("#errorBox"), footFecha: $("#footFecha"), stepbar: document.querySelectorAll(".stepbar__item"),
  };

  // ============================================================
  //  Carga inicial
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
    el.footFecha.textContent = "Datos: " + state.indice.actualizado;
    llenarMarcas();
    enlazarEventos();
  }

  function llenarMarcas() {
    const marcas = [...state.indice.marcas].sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    el.selMarca.innerHTML = '<option value="">Elige la marca</option>' +
      marcas.map((m) => `<option value="${m.id}">${m.nombre}</option>`).join("");
  }

  function enlazarEventos() {
    el.selMarca.addEventListener("change", onMarca);
    el.selModelo.addEventListener("change", onModelo);
    el.selVersion.addEventListener("change", onVersion);
    el.selAnio.addEventListener("change", onAnioSelector);
    el.btnCotizar.addEventListener("click", cotizar);
    el.btnVolver.addEventListener("click", volver);
    el.btnReiniciar.addEventListener("click", (e) => { e.preventDefault(); reiniciar(); });
    el.selAnio2.addEventListener("change", (e) => { state.anio = e.target.value; cargarPlan(); });
    el.navPrev.addEventListener("click", () => moverActivo(-1));
    el.navNext.addEventListener("click", () => moverActivo(1));
  }

  // ============================================================
  //  Paso 1 — selección encadenada
  // ============================================================
  function reset(sel, placeholder) {
    sel.innerHTML = `<option value="">${placeholder}</option>`;
    sel.disabled = true;
  }

  function onMarca() {
    state.marca = state.indice.marcas.find((m) => m.id === el.selMarca.value) || null;
    state.modelo = state.version = null;
    reset(el.selVersion, "Elige la versión");
    el.fieldAnio.hidden = true; reset(el.selAnio, "Elige el año");
    el.vehiculoMeta.hidden = true;
    if (!state.marca) { reset(el.selModelo, "Elige el modelo"); actualizarBoton(); return; }
    const modelos = [...state.marca.modelos].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
    el.selModelo.innerHTML = '<option value="">Elige el modelo</option>' +
      modelos.map((m, i) => `<option value="${i}">${m.nombre}</option>`).join("");
    el.selModelo.disabled = false;
    actualizarBoton();
  }

  function onModelo() {
    const modelos = [...state.marca.modelos].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
    state.modelo = modelos[el.selModelo.value] || null;
    state.version = null;
    el.fieldAnio.hidden = true; reset(el.selAnio, "Elige el año");
    el.vehiculoMeta.hidden = true;
    if (!state.modelo) { reset(el.selVersion, "Elige la versión"); actualizarBoton(); return; }
    const vs = state.modelo.versiones;
    el.selVersion.innerHTML = '<option value="">Elige la versión</option>' +
      vs.map((v, i) => `<option value="${i}">${v.nombre}</option>`).join("");
    el.selVersion.disabled = false;
    actualizarBoton();
  }

  async function onVersion() {
    state.version = state.modelo.versiones[el.selVersion.value] || null;
    el.fieldAnio.hidden = true; reset(el.selAnio, "Elige el año");
    el.vehiculoMeta.hidden = true;
    if (!state.version) { state.pauta = null; actualizarBoton(); return; }
    // cargar detalle para saber si hay años y metadata
    await cargarPauta(state.version.id);
    mostrarMeta();
    if (state.pauta && state.pauta.anios && state.pauta.anios.length) {
      el.fieldAnio.hidden = false;
      el.selAnio.innerHTML = '<option value="">Elige el año</option>' +
        state.pauta.anios.map((a) => `<option value="${a}">${a}</option>`).join("");
      el.selAnio.disabled = false;
      state.anio = null;
    } else {
      state.anio = null;
    }
    actualizarBoton();
  }

  function onAnioSelector() {
    state.anio = el.selAnio.value || null;
    actualizarBoton();
  }

  async function cargarPauta(id) {
    try {
      const r = await fetch(`data/pautas/${id}.json`);
      if (!r.ok) throw new Error("pauta");
      state.pauta = await r.json();
    } catch (e) {
      state.pauta = null;
      el.errorBox.hidden = false;
    }
  }

  function mostrarMeta() {
    const p = state.pauta;
    if (!p) { el.vehiculoMeta.hidden = true; return; }
    const chips = [];
    if (p.segmento) chips.push(`<span class="chip">${p.segmento}</span>`);
    if (p.categoria) chips.push(`<span class="chip">Uso ${p.categoria.toLowerCase()}</span>`);
    if (p.vigencia && p.vigencia !== "Activo") chips.push(`<span class="chip chip--warn">${p.vigencia}</span>`);
    else if (p.vigencia === "Activo") chips.push(`<span class="chip">Modelo vigente</span>`);
    if (p.tarifaMO) chips.push(`<span class="chip">Mano de obra ${money(p.tarifaMO)}/hora</span>`);
    el.vehiculoMeta.innerHTML = chips.join("");
    el.vehiculoMeta.hidden = chips.length === 0;
  }

  function actualizarBoton() {
    const listo = state.version && state.pauta &&
      (!(state.pauta.anios && state.pauta.anios.length) || state.anio);
    el.btnCotizar.disabled = !listo;
  }

  // ============================================================
  //  Paso 2 — resultados
  // ============================================================
  function cotizar() {
    if (el.btnCotizar.disabled) return;
    el.paso1.hidden = true;
    el.paso2.hidden = false;
    el.stepbar.forEach((s) => s.classList.toggle("is-active", true));
    pintarEncabezado();
    // año en resultados (Ford)
    if (state.pauta.anios && state.pauta.anios.length) {
      el.rvAnioBox.hidden = false;
      el.selAnio2.innerHTML = state.pauta.anios.map((a) => `<option value="${a}">${a}</option>`).join("");
      el.selAnio2.value = state.anio;
    } else {
      el.rvAnioBox.hidden = true;
    }
    cargarPlan();
    pintarPacks();
    pintarNotas();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function pintarEncabezado() {
    const p = state.pauta;
    el.rvMarca.textContent = p.marcaNombre;
    el.rvTitulo.textContent = `${p.modelo} · ${p.version}`;
    const partes = [];
    if (p.segmento) partes.push(p.segmento);
    if (p.vigencia && p.vigencia !== "Activo") partes.push(p.vigencia);
    if (p.motor) partes.push(p.motor);
    el.rvSub.textContent = partes.join(" · ");
  }

  function cargarPlan() {
    const p = state.pauta;
    let plan = p.planes[0];
    if (p.anios && p.anios.length) {
      plan = p.planes.find((pl) => String(pl.anio) === String(state.anio)) || p.planes[0];
    }
    state.plan = (plan && plan.intervalos) ? plan.intervalos : [];
    state.activo = 0;
    state.adicionales.clear();
    pintarCarrusel();
    pintarDetalle();
  }

  function pintarCarrusel() {
    el.track.innerHTML = state.plan.map((itv, i) => {
      const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
      const meses = itv.meses ? `${itv.meses} meses` : (itv.gratis ? "Primer servicio" : "");
      const precio = itv.gratis ? '<span class="rev-card__gratis">Sin costo</span>' : money(itv.totalConIva);
      return `<li class="rev-card${i === 0 ? " is-active" : ""}" data-i="${i}" role="button" tabindex="0">
        <div class="rev-card__n">Rev. ${itv.n}</div>
        <div class="rev-card__km">${km}</div>
        <div class="rev-card__meses">${meses}</div>
        <div class="rev-card__precio">${precio}</div>
      </li>`;
    }).join("");
    el.track.querySelectorAll(".rev-card").forEach((c) => {
      c.addEventListener("click", () => setActivo(+c.dataset.i));
      c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActivo(+c.dataset.i); } });
    });
    posicionarTrack();
  }

  function setActivo(i) {
    state.activo = i;
    state.adicionales.clear();
    el.track.querySelectorAll(".rev-card").forEach((c, j) => c.classList.toggle("is-active", j === i));
    posicionarTrack();
    pintarDetalle();
  }

  function moverActivo(d) {
    const n = state.plan.length;
    const i = Math.min(n - 1, Math.max(0, state.activo + d));
    if (i !== state.activo) setActivo(i);
  }

  function posicionarTrack() {
    const cards = el.track.querySelectorAll(".rev-card");
    if (!cards.length) return;
    const card = cards[state.activo];
    const viewport = el.track.parentElement;
    const anchoCard = card.offsetWidth + 12;
    const centro = viewport.clientWidth / 2 - card.offsetWidth / 2;
    let offset = card.offsetLeft - centro;
    const maxOffset = el.track.scrollWidth - viewport.clientWidth;
    offset = Math.max(0, Math.min(offset, Math.max(0, maxOffset)));
    el.track.style.transform = `translateX(${-offset}px)`;
    el.navPrev.disabled = state.activo === 0;
    el.navNext.disabled = state.activo === state.plan.length - 1;
  }

  function pintarDetalle() {
    const itv = state.plan[state.activo];
    if (!itv) return;
    const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
    el.detTitulo.textContent = `Revisión ${itv.n} — ${km}`;
    const sub = [];
    if (itv.meses) sub.push(`${itv.meses} meses`);
    if (itv.horas) sub.push(`${itv.horas} h de mano de obra`);
    el.detSub.textContent = sub.join(" · ");

    if (itv.gratis || itv.totalConIva === 0) {
      el.detPrecio.textContent = "Sin costo";
      el.detPrecio.classList.add("gratis");
    } else {
      el.detPrecio.textContent = money(itv.totalConIva);
      el.detPrecio.classList.remove("gratis");
    }

    // operaciones
    if (itv.operaciones && itv.operaciones.length) {
      el.detOperaciones.innerHTML = itv.operaciones.map((o) => {
        const acc = o.accion === "R" ? "Reemplazar" : (o.accion === "I" ? "Inspeccionar" : o.accion);
        return `<li><span class="ops-badge ops-badge--${o.accion === "R" ? "R" : "I"}">${acc}</span><span>${o.nombre}</span></li>`;
      }).join("");
    } else {
      el.detOperaciones.innerHTML = '<li class="ops-empty">Consulta el detalle de operaciones con tu concesionario.</li>';
    }

    // desglose repuestos/lubricantes/MO
    pintarDesglose(itv);
    // adicionales
    pintarAdicionales(itv);
  }

  function pintarDesglose(itv) {
    const filas = [];
    const grupos = { repuesto: [], lubricante: [], material: [] };
    (itv.items || []).forEach((it) => (grupos[it.tipo] || grupos.repuesto).push(it));
    const titulos = { repuesto: "Repuestos", lubricante: "Lubricantes", material: "Materiales" };

    for (const g of ["repuesto", "lubricante", "material"]) {
      if (!grupos[g].length) continue;
      filas.push(`<tr><td class="dg-cat" colspan="2">${titulos[g]}</td></tr>`);
      grupos[g].forEach((it) => {
        const cod = it.codigo ? `<span class="dg-cod">Cód. ${it.codigo}${it.cantidad ? " · x" + it.cantidad : ""}</span>` : "";
        filas.push(`<tr><td class="dg-nombre">${it.nombre}${cod}</td><td>${money(it.subtotal)}</td></tr>`);
      });
    }
    if (itv.manoObra) {
      filas.push(`<tr><td class="dg-cat" colspan="2">Mano de obra</td></tr>`);
      filas.push(`<tr><td class="dg-nombre">Mano de obra${itv.horas ? " (" + itv.horas + " h)" : ""}</td><td>${money(itv.manoObra)}</td></tr>`);
    }
    if (!filas.length) {
      filas.push(`<tr><td class="dg-nombre" colspan="2" style="color:var(--gris-3);font-style:italic">El valor corresponde al precio total sugerido de la mantención.</td></tr>`);
    }
    filas.push(`<tr class="dg-total"><td>Total mantención</td><td>${itv.gratis ? "Sin costo" : money(itv.totalConIva)}</td></tr>`);
    if (itv.totalNeto) {
      filas.push(`<tr><td class="dg-nombre" style="color:var(--gris-3)">Valor neto (sin IVA)</td><td style="color:var(--gris-3)">${money(itv.totalNeto)}</td></tr>`);
    }
    el.detDesglose.innerHTML = filas.join("");
  }

  function pintarAdicionales(itv) {
    const adics = (state.pauta.adicionales || []).map((a) => {
      // precio específico por km si existe
      let precio = a.precio;
      if (a.porKm && itv.km != null && a.porKm[String(itv.km)] != null) precio = a.porKm[String(itv.km)];
      const aplica = !a.porKm || Object.keys(a.porKm).length === 0 || (itv.km != null && a.porKm[String(itv.km)] != null);
      return { nombre: a.nombre, precio, aplica };
    }).filter((a) => a.aplica && a.precio);

    if (!adics.length) { el.adicionalesBox.hidden = true; return; }
    el.adicionalesBox.hidden = false;
    el.detAdicionales.innerHTML = adics.map((a, i) =>
      `<li><label><input type="checkbox" data-precio="${a.precio}" data-i="${i}"><span>${a.nombre}</span></label><span class="add-precio">${money(a.precio)}</span></li>`
    ).join("");
    el.detAdicionales.querySelectorAll("input").forEach((chk) => chk.addEventListener("change", () => recalcularTotal(itv)));
    recalcularTotal(itv);
  }

  function recalcularTotal(itv) {
    let extra = 0;
    el.detAdicionales.querySelectorAll("input:checked").forEach((c) => (extra += +c.dataset.precio));
    const base = itv.gratis ? 0 : (itv.totalConIva || 0);
    el.totalConAdicionales.textContent = money(base + extra);
  }

  // ---- packs (Omoda/Jaecoo) ----
  function pintarPacks() {
    const packs = state.pauta.packs || [];
    if (!packs.length) { el.packsBox.hidden = true; return; }
    el.packsBox.hidden = false;
    el.packsList.innerHTML = packs.map((p) =>
      `<li class="pack"><div class="pack__nombre">${p.nombre}</div><div class="pack__precio">${money(p.precio)}</div></li>`
    ).join("");
  }

  function pintarNotas() {
    const notas = state.pauta.notas || [];
    el.detNotas.innerHTML = notas.map((n) => `<li>${n}</li>`).join("");
    el.detFuente.textContent = state.pauta.fuente ? "Fuente: " + state.pauta.fuente : "";
  }

  // ---- navegación ----
  function volver() {
    el.paso2.hidden = true;
    el.paso1.hidden = false;
    el.stepbar.forEach((s, i) => s.classList.toggle("is-active", i === 0));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function reiniciar() {
    state.marca = state.modelo = state.version = state.pauta = state.anio = null;
    reset(el.selModelo, "Elige el modelo");
    reset(el.selVersion, "Elige la versión");
    el.fieldAnio.hidden = true; reset(el.selAnio, "Elige el año");
    el.selMarca.value = "";
    el.vehiculoMeta.hidden = true;
    el.btnCotizar.disabled = true;
    volver();
  }

  // ---- utilidades ----
  function etiquetaKm(km) {
    if (km >= 1000) return (km / 1000).toLocaleString("es-CL") + ".000 km";
    return km.toLocaleString("es-CL") + " km";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
