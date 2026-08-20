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

  // Servicios opcionales de venta cruzada: se ofrecen en toda mantención, de
  // cualquier marca. Precio de lista NETO (el IVA se muestra aparte).
  const EXTRAS = [
    { id: "airlife",   nombre: "Airlife",   detalle: "Higienización del sistema de climatización", precio: 16000 },
    { id: "nitrosafe", nombre: "NitroSafe", detalle: "Inflado de neumáticos con nitrógeno",        precio: 18000 },
  ];

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
    extras: new Set(),    // ids de EXTRAS agregados (se mantienen al cambiar de revisión)
    modo: "particular",   // "particular" (precio lista) | "interno" (costo/0.8)
    seleccion: {},        // idx de item -> idx de SKU elegido (0 = principal)
    totalCalc: 0,         // total calculado desde stock (modo activo)
    /* Items que el cliente NO quiere. Vacío = la mantención completa, que es
       lo que corresponde por pauta y lo que hay que ofrecer siempre primero.
       Se destildan uno a uno cuando el cliente pide solo una parte: "hágame el
       aceite pero el filtro de aire no lo cambie". Se guarda por revisión
       (clave "n") porque cambiar de kilometraje es empezar otra cotización. */
    excluidos: {},        // n de revisión -> { idxItem: true, __mo: true }
    /* Para quién es la cotización. Se llena solo al buscar la patente (la base
       de Curifor liga vehículo → RUT → cliente) y, si esa patente no está
       registrada, lo escribe el asesor. Va en el PDF y viaja a la agenda.
       { nombre, rut, fono, email, fuente: "registro" | "manual" } */
    cliente: null,
    clientePat: null,     // patente de la que salió; si cambia, el cliente ya no aplica
    vehReg: null,         // { vin, km } del registro, para la ficha del PDF
  };

  // ---- referencias DOM ----
  const el = {
    paso1: $("#paso1"), paso2: $("#paso2"),
    inpPatente: $("#inpPatente"), btnPatente: $("#btnPatente"), patenteEstado: $("#patenteEstado"),
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
    btnPDF: $("#btnPDF"), printDatos: $("#printDatos"),
    clienteBox: $("#clienteBox"), cliNombreTxt: $("#cliNombreTxt"),
    cliDetalleTxt: $("#cliDetalleTxt"), btnCliente: $("#btnCliente"),
    cliModal: $("#cliModal"), cliModalSub: $("#cliModalSub"),
    cliNombre: $("#cliNombre"), cliRut: $("#cliRut"),
    cliFono: $("#cliFono"), cliEmail: $("#cliEmail"), cliError: $("#cliError"),
    cliCancelar: $("#cliCancelar"), cliGuardar: $("#cliGuardar"), cliSinDatos: $("#cliSinDatos"),
    adicionalesBox: $("#adicionalesBox"), detAdicionales: $("#detAdicionales"),
    extrasVenta: $("#extrasVenta"),
    totalConAdicionales: $("#totalConAdicionales"), adicionalesTotalBox: $("#adicionalesTotalBox"),
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

    // Modo embebido: cuando el host consulta el registro por su cuenta (para no
    // exponer la API key en el navegador), entrega el vehículo ya resuelto y
    // pone su propio campo de patente; acá solo se traduce al catálogo.
    if (window._COTIZ_PATENTE_EXTERNA) {
      const campo = el.inpPatente.closest("label");   // el mensaje de estado sí se mantiene
      if (campo) campo.hidden = true;
      const sep = document.querySelector(".separador");
      if (sep) sep.hidden = true;
    }
    if (window._COTIZ_VEHICULO) {
      await aplicarDatosRegistro(window._COTIZ_VEHICULO);
    }
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
    el.btnPatente.addEventListener("click", buscarPorPatente);
    el.inpPatente.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); buscarPorPatente(); }
    });
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
    el.btnPDF.addEventListener("click", pedirPDF);
    el.btnAgendar.addEventListener("click", agendarEnTaller);
    el.btnCliente.addEventListener("click", () => abrirCliente(false));
    el.cliCancelar.addEventListener("click", cerrarCliente);
    el.cliGuardar.addEventListener("click", guardarCliente);
    el.cliSinDatos.addEventListener("click", () => { cerrarCliente(); descargarPDF(); });
    // clic fuera y Escape cierran, como cualquier modal
    el.cliModal.addEventListener("click", (e) => { if (e.target === el.cliModal) cerrarCliente(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.cliModal.hidden) cerrarCliente();
    });
    el.cliRut.addEventListener("blur", () => {
      const f = formatearRut(el.cliRut.value);
      if (f) el.cliRut.value = f;
    });
    el.modoBtns.forEach((btn) => btn.addEventListener("click", () => {
      state.modo = btn.dataset.modo;
      el.modoBtns.forEach((b) => b.classList.toggle("is-active", b === btn));
      pintarCarrusel();
      pintarDetalle();
    }));
  }

  // ============================================================
  //  Datos del cliente
  //  Vienen de la base al buscar la patente (vehiculos → rut → clientes) o los
  //  escribe el asesor. NO se guardan en Supabase: `clientes` es el padrón de
  //  la empresa y es de solo lectura para la plataforma; el cliente nuevo se da
  //  de alta al agendar, que es donde corresponde. Acá el dato vive mientras
  //  dure la cotización y viaja con ella al PDF y a la agenda.
  // ============================================================

  // RUT: la regla vive en js/rut.js, compartida con la recepción del taller.
  // Se conservan los nombres locales para no tocar el resto del archivo.
  const normRut = (s) => window.Rut.norm(s);
  const rutValido = (s) => window.Rut.valido(s);
  const formatearRut = (s) => window.Rut.formatear(s);

  function pintarCliente() {
    const c = state.cliente;
    const hay = !!(c && (c.nombre || c.rut));
    el.clienteBox.classList.toggle("cliente-box--vacia", !hay);
    el.btnCliente.textContent = hay ? "Editar" : "Agregar datos";
    if (!hay) {
      el.cliNombreTxt.textContent = "Sin datos del cliente";
      el.cliDetalleTxt.textContent = state.clientePat
        ? `La patente ${state.clientePat} no está registrada. Escríbelos para que salgan en el PDF.`
        : "Busca la patente arriba o escríbelos a mano para que salgan en el PDF.";
      return;
    }
    el.cliNombreTxt.textContent = c.nombre || "(sin nombre)";
    const partes = [c.rut, c.fono, c.email].filter(Boolean);
    partes.push(c.fuente === "manual" ? "escrito a mano" : "del registro de Curifor");
    el.cliDetalleTxt.textContent = partes.join(" · ");
  }

  // trasPDF: si se abrió porque faltaban datos para el PDF, al guardar se
  // descarga solo. Obligar a apretar el botón de nuevo, después de tipear todo,
  // es el tipo de paso extra que hace que la gente deje de usar la función.
  let cliTrasPDF = false;
  function abrirCliente(paraPDF) {
    cliTrasPDF = !!paraPDF;
    const c = state.cliente || {};
    el.cliNombre.value = c.nombre || "";
    el.cliRut.value = c.rut || "";
    el.cliFono.value = c.fono || "";
    el.cliEmail.value = c.email || "";
    el.cliError.hidden = true;
    el.cliModalSub.textContent = paraPDF
      ? "Esta cotización todavía no tiene cliente. Completa lo que tengas y sale en el PDF."
      : "Salen en la orden en PDF y viajan a la agenda si agendas desde aquí.";
    el.cliGuardar.textContent = paraPDF ? "Guardar y descargar PDF" : "Guardar";
    el.cliSinDatos.hidden = !paraPDF;
    el.cliModal.hidden = false;
    el.cliNombre.focus();
  }
  function cerrarCliente() {
    el.cliModal.hidden = true;
    cliTrasPDF = false;
  }

  function guardarCliente() {
    const nombre = el.cliNombre.value.trim();
    const rut = el.cliRut.value.trim();
    const fono = el.cliFono.value.trim();
    const email = el.cliEmail.value.trim();

    // El RUT se valida porque termina en la factura. El resto no: un teléfono
    // anotado a medias sigue sirviendo para llamar, y rechazarlo solo lograría
    // que el asesor deje el campo vacío.
    if (rut && !rutValido(rut)) {
      el.cliError.textContent = "Ese RUT no es válido: revisa el dígito verificador.";
      el.cliError.hidden = false;
      el.cliRut.focus();
      return;
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      el.cliError.textContent = "Ese correo no tiene un formato válido.";
      el.cliError.hidden = false;
      el.cliEmail.focus();
      return;
    }
    if (!nombre && !rut && !fono && !email) {
      el.cliError.textContent = "Escribe al menos el nombre del cliente.";
      el.cliError.hidden = false;
      el.cliNombre.focus();
      return;
    }

    state.cliente = {
      nombre, rut: rut ? formatearRut(rut) : "", fono, email, fuente: "manual"
    };
    const veniaDelPDF = cliTrasPDF;
    cerrarCliente();
    pintarCliente();
    if (veniaDelPDF) descargarPDF();
  }

  // ============================================================
  //  Orden de mantención en PDF
  // ============================================================

  /* El logo se lee una vez y se guarda: se dibuja en cada PDF y volver a
     decodificar el PNG en cada descarga no aporta nada. */
  let _logoPDF;
  function logoPDF() {
    if (_logoPDF !== undefined) return Promise.resolve(_logoPDF);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          const escala = Math.min(1, 420 / img.width);
          c.width = Math.round(img.width * escala);
          c.height = Math.round(img.height * escala);
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          _logoPDF = c.toDataURL("image/png");
        } catch (e) { _logoPDF = null; }
        resolve(_logoPDF);
      };
      img.onerror = () => { _logoPDF = null; resolve(null); };
      img.src = "img/curifor-logo.png";
    });
  }

  /* Arma el documento con lo que hay en pantalla. Recorre los items igual que
     pintarDesglose(), incluidos los destildados: en el PDF esos van a la
     sección "no incluido", porque el cliente tiene que ver qué NO se le va a
     hacer. El total, en cambio, es el mismo que muestra la pantalla. */
  function datosOrden() {
    const p = state.pauta, itv = state.plan[state.activo];
    if (!p || !itv) return null;

    const grupos = [];
    const titulos = { repuesto: "Repuestos", lubricante: "Lubricantes", material: "Materiales" };
    const items = itv.items || [];
    for (const g of ["repuesto", "lubricante", "material"]) {
      const idxs = items.map((it, i) => [it, i]).filter(([it]) => (it.tipo || "repuesto") === g);
      if (!idxs.length) continue;
      grupos.push({
        titulo: titulos[g],
        items: idxs.map(([it, idx]) => {
          const sku = skuActivo(it, idx);
          const selIdx = state.seleccion[idx] || 0;
          return {
            nombre: it.nombre,
            codigo: (selIdx === 0 || !sku) ? (it.codigo || "") : sku.cod,
            codBodega: (sku && selIdx === 0 && it.codigo && normCod(sku.cod) !== normCod(it.codigo))
                       ? sku.cod : "",
            cantidad: it.cantidad || "",
            subtotal: subtotalItem(it, idx),
            incluido: !estaExcluido(itv, idx),
          };
        }),
      });
    }

    const base = itv.gratis ? 0 : (state.totalCalc || 0);
    // adicionales de la pauta marcados + extras de venta cruzada
    const adic = [];
    el.detAdicionales.querySelectorAll("input:checked").forEach((c) => {
      adic.push({ nombre: c.closest("li").querySelector("span").textContent, precio: +c.dataset.precio });
    });
    adic.push(...extrasElegidos());
    const netoAdic = base + adic.reduce((t, a) => t + a.precio, 0);

    const c = state.cliente || {};
    return {
      cliente: { nombre: c.nombre, rut: c.rut, fono: c.fono, email: c.email },
      vehiculo: {
        patente: normPat(el.inpPatente.value) || null,
        marca: p.marcaNombre, modelo: p.modelo, version: p.version,
        motor: p.motor || null,
        anio: state.anio || state.anioRegistro || null,
        vin: (state.vehReg && state.vehReg.vin) || null,
        km: (state.vehReg && state.vehReg.km) != null ? state.vehReg.km : null,
      },
      mantencion: {
        n: itv.n, km: itv.km || null, meses: itv.meses || null,
        etiqueta: itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega"),
        gratis: !!itv.gratis, modo: state.modo,
      },
      grupos,
      manoObra: itv.manoObra
        ? { valor: itv.manoObra, horas: itv.horas || null, incluido: !estaExcluido(itv, "__mo") }
        : null,
      totales: { neto: base, iva: conIva(base) - base, total: conIva(base) },
      adicionales: adic,
      totalAdic: adic.length ? { neto: netoAdic, total: conIva(netoAdic) } : null,
      operaciones: itv.operaciones || [],
      notas: p.notas || [],
      fuente: p.fuente ? "Fuente: " + p.fuente : "",
      stockActualizado: state.stock ? state.stock.actualizado : "",
      asesor: null,     // lo completa descargarPDF(), que sí puede esperar la nómina
    };
  }

  /* Quién está cotizando. La sesión solo guarda el correo, así que se busca el
     nombre en la nómina: en el PDF va el NOMBRE y nunca "mfigueroa@curifor.com".
     Este documento lo recibe el cliente, y un correo no le dice con quién habló.
     Si la nómina no responde o la persona no está, se omite la línea entera
     antes que mostrar el correo. Se resuelve una vez por sesión. */
  let _asesor;
  async function cargarAsesor() {
    if (_asesor !== undefined) return _asesor;
    _asesor = null;
    try {
      const s = JSON.parse(localStorage.getItem("curiforTallerWebSes_v1") || "null");
      const email = s && s.email;
      const CFG = window.CURIFOR_AGENDA || {};
      if (!email || !s.access || !CFG.url || !CFG.anonKey) return _asesor;
      const r = await fetch(`${CFG.url}/rest/v1/personal?email=eq.${encodeURIComponent(email)}&select=nombre,corto&limit=1`,
                            { headers: { apikey: CFG.anonKey, Authorization: "Bearer " + s.access } });
      if (!r.ok) return _asesor;
      const filas = await r.json();
      const p = filas && filas[0];
      if (p) _asesor = { nombre: p.corto || p.nombre || null };
    } catch (e) { /* sin nómina, el PDF sale sin la línea */ }
    return _asesor;
  }

  // El botón: si todavía no hay cliente, primero lo pide.
  function pedirPDF() {
    const c = state.cliente;
    if (!c || !(c.nombre || c.rut)) { abrirCliente(true); return; }
    descargarPDF();
  }

  async function descargarPDF() {
    const d = datosOrden();
    if (!d) return;

    // El encabezado de impresión del navegador (Ctrl+P) se llena con lo mismo,
    // para que no se quede contando otra historia que el PDF.
    pintarEncabezadoImpresion(d);

    if (!window.OrdenPDF || !window.OrdenPDF.disponible()) {
      alert("No se pudo cargar el generador de PDF. Revisa que la plataforma esté abierta desde el servidor y vuelve a intentar.");
      return;
    }
    el.btnPDF.disabled = true;
    try {
      const [logo, asesor] = await Promise.all([logoPDF(), cargarAsesor()]);
      d.logo = logo;
      d.asesor = asesor;
      const doc = window.OrdenPDF.generar(d);
      if (doc) doc.save(window.OrdenPDF.nombreArchivo(d));
    } catch (e) {
      alert("No pudimos generar el PDF: " + (e && e.message ? e.message : "error inesperado"));
    } finally {
      el.btnPDF.disabled = false;
    }
  }

  function pintarEncabezadoImpresion(d) {
    const filas = [];
    if (d.cliente.nombre) filas.push(["Cliente", d.cliente.nombre]);
    if (d.cliente.rut) filas.push(["RUT", d.cliente.rut]);
    if (d.vehiculo.patente) filas.push(["Patente", d.vehiculo.patente]);
    filas.push(["Marca / Modelo", `${d.vehiculo.marca} · ${d.vehiculo.modelo}`]);
    filas.push(["Versión", d.vehiculo.version]);
    if (d.vehiculo.anio) filas.push(["Año", d.vehiculo.anio]);
    filas.push(["Tipo", d.mantencion.modo === "particular" ? "Cliente particular" : "Interno"]);
    filas.push(["Mantención", `Revisión ${d.mantencion.n} — ${d.mantencion.etiqueta}` +
                              (d.mantencion.meses ? " · " + d.mantencion.meses + " meses" : "")]);
    if (d.mantencion.gratis) {
      filas.push(["Valor", "Sin costo"]);
    } else {
      filas.push(["Valor neto (sin IVA)", money(d.totales.neto)]);
      filas.push(["IVA 19%", money(d.totales.iva)]);
      filas.push(["TOTAL con IVA", money(d.totales.total)]);
    }
    if (d.totalAdic) filas.push(["TOTAL con adicionales (con IVA)", money(d.totalAdic.total)]);
    if (d.stockActualizado) filas.push(["Inventario al", d.stockActualizado]);
    filas.push(["Fecha", new Date().toLocaleDateString("es-CL")]);
    el.printDatos.innerHTML = filas.map((f) => `<tr><td>${f[0]}</td><td>${f[1]}</td></tr>`).join("");
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
    // cambiar la marca a mano descarta lo que dijo el registro de la patente
    state.anioRegistro = null;
    state.anioFueraDeCatalogo = false;
    reset(el.selVersion, "Elige la versión");
    reset(el.selAnio, "Elige el modelo primero");
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
    state.version = state.pauta = null;
    state.anio = null;
    reset(el.selAnio, "Elige el modelo primero");
    el.vehiculoMeta.hidden = true;
    if (!state.modelo) { reset(el.selVersion, "Elige la versión"); actualizarBoton(); return; }

    // Los años del MODELO son la unión de los de sus versiones. Van primero
    // porque son los que deciden qué versiones corresponden: al revés, se
    // elegía una versión para descubrir después que su pauta cubría otros años.
    const anios = aniosDelModelo(state.modelo);
    if (anios.length) {
      el.selAnio.innerHTML = '<option value="">Elige el año</option>' +
        anios.map((a) => `<option value="${a}">${a}</option>`).join("");
      el.selAnio.disabled = false;
      // la versión espera al año
      reset(el.selVersion, "Elige primero el año");
      marcarPendiente(el.selAnio, true);
      aplicarAnioDelRegistro();     // si la patente ya dijo el año, queda puesto
    } else {
      // Modelos cuya vigencia va por versión y no por año. El campo se queda a
      // la vista pero deshabilitado, DICIENDO por qué: si desapareciera, la
      // pantalla saltaría y parecería que el año se pide a veces sí y a veces
      // no, sin motivo visible.
      reset(el.selAnio, "No aplica a este modelo");
      llenarVersiones(null);
    }
    actualizarBoton();
  }

  // ¿El catálogo de este modelo distingue años? Antes esto se preguntaba
  // mirando si el campo Año estaba oculto; ahora el campo siempre se muestra
  // (para que se vea que va antes de la versión), así que hay que preguntarlo
  // a los datos.
  function modeloUsaAnios() {
    return !!(state.modelo && aniosDelModelo(state.modelo).length);
  }

  // Años que cubre un modelo, del más nuevo al más viejo.
  function aniosDelModelo(modelo) {
    const s = new Set();
    (modelo.versiones || []).forEach((v) => (v.anios || []).forEach((a) => s.add(String(a))));
    return [...s].sort().reverse();
  }

  // Llena el selector de versiones. Con `anio`, deja solo las que lo cubren.
  // El value sigue siendo el índice ORIGINAL dentro de modelo.versiones: es lo
  // que lee onVersion(), y renumerarlo apuntaría a otra versión.
  function llenarVersiones(anio) {
    const vs = state.modelo.versiones || [];
    const opciones = vs
      .map((v, i) => ({ v, i }))
      .filter(({ v }) => !anio || !v.anios || !v.anios.length || v.anios.indexOf(String(anio)) >= 0);
    if (!opciones.length) {
      reset(el.selVersion, "Sin versiones para ese año");
      return;
    }
    el.selVersion.innerHTML = '<option value="">Elige la versión</option>' +
      opciones.map(({ v, i }) => `<option value="${i}">${v.nombre}</option>`).join("");
    el.selVersion.disabled = false;
    // con una sola opción no hay nada que elegir
    if (opciones.length === 1) {
      el.selVersion.value = String(opciones[0].i);
      onVersion();
    }
  }

  async function onVersion() {
    state.version = state.modelo.versiones[el.selVersion.value] || null;
    el.vehiculoMeta.hidden = true;
    if (!state.version) { state.pauta = null; actualizarBoton(); return; }
    // el año ya se eligió antes; acá solo se carga el detalle y la metadata
    await cargarPauta(state.version.id);
    mostrarMeta();
    marcarPendiente(el.selVersion, false);
    actualizarBoton();
  }
  // El año manda: al cambiarlo se rehace la lista de versiones, porque las que
  // servían para el año anterior pueden no existir en el nuevo.
  function onAnioSelector() {
    state.anio = el.selAnio.value || null;
    marcarPendiente(el.selAnio, !state.anio);
    if (state.modelo) {
      state.version = state.pauta = null;
      el.vehiculoMeta.hidden = true;
      if (state.anio) llenarVersiones(state.anio);
      else reset(el.selVersion, "Elige primero el año");
    }
    actualizarBoton();
  }

  // Deja puesto el año que trae el registro del vehículo, si la pauta lo cubre.
  // Si no lo cubre lo dice, en vez de quedarse callado: un Ranger 2018 no tiene
  // plan porque las pautas de Ranger van de 2021 en adelante, y sin explicación
  // parece que el sistema perdió el dato.
  function aplicarAnioDelRegistro() {
    state.anioFueraDeCatalogo = false;
    const a = state.anioRegistro;
    if (!a || !modeloUsaAnios()) return;
    const anios = aniosDelModelo(state.modelo);
    if (anios.some((x) => String(x) === String(a))) {
      el.selAnio.value = String(a);
      onAnioSelector();        // esto filtra las versiones a las de ese año
      return;
    }
    state.anioFueraDeCatalogo = true;
    marcarPendiente(el.selAnio, true);
    estadoPatente("warn",
      `El registro dice que el vehículo es <b>${a}</b>, pero el catálogo solo tiene pautas de ` +
      `este modelo para <b>${anios.join(", ")}</b>. Elige el año que corresponda.`);
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
    // Con IVA, igual que el precio grande de la revisión. Este chip no lleva
    // ninguna etiqueta que diga "neto", así que mostrarlo sin IVA se lee como
    // el valor final y no lo es. El neto queda a mano en el tooltip.
    if (p.tarifaMO) {
      chips.push(`<span class="chip" title="${money(p.tarifaMO)} neto, sin IVA">` +
                 `Mano de obra ${money(conIva(p.tarifaMO))}/hora con IVA</span>`);
    }
    el.vehiculoMeta.innerHTML = chips.join("");
    el.vehiculoMeta.hidden = chips.length === 0;
  }

  function actualizarBoton() {
    const listo = state.version && state.pauta &&
      (!(state.pauta.anios && state.pauta.anios.length) || state.anio);
    el.btnCotizar.disabled = !listo;
  }

  // ============================================================
  //  Búsqueda por patente
  // ============================================================
  //  Consulta el registro del vehículo (api.boostr.cl) y traduce la respuesta
  //  al catálogo. El registro entrega la marca y un texto que mezcla modelo,
  //  versión, motor y tracción ("RANGER XLT 3.2 4X4"), más el año; NO entrega
  //  la versión por separado (eso es plan pago), así que la versión la termina
  //  de elegir el asesor salvo que el modelo tenga una sola.
  //
  //  El transporte cambia según dónde corra el cotizador:
  //   · embebido en la app de Curifor → el host define __cotizConsultarPatente
  //     y la llamada la hace el servidor, con la API key en sus secrets (así la
  //     key nunca llega al navegador ni depende de la CSP del iframe);
  //   · standalone → llamada directa a la API con la key que exponga el host
  //     en _COTIZ_BOOSTR_KEY.
  const PATENTE_RE = /^([A-Z]{4}\d{2}|[A-Z]{2}\d{4}|[A-Z]{3}\d{2}|[A-Z]{2}\d{3})$/;
  const normPat = (s) => (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const cachePatente = new Map();

  const normTxt = (s) => (s == null ? "" : String(s))
    .toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  const compactar = (s) => normTxt(s).replace(/ /g, "");

  // tokens de un texto; los decimales aportan además su forma pegada (1.5 → "15")
  function tokensDe(s) {
    const t = new Set(normTxt(s).split(" ").filter(Boolean));
    ((s == null ? "" : String(s)).match(/\d+[.,]\d+/g) || [])
      .forEach((d) => t.add(d.replace(/[.,]/g, "")));
    return t;
  }

  function buscarMarcaEnIndice(make) {
    const m = normTxt(make);
    if (!m) return null;
    const marcas = state.indice.marcas;
    return marcas.find((x) => normTxt(x.nombre) === m || normTxt(x.id) === m)
        || marcas.find((x) => m.startsWith(normTxt(x.nombre) + " ") || m.endsWith(" " + normTxt(x.nombre)))
        || null;
  }

  // gana el nombre de modelo más largo que calce: "Grand Santa Fe" antes que
  // "Santa Fe", "X55 PLUS" antes que "X55", "Transit V363" antes que "Transit"
  function buscarModeloEnMarca(marca, model) {
    const t = normTxt(model);
    if (!t) return null;
    const cands = marca.modelos
      .map((mo) => ({ mo, n: normTxt(mo.nombre) }))
      .filter((c) => c.n)
      .sort((a, b) => b.n.length - a.n.length);
    for (const c of cands) {
      if (t === c.n || t.startsWith(c.n + " ") || t.includes(" " + c.n + " ") || t.endsWith(" " + c.n)) return c.mo;
    }
    // calce pegado: "PIKUP" ↔ "Pik Up", "GS3POWER" ↔ "GS3 Power"
    const tc = compactar(model);
    for (const c of cands) {
      const nc = compactar(c.mo.nombre);
      if (nc.length >= 3 && tc.startsWith(nc)) return c.mo;
    }
    return null;
  }

  // filtra por año y puntúa las versiones con lo que sobró del texto del registro
  function buscarVersionEnModelo(modelo, model, anio) {
    let vs = modelo.versiones || [];
    if (!vs.length) return { version: null, candidatas: [] };
    if (anio) {
      const porAnio = vs.filter((v) => !v.anios || v.anios.indexOf(String(anio)) >= 0);
      if (porAnio.length) vs = porAnio;
    }
    if (vs.length === 1) return { version: vs[0], candidatas: vs };

    const resto = normTxt(model).replace(normTxt(modelo.nombre), " ");
    const tr = tokensDe(resto);
    if (!tr.size) return { version: null, candidatas: vs };

    const puntuadas = vs.map((v) => {
      const tv = tokensDe(v.nombre);
      let p = 0;
      tr.forEach((x) => { if (tv.has(x)) p += x.length >= 2 ? 2 : 1; });
      return { v, p };
    }).sort((a, b) => b.p - a.p);

    // solo si hay un ganador claro; ante empate decide el asesor
    const gana = puntuadas[0].p > 0 && (puntuadas.length === 1 || puntuadas[0].p > puntuadas[1].p);
    return { version: gana ? puntuadas[0].v : null, candidatas: vs };
  }

  function resolverVehiculo(datos) {
    const marca = buscarMarcaEnIndice(datos.make);
    if (!marca) return { marca: null, modelo: null, version: null, candidatas: [] };
    const modelo = buscarModeloEnMarca(marca, datos.model);
    if (!modelo) return { marca, modelo: null, version: null, candidatas: [] };
    const r = buscarVersionEnModelo(modelo, datos.model, datos.year);
    return { marca, modelo, version: r.version, candidatas: r.candidatas };
  }

  async function consultarPatente(placa) {
    if (typeof window.__cotizConsultarPatente === "function") {
      return await window.__cotizConsultarPatente(placa);
    }
    const key = window._COTIZ_BOOSTR_KEY || "";
    if (!key) {
      const e = new Error("sin-key");
      e.codigo = "SIN_KEY";
      throw e;
    }
    const r = await fetch(`https://api.boostr.cl/vehicle/${encodeURIComponent(placa)}.json`,
                          { headers: { "X-API-KEY": key, "Accept": "application/json" } });
    const j = await r.json().catch(() => null);
    if (!j) { const e = new Error("respuesta ilegible"); e.codigo = "RESPUESTA"; throw e; }
    if (j.status !== "success" || !j.data) {
      const e = new Error(j.message || "consulta rechazada");
      e.codigo = j.code || "ERROR";
      throw e;
    }
    return j.data;
  }

  function estadoPatente(tipo, html) {
    el.patenteEstado.className = "patente__estado patente__estado--" + tipo;
    el.patenteEstado.innerHTML = html;
    el.patenteEstado.hidden = false;
  }

  function marcarPendiente(sel, pendiente) {
    const campo = sel && sel.closest(".field");
    if (campo) campo.classList.toggle("field--pendiente", !!pendiente);
  }

  async function aplicarVehiculo(r, datos) {
    // replica el orden de onMarca/onModelo para que los índices calcen
    el.selMarca.value = r.marca.id;
    onMarca();
    // DESPUÉS de onMarca, que la limpia: es el año que viene de la base y tiene
    // que sobrevivir hasta que se elija la versión (ahí recién existe el campo)
    state.anioRegistro = datos.year || null;
    const modelos = [...r.marca.modelos].sort((a, b) => a.nombre.localeCompare(b.nombre, "es", { numeric: true }));
    el.selModelo.value = String(modelos.indexOf(r.modelo));
    onModelo();

    // onModelo() ya armó los años y, si el registro trae uno que el catálogo
    // cubre, lo dejó elegido — y con eso filtró las versiones. Por eso acá solo
    // queda poner la versión, y solo si sobrevivió a ese filtro.
    if (r.version) {
      const idx = String(r.modelo.versiones.indexOf(r.version));
      if ([...el.selVersion.options].some((o) => o.value === idx)) {
        el.selVersion.value = idx;
        await onVersion();
      }
    }
    marcarPendiente(el.selVersion, !state.version);
    marcarPendiente(el.selAnio, modeloUsaAnios() && !state.anio);
  }

  // traduce la respuesta del registro al catálogo y deja el selector puesto
  async function aplicarDatosRegistro(datos) {
    const desc = [datos.make, datos.model, datos.year].filter(Boolean).join(" ");
    const r = resolverVehiculo(datos);

    if (!r.marca) {
      estadoPatente("warn", `El registro dice <b>${desc}</b>. Curifor no atiende esa marca, así que no hay pauta de mantención.`);
      return;
    }
    if (!r.modelo) {
      estadoPatente("warn", `El registro dice <b>${desc}</b>. La marca sí la atendemos, pero ese modelo no está en el catálogo de pautas: elígelo abajo si corresponde a otro nombre.`);
      el.selMarca.value = r.marca.id;
      onMarca();
      return;
    }

    await aplicarVehiculo(r, datos);

    // Si el año del vehículo no está en el catálogo, aplicarAnioDelRegistro() ya
    // lo explicó con el detalle de los años que sí hay. Pisar ese aviso con un
    // "elige entre las 21 versiones" sería mentir: para ese año no hay ninguna.
    if (state.anioFueraDeCatalogo) return;

    const partes = [`<b>${desc}</b>`];
    // cuántas versiones quedan DESPUÉS de filtrar por año (no el total del modelo)
    const disponibles = [...el.selVersion.options].filter((o) => o.value !== "").length;
    if (state.version) {
      partes.push("Vehículo completo, ya puedes ver el plan.");
    } else if (modeloUsaAnios() && !state.anio) {
      partes.push("Elige el <b>año</b> para ver las versiones que corresponden.");
    } else {
      partes.push(`Falta la versión: elige entre las <b>${disponibles || r.candidatas.length}</b> de este año (el registro no la informa).`);
    }
    estadoPatente(state.version ? "ok" : "info", partes.join(" "));
  }

  async function buscarPorPatente() {
    const placa = normPat(el.inpPatente.value);
    el.inpPatente.value = placa;
    marcarPendiente(el.selVersion, false);
    marcarPendiente(el.selAnio, false);

    if (!placa) { el.patenteEstado.hidden = true; return; }
    if (!PATENTE_RE.test(placa)) {
      estadoPatente("error", "Esa patente no tiene un formato válido. Usa <b>BBCC12</b> o <b>AB1234</b>.");
      return;
    }

    /* Otra patente es otro auto y, casi siempre, otro dueño: arrastrar el
       cliente anterior terminaría con una cotización a nombre de quien no es.
       Si es la MISMA patente se conserva, para no borrar lo que el asesor
       acaba de escribir a mano solo porque volvió a apretar Buscar. */
    if (state.clientePat && state.clientePat !== placa) {
      state.cliente = null;
      state.vehReg = null;
    }
    state.clientePat = placa;

    el.btnPatente.disabled = true;
    el.inpPatente.disabled = true;
    estadoPatente("info", "Consultando el registro…");
    try {
      let datos = cachePatente.get(placa);
      if (!datos) {
        datos = await consultarPatente(placa);
        cachePatente.set(placa, datos);
      }
      state.vehReg = { vin: datos.vin || null, km: datos.km != null ? datos.km : null };
      // Lo que el asesor escribió a mano manda sobre el registro: si está
      // corrigiendo un dato viejo, la corrección es el dato bueno.
      if (datos.cliente && (!state.cliente || state.cliente.fuente !== "manual")) {
        state.cliente = {
          nombre: datos.cliente.nombre || "",
          rut: datos.cliente.rut ? formatearRut(datos.cliente.rut) : "",
          fono: datos.cliente.fono || "",
          email: datos.cliente.email || "",
          fuente: "registro",
        };
      }
      pintarCliente();
      await aplicarDatosRegistro(datos);
    } catch (e) {
      pintarCliente();
      if (e && e.codigo === "SIN_KEY") {
        estadoPatente("error", "La consulta por patente no está configurada en esta instalación (falta la API key). Elige el vehículo del catálogo.");
      } else if (e && (e.codigo === "MISSING_API_KEY" || e.codigo === "INVALID_API_KEY")) {
        estadoPatente("error", "La API key del registro no es válida o está vencida. Avisa a Sistemas.");
      } else if (e && (e.codigo === "NOT_FOUND" || e.codigo === "PLATE_NOT_FOUND")) {
        // Pasa siempre con autos nuevos y con primeras visitas. Se dice qué
        // hacer, porque cotizar igual es lo normal, no la excepción.
        estadoPatente("warn", `La patente <b>${placa}</b> no está en el registro de Curifor. ` +
          `Elige el vehículo del catálogo; los datos del cliente los escribes al descargar el PDF.`);
      } else {
        estadoPatente("error", "No pudimos consultar el registro en este momento. Elige el vehículo del catálogo.");
      }
    } finally {
      el.btnPatente.disabled = false;
      el.inpPatente.disabled = false;
    }
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
    pintarNotas();
    pintarCliente();
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
    state.extras.clear();   // los extras se ofrecen de nuevo con cada vehículo
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
  // Precio unitario oficial de un item. El precio vive en la lista de precios de
  // la empresa, así que vale aunque el repuesto no tenga stock: sin existencias
  // se cotiza igual, solo que se pide. Orden: SKU elegido -> registro del código
  // de la pauta -> null (ahí manda el valor de la pauta).
  function unitarioDe(it, idx) {
    const u = precioUnit(skuActivo(it, idx));
    if (u != null) return u;
    return it.codigo ? precioUnit(stockDe(it.codigo)) : null;
  }
  // subtotal de un item: unitario oficial × cantidad; si no hay, valor de la pauta
  function subtotalItem(it, idx) {
    const unit = unitarioDe(it, idx);
    if (unit != null && it.cantidad) return Math.round(unit * it.cantidad);
    return it.subtotal || 0;   // respaldo: precio de la pauta (materiales, sin cantidad, o s/d)
  }

  /* ---- cotización parcial ----
     El cliente pide "la mantención de 40 mil, pero sin cambiar el filtro de
     aire". Hasta ahora eso obligaba a cotizar mentalmente y decirle un número
     a mano; acá se destilda el item y el total se rehace solo. */
  function excluidosDe(itv) {
    const k = String(itv && itv.n);
    if (!state.excluidos[k]) state.excluidos[k] = {};
    return state.excluidos[k];
  }
  function estaExcluido(itv, clave) {
    return !!excluidosDe(itv)[clave];
  }
  function alternarItem(itv, clave, incluir) {
    const ex = excluidosDe(itv);
    if (incluir) delete ex[clave]; else ex[clave] = true;
    pintarDetalle();
  }
  // cuántos items tiene la revisión y cuántos quedaron dentro
  function conteoItems(itv) {
    const items = (itv && itv.items) || [];
    const ex = excluidosDe(itv);
    let dentro = items.filter((_, i) => !ex[i]).length;
    let total = items.length;
    if (itv && itv.manoObra) { total++; if (!ex.__mo) dentro++; }
    return { dentro, total, parcial: dentro < total };
  }
  // total de un intervalo con SKU principal (para el carrusel), según modo
  function totalIntervalo(itv) {
    if (itv.gratis) return 0;
    if (!(itv.items && itv.items.length)) return itv.totalConIva || 0;
    let t = 0;
    itv.items.forEach((it) => {
      const unit = precioUnit((skusDe(it) || [])[0] || null) ??
                   (it.codigo ? precioUnit(stockDe(it.codigo)) : null);
      t += (unit != null && it.cantidad) ? Math.round(unit * it.cantidad) : (it.subtotal || 0);
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
        const fuera = estaExcluido(itv, idx);
        if (!fuera) total += sub;
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
        // La casilla va primero: es lo que el asesor busca con el cliente al
        // teléfono, y tenerla al final de la fila obliga a leer todo antes.
        const chk = `<label class="dg-chk"><input type="checkbox" class="chk-item" data-clave="${idx}"` +
                    `${fuera ? "" : " checked"} title="Incluir en la cotización"></label>`;
        filas.push(`<tr class="${fuera ? "dg-fuera" : ""}"><td class="dg-nombre">${chk}` +
                   `<span class="dg-txt">${it.nombre}${cod}${extra}</span></td>` +
                   `${celdaStock}<td>${money(sub)}</td></tr>`);
      }
    }
    if (itv.manoObra) {
      const moFuera = estaExcluido(itv, "__mo");
      if (!moFuera) total += itv.manoObra;
      filas.push(`<tr><td class="dg-cat" colspan="3">Mano de obra</td></tr>`);
      // La mano de obra viene de la pauta para la revisión COMPLETA, así que no
      // se prorratea al sacar items: inventar una fracción sería peor que
      // dejarla y que el asesor decida sacarla entera si corresponde.
      filas.push(`<tr class="${moFuera ? "dg-fuera" : ""}"><td class="dg-nombre">` +
        `<label class="dg-chk"><input type="checkbox" class="chk-item" data-clave="__mo"` +
        `${moFuera ? "" : " checked"} title="Incluir en la cotización"></label>` +
        `<span class="dg-txt">Mano de obra${itv.horas ? " (" + itv.horas + " h)" : ""}` +
        `<span class="dg-cod">valor de la pauta para la revisión completa</span></span></td>` +
        `<td></td><td>${money(itv.manoObra)}</td></tr>`);
    }
    if (!filas.length) {
      filas.push(`<tr><td class="dg-nombre" colspan="3" style="color:var(--ink-3);font-style:italic">El valor corresponde al precio total sugerido de la mantención.</td></tr>`);
      total = itv.gratis ? 0 : (itv.totalConIva || 0);
    }
    const modoTxt = state.modo === "particular" ? "particular" : "interno";
    // Si se sacó algo, se dice ANTES del total: un número más bajo sin
    // explicación es lo que después se convierte en un reclamo.
    const cuenta = conteoItems(itv);
    if (cuenta.parcial) {
      filas.push(`<tr class="dg-parcial"><td colspan="3">` +
        `<b>Cotización parcial:</b> ${cuenta.dentro} de ${cuenta.total} items. ` +
        `Los destildados no se cobran y no se preparan.` +
        `<button type="button" class="dg-todos">Volver a la mantención completa</button></td></tr>`);
    }
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
    // casillas de la cotización parcial
    el.detDesglose.querySelectorAll(".chk-item").forEach((chk) => {
      chk.addEventListener("change", () => {
        const c = chk.dataset.clave;
        alternarItem(itv, c === "__mo" ? "__mo" : +c, chk.checked);
      });
    });
    const btnTodos = el.detDesglose.querySelector(".dg-todos");
    if (btnTodos) btnTodos.addEventListener("click", () => {
      state.excluidos[String(itv.n)] = {};
      pintarDetalle();
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

    // los extras de venta cruzada van siempre, así que el bloque nunca se oculta
    el.adicionalesBox.hidden = false;
    el.detAdicionales.hidden = !adics.length;
    el.detAdicionales.innerHTML = adics.map((a, i) =>
      `<li><label><input type="checkbox" data-precio="${a.precio}" data-i="${i}"><span>${a.nombre}</span></label><span class="add-precio">${money(a.precio)}</span></li>`
    ).join("");
    el.detAdicionales.querySelectorAll("input").forEach((chk) => chk.addEventListener("change", () => recalcularTotal(itv)));
    pintarExtras(itv);
    recalcularTotal(itv);
  }

  // ---- extras de venta cruzada (Airlife / NitroSafe) ----
  function pintarExtras(itv) {
    el.extrasVenta.innerHTML = EXTRAS.map((x) => {
      const on = state.extras.has(x.id);
      return `<button type="button" class="extra${on ? " is-on" : ""}" data-extra="${x.id}" aria-pressed="${on}">
          <span class="extra__info">
            <span class="extra__nombre">${x.nombre}</span>
            <span class="extra__detalle">${x.detalle}</span>
          </span>
          <span class="extra__precio">${money(x.precio)} <small>+ IVA</small></span>
          <span class="extra__cta">${on ? "Agregado ✓" : "+ Agregar"}</span>
        </button>`;
    }).join("");
    el.extrasVenta.querySelectorAll(".extra").forEach((btn) => btn.addEventListener("click", () => {
      const id = btn.dataset.extra;
      if (state.extras.has(id)) state.extras.delete(id); else state.extras.add(id);
      pintarExtras(itv);
      recalcularTotal(itv);
    }));
  }

  // Extras agregados -> [{nombre, precio}] (neto)
  function extrasElegidos() {
    return EXTRAS.filter((x) => state.extras.has(x.id)).map((x) => ({ nombre: x.nombre, precio: x.precio }));
  }
  const sumaExtras = () => extrasElegidos().reduce((t, x) => t + x.precio, 0);

  function recalcularTotal(itv) {
    let extra = 0;
    el.detAdicionales.querySelectorAll("input:checked").forEach((c) => (extra += +c.dataset.precio));
    extra += sumaExtras();
    el.adicionalesTotalBox.hidden = extra === 0;   // solo aparece si se agregó algo
    const base = itv.gratis ? 0 : (state.totalCalc || 0);
    const t = base + extra;
    el.totalConAdicionales.innerHTML =
      `${money(t)} <span class="add-iva">(${money(conIva(t))} con IVA)</span>`;
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
    state.anioRegistro = null;
    state.anioFueraDeCatalogo = false;
    reset(el.selModelo, "Elige el modelo");
    reset(el.selVersion, "Elige la versión");
    reset(el.selAnio, "Elige el modelo primero");
    el.selMarca.value = "";
    el.inpPatente.value = "";
    el.patenteEstado.hidden = true;
    // "Nueva consulta" es otro cliente en el mesón: se va todo, incluido lo que
    // se escribió a mano. Dejarlo pegado sería peor que perderlo.
    state.cliente = null;
    state.clientePat = null;
    state.vehReg = null;
    pintarCliente();
    marcarPendiente(el.selVersion, false);
    marcarPendiente(el.selAnio, false);
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

    // adicionales seleccionados (de la pauta + extras de venta cruzada)
    const adicSel = [];
    el.detAdicionales.querySelectorAll("input:checked").forEach((c) => {
      const li = c.closest("li");
      adicSel.push({ nombre: li.querySelector("span").textContent, precio: +c.dataset.precio });
    });
    adicSel.push(...extrasElegidos());

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
      // el año del plan; si la pauta no distingue años, el del vehículo, que
      // igual le sirve a la recepción
      anio: state.anio || state.anioRegistro || null,
      // La patente que el asesor ya escribió acá. Sin esto, en la agenda tenía
      // que volver a escribirla y a esperar el autocompletado, que es
      // exactamente el doble trabajo que este botón viene a evitar.
      patente: normPat(el.inpPatente.value) || null,
      km: itv.km || null,
      revN: itv.n,
      valor: itv.gratis ? sumaExtras() : ((state.totalCalc || 0) + sumaExtras()) || null,
      extras: extrasElegidos().map((x) => x.nombre),
      /* Lo que el cliente NO quiso. Viaja a la agenda y de ahí a la recepción:
         sin esto, bodega prepararía el kit completo y el cliente terminaría
         discutiendo un cobro que nadie le hizo. Van los NOMBRES y no los
         índices porque al otro lado no existe esta lista de items. */
      excluidos: excluidosNombres(itv),
      /* Solo el cliente ESCRITO A MANO. El que sale del registro no hace falta
         mandarlo: la agenda lo busca sola por patente y lo trae igual. El que
         se tipeó acá, en cambio, no existe en ninguna base, y sin esto el
         asesor tendría que escribir el mismo nombre y el mismo teléfono dos
         veces con dos minutos de diferencia. */
      cliente: (state.cliente && state.cliente.fuente === "manual") ? state.cliente : null,
      ts: Date.now(),
    };
    try { localStorage.setItem("curiforTallerPrefill", JSON.stringify(pre)); } catch (e) { /* sin storage */ }
    location.href = "taller.html";
  }

  // Nombres de lo que quedó fuera, para que se entienda en el taller.
  function excluidosNombres(itv) {
    const ex = excluidosDe(itv);
    const items = itv.items || [];
    const out = items.filter((_, i) => ex[i]).map((it) => it.nombre);
    if (ex.__mo) out.push("Mano de obra");
    return out;
  }

  // ---- utilidades ----
  function etiquetaKm(km) {
    if (km >= 1000) return (km / 1000).toLocaleString("es-CL") + ".000 km";
    return km.toLocaleString("es-CL") + " km";
  }

  document.addEventListener("DOMContentLoaded", init);
})();
