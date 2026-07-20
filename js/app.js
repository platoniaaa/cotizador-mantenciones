/* ============================================================
   Cotizador de Mantenciones Curifor — lógica de la SPA
   Sin dependencias. Datos servidos como JSON estático.
   ============================================================ */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const CLP = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const money = (n) => (n == null ? "—" : CLP.format(Math.round(n)));
  // Los precios se calculan NETOS (así vienen del stock). El IVA se agrega solo
  // para mostrarlo; nunca se acumula en los cálculos.
  const IVA = 0.19;
  const conIva = (n) => (n == null ? null : Math.round(n * (1 + IVA)));

  // ---- estado ----
  const state = {
    indice: null,
    stock: null,     // { actualizado, items: { codigoNorm: {c,f,desc,precio,bodegas,aprox} } }
    marca: null,     // objeto marca del índice
    modelo: null,    // objeto modelo
    version: null,   // {id, nombre, ...}
    pauta: null,     // JSON detalle de la versión
    anio: null,      // año seleccionado (Ford)
    plan: null,      // intervalos del año/plan activo
    activo: 0,       // índice de revisión activa
    adicionales: new Set(),
    modo: "particular",   // "particular" (precio lista) | "interno" (costo/0.8)
    seleccion: {},        // idx de item -> idx de SKU elegido (0 = principal)
    totalCalc: 0,         // total calculado desde stock (modo activo)
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
    detMoneda: $("#detMoneda"), detNeto: $("#detNeto"), detRef: $("#detRef"),
    modoBtns: document.querySelectorAll(".modo-btn"),
    detOperaciones: $("#detOperaciones"), detDesglose: $("#detDesglose"),
    stockResumen: $("#stockResumen"), btnExcel: $("#btnExcel"), btnAgendar: $("#btnAgendar"),
    btnImprimir: $("#btnImprimir"), printDatos: $("#printDatos"),
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
    // stock es opcional: si falta, la plataforma funciona igual (sin disponibilidad)
    try {
      const rs = await fetch("data/stock.json");
      if (rs.ok) state.stock = await rs.json();
    } catch (e) { state.stock = null; }
    llenarMarcas();
    enlazarEventos();
  }

  // ---- stock ----
  const normCod = (c) => (c == null ? "" : String(c).toUpperCase().replace(/[^A-Z0-9]/g, ""));
  function stockDe(codigo) {
    if (!state.stock || !codigo) return null;
    return state.stock.items[normCod(codigo)] || null;
  }
  const num = (n) => (n == null ? "" : Number(n).toLocaleString("es-CL"));
  function bodegasTxt(bodegas, max) {
    if (!bodegas || !bodegas.length) return "";
    return bodegas.slice(0, max).map((b) => `${b.n} (${num(b.q)})`).join(" · ") +
      (bodegas.length > max ? ` · +${bodegas.length - max} más` : "");
  }
  const VIA_TXT = { producto: "equivalente por producto", difuso: "presentación equivalente", equivalente: "reemplazo / supersesión" };
  function badgeStock(codigo) {
    const s = stockDe(codigo);
    if (!s) return { clase: "sd", texto: "s/d", bodegas: [], alt: null, aplica: null, titulo: "Sin dato de stock para este código" };
    const c = s.c || 0, f = s.f || 0;
    const detalle = bodegasTxt(s.bodegas, 6);
    const notaAlt = s.alt ? ` · disponible como ${s.alt} (${VIA_TXT[s.via] || "equivalente"})` : "";
    const base = { bodegas: s.bodegas || [], alt: s.alt || null, via: s.via || null, aplica: s.aplica || null };
    if (c > 0) return { ...base, clase: s.alt ? "eq" : "ok", texto: `${s.alt ? "≈ " : ""}${num(c)} u.`, titulo: `Stock Curifor: ${num(c)} u.${detalle ? " · " + detalle : ""}${notaAlt}` };
    if (f > 0) return { ...base, clase: "fro", texto: `${num(f)} u. Frontera`, titulo: `Stock Frontera: ${num(f)} u.${detalle ? " · " + detalle : ""}${notaAlt}` };
    return { ...base, clase: "no", texto: "Sin stock", titulo: "Producto catalogado pero sin stock disponible" };
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
    el.btnExcel.addEventListener("click", exportarExcel);
    el.btnImprimir.addEventListener("click", imprimir);
    el.btnAgendar.addEventListener("click", agendarEnTaller);
    el.modoBtns.forEach((btn) => btn.addEventListener("click", () => {
      state.modo = btn.dataset.modo;
      el.modoBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
      pintarCarrusel();
      pintarDetalle();
    }));
  }

  function imprimir() {
    const p = state.pauta, itv = state.plan[state.activo];
    if (!p || !itv) return;
    const filas = [
      ["Marca / Modelo", `${p.marcaNombre} · ${p.modelo}`],
      ["Versión", p.version],
    ];
    if (state.anio) filas.push(["Año", state.anio]);
    filas.push(["Tipo", state.modo === "particular" ? "Cliente particular" : "Interno"]);
    filas.push(["Mantención", `Revisión ${itv.n} — ${itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega")}${itv.meses ? " · " + itv.meses + " meses" : ""}`]);
    if (itv.gratis) {
      filas.push(["Valor", "Sin costo"]);
    } else {
      filas.push(["Valor neto (sin IVA)", money(state.totalCalc)]);
      filas.push(["IVA 19%", money(conIva(state.totalCalc) - state.totalCalc)]);
      filas.push(["TOTAL con IVA", money(conIva(state.totalCalc))]);
    }
    if (state.stock) filas.push(["Inventario al", state.stock.actualizado]);
    filas.push(["Fecha impresión", new Date().toLocaleDateString("es-CL")]);
    el.printDatos.innerHTML = filas.map((f) => `<tr><td>${f[0]}</td><td>${f[1]}</td></tr>`).join("");
    window.print();
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
    state.seleccion = {};
    pintarCarrusel();
    pintarDetalle();
  }

  function pintarCarrusel() {
    el.track.innerHTML = state.plan.map((itv, i) => {
      const km = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
      const meses = itv.meses ? `${itv.meses} meses` : (itv.gratis ? "Primer servicio" : "");
      const precio = itv.gratis ? '<span class="rev-card__gratis">Sin costo</span>' : money(totalIntervalo(itv));
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
    state.seleccion = {};
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

    // operaciones
    if (itv.operaciones && itv.operaciones.length) {
      el.detOperaciones.innerHTML = itv.operaciones.map((o) => {
        const acc = o.accion === "R" ? "Reemplazar" : (o.accion === "I" ? "Inspeccionar" : o.accion);
        return `<li><span class="ops-badge ops-badge--${o.accion === "R" ? "R" : "I"}">${acc}</span><span>${o.nombre}</span></li>`;
      }).join("");
    } else {
      el.detOperaciones.innerHTML = '<li class="ops-empty">Consulta el detalle de operaciones con tu concesionario.</li>';
    }

    // desglose (valoriza desde stock según modo) -> devuelve el total calculado
    const totalCalc = pintarDesglose(itv);
    state.totalCalc = totalCalc;

    // precio destacado = total calculado (neto, según modo)
    if (itv.gratis || totalCalc === 0) {
      el.detPrecio.textContent = "Sin costo";
      el.detPrecio.classList.add("gratis");
      el.detNeto.textContent = "";
    } else {
      el.detPrecio.textContent = money(conIva(totalCalc));   // con IVA en grande
      el.detPrecio.classList.remove("gratis");
      el.detNeto.textContent = `${money(totalCalc)} neto s/IVA`;   // neto en chico
    }
    el.detMoneda.textContent = `${state.modo === "particular" ? "Cliente particular" : "Interno"} · IVA incluido · CLP`;
    // referencia: precio oficial de la pauta
    if (itv.totalConIva && !itv.gratis) {
      el.detRef.hidden = false;
      el.detRef.textContent = `Precio pauta (ref.): ${money(itv.totalConIva)}`;
    } else {
      el.detRef.hidden = true;
    }
    // adicionales
    pintarAdicionales(itv);
  }

  // ---- valorización desde stock (neto, según modo) ----
  // SKUs pickeables de un item de pauta: [principal en stock, ...equivalentes]. [] si no hay stock.
  function skusDe(it) {
    if (!state.stock || !it.codigo) return [];
    const s = stockDe(it.codigo);
    if (!s || !((s.c || 0) > 0 || (s.f || 0) > 0)) return [];
    const principal = {
      cod: s.alt || it.codigo, desc: s.desc, c: s.c, f: s.f, pv: s.pv, co: s.co,
      bodegas: s.bodegas || [], aplica: s.aplica || null, via: s.via || null,
    };
    return [principal, ...(s.opciones || [])];
  }
  function skuActivo(it, idx) {
    const lista = skusDe(it);
    if (!lista.length) return null;
    const sel = state.seleccion[idx] || 0;
    return lista[Math.min(sel, lista.length - 1)];
  }
  function precioUnit(sku) {
    if (!sku) return null;
    if (state.modo === "interno") return sku.co != null ? Math.round(sku.co / 0.8) : null;
    return sku.pv != null ? sku.pv : null;   // particular = precio lista (neto)
  }
  // subtotal de un item: desde stock (unit×cantidad) si se puede; si no, valor de la pauta
  function subtotalItem(it, idx) {
    const sku = skuActivo(it, idx);
    const unit = precioUnit(sku);
    if (sku && unit != null && it.cantidad) return Math.round(unit * it.cantidad);
    return it.subtotal || 0;   // respaldo: precio de la pauta (materiales, sin cantidad, o s/d)
  }
  // total de un intervalo con SKU principal (para el carrusel), según modo
  function totalIntervalo(itv) {
    if (itv.gratis) return 0;
    if (!(itv.items && itv.items.length)) return itv.totalConIva || 0;
    let t = 0;
    itv.items.forEach((it) => {
      const sku = (skusDe(it) || [])[0] || null;
      const unit = precioUnit(sku);
      t += (sku && unit != null && it.cantidad) ? Math.round(unit * it.cantidad) : (it.subtotal || 0);
    });
    return t + (itv.manoObra || 0);
  }

  function pintarDesglose(itv) {
    const filas = [];
    const titulos = { repuesto: "Repuestos", lubricante: "Lubricantes", material: "Materiales" };
    const hayStock = !!state.stock;
    let conCod = 0, disp = 0, total = 0;
    const sinStock = [], sinDato = [];
    const items = itv.items || [];

    for (const g of ["repuesto", "lubricante", "material"]) {
      const idxs = items.map((it, i) => [it, i]).filter(([it]) => (it.tipo || "repuesto") === g);
      if (!idxs.length) continue;
      filas.push(`<tr><td class="dg-cat" colspan="3">${titulos[g]}</td></tr>`);
      for (const [it, idx] of idxs) {
        const sub = subtotalItem(it, idx);
        total += sub;
        const skus = skusDe(it);
        const sku = skuActivo(it, idx);
        const selIdx = state.seleccion[idx] || 0;
        // El código visible es SIEMPRE el de la pauta. Solo cambia si el usuario
        // elige explícitamente un reemplazo en el selector.
        const codMostrado = (selIdx === 0 || !sku) ? it.codigo : sku.cod;
        const cod = it.codigo ? `<span class="dg-cod">Cód. ${codMostrado}${it.cantidad ? " · x" + it.cantidad : ""}</span>` : "";
        let celdaStock = "<td></td>";
        let extra = "";
        if (hayStock && g !== "material" && it.codigo) {
          conCod++;
          const b = badgeStock(it.codigo);
          if (b.clase === "ok" || b.clase === "fro" || b.clase === "eq") disp++;
          else if (b.clase === "no") sinStock.push(it.nombre);
          else sinDato.push(it.nombre);
          const txt = sku ? `${num(sku.c)} u.` : b.texto;
          const clase = sku ? (sku.c > 0 ? "ok" : "no") : b.clase;
          celdaStock = `<td class="dg-stock"><span class="stk stk--${clase}" title="${b.titulo}">${txt}</span></td>`;
          // el stock tiene la misma pieza bajo otro SKU interno -> se avisa, pero el
          // código de la pauta se mantiene arriba
          if (sku && selIdx === 0 && normCod(sku.cod) !== normCod(it.codigo)) {
            extra += `<span class="dg-alt" title="Misma pieza; en bodega está catalogada con este código">≈ en bodega como <strong>${sku.cod}</strong></span>`;
          }
          // selector de reemplazo (si hay >1 SKU pickeable)
          if (skus.length > 1) {
            const opts = skus.map((k, ki) => {
              const u = precioUnit(k);
              const et = `${ki === 0 ? "Pauta: " + it.codigo : k.cod} · ${num(k.c)} u.${u != null ? " · " + money(u) : ""}`;
              return `<option value="${ki}"${selIdx === ki ? " selected" : ""}>${et}</option>`;
            }).join("");
            extra += `<label class="dg-reemplazo">Reemplazo: <select data-idx="${idx}" class="sel-reemplazo">${opts}</select></label>`;
          }
          const bod = sku ? sku.bodegas : b.bodegas;
          if (bod && bod.length) extra += `<span class="dg-bodega">📍 ${bodegasTxt(bod, 3)}</span>`;
          const apl = (sku && sku.aplica) || b.aplica;
          if (apl) extra += `<span class="dg-aplica" title="Modelos a los que aplica esta pieza">Aplica: ${apl}</span>`;
        }
        filas.push(`<tr><td class="dg-nombre">${it.nombre}${cod}${extra}</td>${celdaStock}<td>${money(sub)}</td></tr>`);
      }
    }
    if (itv.manoObra) {
      total += itv.manoObra;
      filas.push(`<tr><td class="dg-cat" colspan="3">Mano de obra</td></tr>`);
      filas.push(`<tr><td class="dg-nombre">Mano de obra${itv.horas ? " (" + itv.horas + " h)" : ""}</td><td></td><td>${money(itv.manoObra)}</td></tr>`);
    }
    if (!filas.length) {
      filas.push(`<tr><td class="dg-nombre" colspan="3" style="color:var(--ink-3);font-style:italic">El valor corresponde al precio total sugerido de la mantención.</td></tr>`);
      total = itv.gratis ? 0 : (itv.totalConIva || 0);
    }
    const modoTxt = state.modo === "particular" ? "particular" : "interno";
    filas.push(`<tr class="dg-total"><td>Total neto (${modoTxt}) · sin IVA</td><td></td><td>${itv.gratis ? "Sin costo" : money(total)}</td></tr>`);
    if (!itv.gratis) {
      filas.push(`<tr class="dg-iva"><td>IVA 19%</td><td></td><td>${money(conIva(total) - total)}</td></tr>`);
      filas.push(`<tr class="dg-total dg-total--iva"><td>Total con IVA</td><td></td><td>${money(conIva(total))}</td></tr>`);
    }
    el.detDesglose.innerHTML = filas.join("");
    // enlazar selectores de reemplazo
    el.detDesglose.querySelectorAll(".sel-reemplazo").forEach((sel) => {
      sel.addEventListener("change", () => {
        state.seleccion[+sel.dataset.idx] = +sel.value;
        pintarDetalle();
      });
    });

    // resumen de disponibilidad (3 estados claros para el mecánico)
    if (hayStock && conCod > 0) {
      el.stockResumen.hidden = false;
      const fecha = `<span class="stock-fecha">· inventario al ${state.stock.actualizado}</span>`;
      let estado, icono, linea, detalle = "";
      if (sinStock.length) {
        estado = "warn"; icono = "⚠";
        linea = `<strong>${disp} de ${conCod}</strong> repuestos con stock — <strong>${sinStock.length} sin stock</strong>`;
        detalle = `<p class="stock-resumen__faltan">Sin stock en bodega: ${sinStock.join(", ")}.` +
          (sinDato.length ? ` Sin dato (revisar en sistema): ${sinDato.join(", ")}.` : "") + `</p>`;
      } else if (sinDato.length) {
        estado = "info"; icono = "ℹ";
        linea = `<strong>${disp} de ${conCod}</strong> repuestos con stock confirmado`;
        detalle = `<p class="stock-resumen__faltan">Sin dato de stock (revisar en sistema): ${sinDato.join(", ")}.</p>`;
      } else {
        estado = "ok"; icono = "✓";
        linea = `<strong>Todos los repuestos con stock</strong> (${disp} de ${conCod})`;
      }
      el.stockResumen.className = "stock-resumen stock-resumen--" + estado;
      el.stockResumen.innerHTML =
        `<div class="stock-resumen__linea"><span class="stk-icono">${icono}</span> ${linea} ${fecha}</div>` + detalle;
    } else {
      el.stockResumen.hidden = true;
    }
    return total;
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
    const base = itv.gratis ? 0 : (state.totalCalc || 0);
    const t = base + extra;
    el.totalConAdicionales.innerHTML =
      `${money(t)} <span class="add-iva">(${money(conIva(t))} con IVA)</span>`;
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

  // ============================================================
  //  Exportar a Excel (SheetJS)
  // ============================================================
  function exportarExcel() {
    if (typeof XLSX === "undefined") { alert("No se pudo cargar el generador de Excel."); return; }
    const p = state.pauta;
    const itv = state.plan[state.activo];
    if (!p || !itv) return;
    const wb = XLSX.utils.book_new();

    // adicionales seleccionados
    const adicSel = [];
    el.detAdicionales.querySelectorAll("input:checked").forEach((c) => {
      const li = c.closest("li");
      adicSel.push({ nombre: li.querySelector("span").textContent, precio: +c.dataset.precio });
    });

    // ---- Hoja 1: Cotización (revisión activa) ----
    const A = [];
    A.push(["COTIZACIÓN DE MANTENCIÓN — CURIFOR"]);
    A.push([]);
    A.push(["Marca", p.marcaNombre]);
    A.push(["Modelo", p.modelo]);
    A.push(["Versión", p.version]);
    if (p.motor) A.push(["Motor", p.motor]);
    if (state.anio) A.push(["Año", state.anio]);
    if (p.segmento) A.push(["Segmento", p.segmento]);
    A.push(["Tipo", state.modo === "particular" ? "Cliente particular (precio lista)" : "Interno (costo ÷ 0,8)"]);
    A.push(["Mantención", `Revisión ${itv.n} — ${itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega")}`]);
    if (itv.meses) A.push(["Periodicidad", `${itv.meses} meses`]);
    if (state.stock) A.push(["Inventario al", state.stock.actualizado]);
    A.push([]);
    A.push(["DETALLE", "", "Código (pauta)", "Código en bodega", "Cantidad", "Valor neto (CLP)", "Stock", "Bodegas (cantidad)", "Aplica a (modelos)"]);

    const filaItem = (it, idx, tipo) => {
      const sub = subtotalItem(it, idx);
      const codPauta = it.codigo || "";
      let codBodega = "", stkTxt = "", bodTxt = "", aplTxt = "";
      if (state.stock && tipo !== "Materiales" && it.codigo) {
        const sku = skuActivo(it, idx);
        if (sku) {
          if (normCod(sku.cod) !== normCod(codPauta)) codBodega = sku.cod;
          stkTxt = `${num(sku.c)} u.`; bodTxt = bodegasTxt(sku.bodegas, 6); aplTxt = sku.aplica || "";
        } else {
          const s = stockDe(it.codigo);
          stkTxt = s ? ((s.c || 0) > 0 ? `${num(s.c)} u.` : "Sin stock") : "s/d";
        }
      }
      return [it.nombre, "", codPauta, codBodega, it.cantidad || "", sub, stkTxt, bodTxt, aplTxt];
    };
    const grupos = { repuesto: "Repuestos", lubricante: "Lubricantes", material: "Materiales" };
    for (const g of ["repuesto", "lubricante", "material"]) {
      const idxs = (itv.items || []).map((x, i) => [x, i]).filter(([x]) => (x.tipo || "repuesto") === g);
      if (!idxs.length) continue;
      A.push([grupos[g]]);
      idxs.forEach(([it, idx]) => A.push(filaItem(it, idx, grupos[g])));
    }
    if (itv.manoObra) { A.push(["Mano de obra"]); A.push([`Mano de obra${itv.horas ? " (" + itv.horas + " h)" : ""}`, "", "", "", "", itv.manoObra, ""]); }
    A.push([]);
    const totalM = itv.gratis ? 0 : (state.totalCalc || 0);
    A.push([`TOTAL NETO (${state.modo === "particular" ? "particular" : "interno"}, sin IVA)`, "", "", "", "", totalM, ""]);
    A.push(["IVA 19%", "", "", "", "", conIva(totalM) - totalM, ""]);
    A.push(["TOTAL CON IVA", "", "", "", "", conIva(totalM), ""]);
    A.push(["Precio pauta (referencia)", "", "", "", "", itv.gratis ? 0 : (itv.totalConIva || 0), ""]);
    if (adicSel.length) {
      A.push([]); A.push(["SERVICIOS ADICIONALES"]);
      let tot = totalM;
      adicSel.forEach((a) => { A.push([a.nombre, "", "", "", "", a.precio, ""]); tot += a.precio; });
      A.push(["TOTAL CON ADICIONALES (neto)", "", "", "", "", tot, ""]);
      A.push(["TOTAL CON ADICIONALES (con IVA)", "", "", "", "", conIva(tot), ""]);
    }
    if (itv.operaciones && itv.operaciones.length) {
      A.push([]); A.push(["OPERACIONES INCLUIDAS"]);
      itv.operaciones.forEach((o) => A.push([(o.accion === "R" ? "Reemplazar" : "Inspeccionar") + ": " + o.nombre]));
    }
    A.push([]);
    (p.notas || []).forEach((n) => A.push([n]));
    const ws1 = XLSX.utils.aoa_to_sheet(A);
    ws1["!cols"] = [{ wch: 42 }, { wch: 2 }, { wch: 20 }, { wch: 20 }, { wch: 9 }, { wch: 15 }, { wch: 12 }, { wch: 42 }, { wch: 44 }];
    XLSX.utils.book_append_sheet(wb, ws1, "Cotización");

    // ---- Hoja 2: Plan completo ----
    const modoTxt = state.modo === "particular" ? "particular" : "interno";
    const B = [["Rev.", "Kilometraje", "Meses", `Valor ${modoTxt} neto (CLP)`,
                "Valor con IVA (CLP)", "Precio pauta (ref.)"]];
    state.plan.forEach((x) => {
      const neto = x.gratis ? null : totalIntervalo(x);
      B.push([
        x.n, x.km ? etiquetaKm(x.km) : (x.etiqueta || "Entrega"), x.meses || "",
        x.gratis ? "Sin costo" : neto, x.gratis ? "" : conIva(neto),
        x.gratis ? "" : (x.totalConIva || ""),
      ]);
    });
    const ws2 = XLSX.utils.aoa_to_sheet(B);
    ws2["!cols"] = [{ wch: 6 }, { wch: 16 }, { wch: 8 }, { wch: 22 }, { wch: 20 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, ws2, "Plan completo");

    // ---- Hoja 3: Packs (si aplica) ----
    if (p.packs && p.packs.length) {
      const C = [["Pack", "Precio (IVA incl.)"]];
      p.packs.forEach((k) => C.push([k.nombre, k.precio]));
      const ws3 = XLSX.utils.aoa_to_sheet(C);
      ws3["!cols"] = [{ wch: 34 }, { wch: 18 }];
      XLSX.utils.book_append_sheet(wb, ws3, "Packs");
    }

    const nombre = `Cotizacion_${p.marcaNombre}_${p.modelo}_${itv.km ? itv.km / 1000 + "k" : "rev" + itv.n}`
      .replace(/[^A-Za-z0-9_]+/g, "_") + ".xlsx";
    XLSX.writeFile(wb, nombre);
  }

  // ============================================================
  //  Agendar en el Sistema de Taller (taller.html)
  //  Deja la cotización activa en localStorage y navega al taller,
  //  donde el agendamiento se abre pre-llenado al elegir hora.
  // ============================================================
  function agendarEnTaller() {
    const p = state.pauta, itv = state.plan[state.activo];
    if (!p || !itv || !state.version) return;
    const pre = {
      pautaId: state.version.id,
      marcaNombre: p.marcaNombre,
      modelo: p.modelo,
      version: p.version,
      anio: state.anio || null,
      km: itv.km || null,
      revN: itv.n,
      valor: itv.gratis ? 0 : (state.totalCalc || null),
      ts: Date.now(),
    };
    try { localStorage.setItem("curiforTallerPrefill", JSON.stringify(pre)); } catch (e) { /* sin storage */ }
    location.href = "taller.html";
  }

  // ---- utilidades ----
  function etiquetaKm(km) {
    if (km >= 1000) return (km / 1000).toLocaleString("es-CL") + ".000 km";
    return km.toLocaleString("es-CL") + " km";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
