/* ============================================================
   Sistema de Taller y Agendamiento Curifor
   - Persistencia: localStorage (por navegador/estación).
   - Catálogo vehículos, pautas y stock: mismos JSON del Cotizador.
   - Flujo: Agendamiento → Status → Recepción → JPCB/Planificador → Bodega.
   ============================================================ */
"use strict";

/* ---------------- constantes ---------------- */
var TKEY = "curiforTaller_v1";
var PREKEY = "curiforTallerPrefill";

var CLPF = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
function money(n) { return n == null ? "—" : CLPF.format(Math.round(n)); }

var TIPOS = {
  mant: { cls: "mant", color: "#fbe0ea", label: "Mantención" },
  rep:  { cls: "rep",  color: "#e2f2da", label: "Reparación" },
  diag: { cls: "diag", color: "#ecdff7", label: "Diagnóstico" },
  ext:  { cls: "ext",  color: "#ddeafc", label: "Extensión de tiempo" }
};
var START = 8 * 60 + 40, END = 18 * 60, STEP = 10, COLW = 42;
var TECNICOS = ["Cristian García", "Esteban Martínez", "Eugenio Pacheco", "Felipe Córdova", "Héctor Andrade", "José Acevedo", "Lavador Linderos"];
var ASESORES = ["Matías Figueroa", "Eduardo Ortiz"];
var ETAPAS = [
  { id: "citas_hoy", t: "Citas de hoy" }, { id: "esp_serv", t: "En espera por servicio" },
  { id: "proximo", t: "Próximo trabajo" }, { id: "bajo_serv", t: "Bajo servicio" },
  { id: "esp_insp", t: "En espera por inspección" }, { id: "esp_lav", t: "Esperando por lavado" },
  { id: "esp_fact", t: "En espera por facturación" }, { id: "esp_pago", t: "En espera por pago", final: true }
];
var STOPS = [
  { id: "decision", t: "Esperando decisión" }, { id: "aprob", t: "Esperando aprobación" },
  { id: "repuestos", t: "Esperando repuestos" }, { id: "terceros", t: "Esperando terceros (sublet)" }
];
var PREP = [
  { id: "d3", t: "3 días antes" }, { id: "d2", t: "2 días antes" }, { id: "d1", t: "1 día antes" },
  { id: "ped", t: "Repuestos pedidos" }, { id: "rec", t: "Repuestos recibidos" }
];
var AGAM = ["08:40", "09:00", "09:20", "09:40", "10:00", "10:20", "10:40", "11:00", "11:20", "11:40", "12:00", "12:20", "12:40"];
var AGPM = ["14:00", "14:20", "14:40", "15:00", "15:20", "15:40", "16:00", "16:20", "16:40", "17:00"];
var AGACC = ["Tag", "Sello verde", "Llaves", "Cono/tapas", "Patentes", "Gata", "Manivela", "Rueda Rpto.", "Extintor", "Documentos", "Pisos", "Encendedor", "Llave rueda", "Botiquín", "Antena", "Radio", "Parlantes", "Triángulos", "Herramientas", "CD"];
var AGFOTOS = ["Frente Izq", "Frente Der", "Posterior Izq", "Posterior Der", "Tapiz", "Parabrisas", "Tablero", "Adicional"];

function hhmm(m) { return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"); }
function parseHM(t) { var a = t.split(":"); return (+a[0]) * 60 + (+a[1]); }
function etiquetaKm(km) { return km >= 1000 ? (km / 1000).toLocaleString("es-CL") + ".000 km" : km + " km"; }
function hoyISO() { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function fmtFechaLarga(iso) {
  var d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}
function fmtFechaCorta(iso) {
  var d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("es-CL", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/* ---------------- estado persistente ---------------- */
var DB = { agendamientos: [], orders: [], ocSeq: 1190001, roSeq: 60 };
function cargarDB() {
  try {
    var raw = localStorage.getItem(TKEY);
    if (raw) { var d = JSON.parse(raw); if (d && d.agendamientos && d.orders) DB = d; }
  } catch (e) { /* estado corrupto: se parte de cero */ }
}
function save() { try { localStorage.setItem(TKEY, JSON.stringify(DB)); } catch (e) { /* sin espacio */ } }

/* ---------------- catálogo del cotizador ---------------- */
var INDICE = null, STOCK = null, PAUTAS = {};
function normCod(c) { return c == null ? "" : String(c).toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function stockDe(codigo) {
  if (!STOCK || !codigo) return null;
  return STOCK.items[normCod(codigo)] || null;
}
function stkHTML(codigo) {
  if (!STOCK) return "";
  var s = stockDe(codigo);
  if (!s) return '<span class="stk sd">s/d</span>';
  var c = s.c || 0, f = s.f || 0;
  if (c > 0) return '<span class="stk ok" title="Stock Curifor">' + c.toLocaleString("es-CL") + " u.</span>";
  if (f > 0) return '<span class="stk fro" title="Stock en giro Frontera">' + f.toLocaleString("es-CL") + " u. Front.</span>";
  return '<span class="stk no">Sin stock</span>';
}
function pautaCargada(id) { return id && PAUTAS[id] ? PAUTAS[id] : null; }
function cargarPauta(id) {
  if (!id) return Promise.resolve(null);
  if (PAUTAS[id]) return Promise.resolve(PAUTAS[id]);
  return fetch("data/pautas/" + id + ".json")
    .then(function (r) { if (!r.ok) throw new Error("pauta"); return r.json(); })
    .then(function (j) { PAUTAS[id] = j; return j; })
    .catch(function () { return null; });
}
function precargarPautas() {
  var ids = {};
  DB.orders.forEach(function (o) { if (o.pautaId) ids[o.pautaId] = 1; });
  DB.agendamientos.forEach(function (a) { if (a.pautaId) ids[a.pautaId] = 1; });
  return Promise.all(Object.keys(ids).map(cargarPauta));
}
function planDe(p, anio) {
  if (!p || !p.planes || !p.planes.length) return null;
  if (p.anios && p.anios.length && anio) {
    for (var i = 0; i < p.planes.length; i++) if (String(p.planes[i].anio) === String(anio)) return p.planes[i];
  }
  return p.planes[0];
}
function intervaloDe(o) {
  var p = pautaCargada(o.pautaId);
  if (!p) return null;
  var plan = planDe(p, o.anio);
  if (!plan || !plan.intervalos) return null;
  var itvs = plan.intervalos, i;
  if (o.revN != null) { for (i = 0; i < itvs.length; i++) if (String(itvs[i].n) === String(o.revN)) return itvs[i]; }
  if (o.km) { for (i = 0; i < itvs.length; i++) if (String(itvs[i].km) === String(o.km)) return itvs[i]; }
  return null;
}
function getRepuestos(o) {
  var itv = intervaloDe(o);
  if (!itv || !itv.items) return [];
  return itv.items.filter(function (it) { return it.codigo; })
    .map(function (it) { return { codigo: it.codigo, desc: it.nombre, cant: it.cantidad || 1 }; });
}
function valorRefDe(o) {
  if (o.valorRef != null) return o.valorRef;
  var itv = intervaloDe(o);
  if (!itv) return null;
  if (itv.gratis) return 0;
  var t = 0;
  (itv.items || []).forEach(function (it) { t += it.subtotal || 0; });
  t += itv.manoObra || 0;
  return t || itv.totalConIva || null;
}
function valorItv(itv) {
  if (!itv) return null;
  if (itv.gratis) return 0;
  var t = 0;
  (itv.items || []).forEach(function (it) { t += it.subtotal || 0; });
  t += itv.manoObra || 0;
  return t || itv.totalConIva || null;
}
function horasAMin(h) {
  var n = parseFloat(String(h == null ? "" : h).replace(",", "."));
  return isNaN(n) || n <= 0 ? null : Math.round(n * 60);
}
function servicioDesc(o) {
  return (o.tipo === "mant" && o.km) ? "Mantención " + etiquetaKm(o.km) : TIPOS[o.tipo].label;
}
function mapTipo(s) {
  s = (s || "").toUpperCase();
  if (s.indexOf("MANTEN") >= 0) return "mant";
  if (s.indexOf("DIAGN") >= 0) return "diag";
  if (s.indexOf("RECALL") >= 0) return "ext";
  return "rep";
}
function byRo(ro) { return DB.orders.find(function (o) { return o.ro === ro; }); }
function agFind(oc) { return DB.agendamientos.find(function (a) { return String(a.oc) === String(oc); }); }
function ordersActivas() { return DB.orders.filter(function (o) { return o.etapa !== "entregado"; }); }

/* ---------------- navegación de pestañas ---------------- */
function agGoTab(v) {
  document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
  document.querySelectorAll(".view").forEach(function (x) { x.classList.remove("active"); });
  var tabEl = document.querySelector('.tab[data-v="' + v + '"]');
  if (tabEl) tabEl.classList.add("active");
  document.getElementById("v-" + v).classList.add("active");
  if (v === "agenda") { renderCal(); renderSlots(); renderAgendaTable(); }
  if (v === "reportes") renderReportes();
  window.scrollTo(0, 0);
}

/* ============================================================
   1 · AGENDAMIENTO — calendario real + slots
   ============================================================ */
var hoy = new Date();
var calY = hoy.getFullYear(), calM = hoy.getMonth();
var selFecha = hoyISO();

function fechasConAgenda() {
  var s = {};
  DB.agendamientos.forEach(function (a) { s[a.fecha] = 1; });
  return s;
}
function renderCal() {
  var titulo = new Date(calY, calM, 1).toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  document.getElementById("calTitulo").textContent = titulo;
  var primero = new Date(calY, calM, 1);
  var dias = new Date(calY, calM + 1, 0).getDate();
  var dow = (primero.getDay() + 6) % 7; // lunes = 0
  var marcadas = fechasConAgenda();
  var hoyStr = hoyISO();
  var html = "<tr><th>Lu</th><th>Ma</th><th>Mi</th><th>Ju</th><th>Vi</th><th>Sa</th><th>Do</th></tr><tr>";
  var celda = 0;
  for (var i = 0; i < dow; i++) { html += '<td class="off"></td>'; celda++; }
  for (var d = 1; d <= dias; d++) {
    var iso = calY + "-" + String(calM + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    var cls = [];
    if (iso === selFecha) cls.push("on");
    if (iso === hoyStr) cls.push("hoy");
    html += '<td class="' + cls.join(" ") + '" data-f="' + iso + '">' + d + (marcadas[iso] ? '<span class="dot"></span>' : "") + "</td>";
    celda++;
    if (celda % 7 === 0 && d < dias) html += "</tr><tr>";
  }
  while (celda % 7 !== 0) { html += '<td class="off"></td>'; celda++; }
  html += "</tr>";
  var grid = document.getElementById("calGrid");
  grid.innerHTML = html;
  grid.querySelectorAll("td[data-f]").forEach(function (td) {
    td.addEventListener("click", function () {
      selFecha = td.dataset.f;
      renderCal(); renderSlots(); renderAgendaTable();
    });
  });
}
function horasOcupadas() {
  var s = {};
  DB.agendamientos.forEach(function (a) { if (a.fecha === selFecha && a.estado !== "anulado") s[a.hora] = 1; });
  return s;
}
function renderSlots() {
  document.getElementById("fechaSelTxt").textContent = fmtFechaLarga(selFecha);
  var ocup = horasOcupadas();
  function fill(cont, arr) {
    cont.innerHTML = "";
    arr.forEach(function (h) {
      var busy = !!ocup[h];
      var d = document.createElement("div");
      d.className = "ag-slot " + (busy ? "busy" : "free");
      d.textContent = h;
      if (!busy) d.onclick = function () { agAbrirModal(h); };
      cont.appendChild(d);
    });
  }
  fill(document.getElementById("agSlotsAM"), AGAM);
  fill(document.getElementById("agSlotsPM"), AGPM);
}
function renderAgendaTable() {
  var t = document.getElementById("tblAgenda");
  var lista = DB.agendamientos.filter(function (a) { return a.fecha === selFecha; })
    .sort(function (a, b) { return a.hora < b.hora ? -1 : 1; });
  if (!lista.length) {
    t.innerHTML = '<tr><td colspan="8" style="color:var(--ink-3);padding:16px">Sin agendamientos para esta fecha.</td></tr>';
    return;
  }
  t.innerHTML = lista.map(function (a) {
    var est = a.estado === "agendado" ? '<span class="ag-pill por">Agendado</span>'
      : a.estado === "en_taller" ? '<span class="ag-pill en">En taller</span>'
      : '<span class="ag-pill ent">Entregado</span>';
    var acc = a.estado === "agendado"
      ? '<button class="agbtn agbtn-blue agbtn-sm" onclick="agAbrirRecepcion(' + a.oc + ')">Ingresar</button>' +
        ' <button class="agbtn agbtn-red agbtn-sm" onclick="agAnular(' + a.oc + ')">Anular</button>'
      : "";
    return "<tr><td>" + a.oc + "</td><td>" + a.hora + "</td><td>" + (a.cli || "—") + "</td><td>" +
      (a.marcaNombre || "") + " " + (a.modeloNombre || "") + "</td><td>" + a.pat + "</td><td>" + a.serv + "</td><td>" + est + "</td><td>" + acc + "</td></tr>";
  }).join("");
}
function agAnular(oc) {
  var a = agFind(oc);
  if (!a) return;
  if (!confirm("¿Anular el agendamiento " + oc + " (" + a.pat + ")?")) return;
  DB.agendamientos = DB.agendamientos.filter(function (x) { return x !== a; });
  save();
  renderCal(); renderSlots(); renderAgendaTable();
}

/* ---------------- modal agendar (selects encadenados) ---------------- */
var MSEL = { marca: null, modelo: null, versionId: null, pauta: null };

function llenarMarcasModal() {
  var sel = document.getElementById("agMarca");
  if (!INDICE) return;
  var marcas = INDICE.marcas.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, "es"); });
  sel.innerHTML = '<option value="">Elige la marca</option>' +
    marcas.map(function (m) { return '<option value="' + m.id + '">' + m.nombre + "</option>"; }).join("");
}
function llenarAsesores() {
  document.getElementById("agAsesor").innerHTML = '<option value="">— Seleccione —</option>' +
    ASESORES.map(function (a) { return "<option>" + a + "</option>"; }).join("");
}
function onMarcaModal() {
  var id = document.getElementById("agMarca").value;
  MSEL.marca = INDICE ? INDICE.marcas.find(function (m) { return m.id === id; }) : null;
  MSEL.modelo = null; MSEL.versionId = null; MSEL.pauta = null;
  var selMod = document.getElementById("agModeloSel");
  var selVer = document.getElementById("agVersionSel");
  selVer.innerHTML = '<option value="">Elige la versión</option>'; selVer.disabled = true;
  resetAnioMant();
  if (!MSEL.marca) { selMod.innerHTML = '<option value="">Elige el modelo</option>'; selMod.disabled = true; return; }
  var modelos = MSEL.marca.modelos.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, "es", { numeric: true }); });
  selMod.innerHTML = '<option value="">Elige el modelo</option>' +
    modelos.map(function (m, i) { return '<option value="' + i + '">' + m.nombre + "</option>"; }).join("");
  selMod.disabled = false;
  MSEL._modelos = modelos;
}
function onModeloModal() {
  var i = document.getElementById("agModeloSel").value;
  MSEL.modelo = (MSEL._modelos && i !== "") ? MSEL._modelos[+i] : null;
  MSEL.versionId = null; MSEL.pauta = null;
  resetAnioMant();
  var selVer = document.getElementById("agVersionSel");
  if (!MSEL.modelo) { selVer.innerHTML = '<option value="">Elige la versión</option>'; selVer.disabled = true; return; }
  selVer.innerHTML = '<option value="">Elige la versión</option>' +
    MSEL.modelo.versiones.map(function (v) { return '<option value="' + v.id + '">' + v.nombre + "</option>"; }).join("");
  selVer.disabled = false;
}
function onVersionModal() {
  MSEL.versionId = document.getElementById("agVersionSel").value || null;
  MSEL.pauta = null;
  resetAnioMant();
  if (!MSEL.versionId) return;
  cargarPauta(MSEL.versionId).then(function (p) {
    MSEL.pauta = p;
    var selA = document.getElementById("agAnioSel");
    if (p && p.anios && p.anios.length) {
      selA.innerHTML = '<option value="">Elige el año</option>' + p.anios.map(function (a) { return "<option>" + a + "</option>"; }).join("");
      selA.disabled = false;
    } else {
      selA.innerHTML = '<option value="">—</option>';
      selA.disabled = true;
    }
    llenarMantModal();
  });
}
function resetAnioMant() {
  var selA = document.getElementById("agAnioSel");
  selA.innerHTML = '<option value="">—</option>'; selA.disabled = true;
  var selM = document.getElementById("agMantSel");
  selM.innerHTML = '<option value="">—</option>'; selM.disabled = true;
  document.getElementById("agValorRef").hidden = true;
}
function llenarMantModal() {
  var selM = document.getElementById("agMantSel");
  var esMant = document.getElementById("agServicio").value.indexOf("MANTEN") >= 0;
  document.getElementById("agValorRef").hidden = true;
  if (!MSEL.pauta || !esMant) { selM.innerHTML = '<option value="">—</option>'; selM.disabled = true; return; }
  var plan = planDe(MSEL.pauta, document.getElementById("agAnioSel").value || null);
  var itvs = (plan && plan.intervalos) ? plan.intervalos : [];
  selM.innerHTML = '<option value="">Elige la mantención</option>' + itvs.map(function (itv) {
    var et = itv.km ? etiquetaKm(itv.km) : (itv.etiqueta || "Entrega");
    var val = itv.gratis ? "sin costo" : money(valorItv(itv));
    return '<option value="' + itv.n + '">Rev. ' + itv.n + " — " + et + " (" + val + ")</option>";
  }).join("");
  selM.disabled = false;
}
function onMantModal() {
  var box = document.getElementById("agValorRef");
  var n = document.getElementById("agMantSel").value;
  if (!MSEL.pauta || n === "") { box.hidden = true; return; }
  var plan = planDe(MSEL.pauta, document.getElementById("agAnioSel").value || null);
  var itv = (plan && plan.intervalos || []).find(function (x) { return String(x.n) === String(n); });
  if (!itv) { box.hidden = true; return; }
  var v = valorItv(itv);
  box.hidden = false;
  box.textContent = "Valor referencial de la mantención: " + (itv.gratis ? "Sin costo" : money(v) + " neto s/IVA") +
    (itv.horas ? " · " + itv.horas + " h de mano de obra" : "");
}

function agAbrirModal(h) {
  var ov = document.getElementById("agOv");
  ov.dataset.hora = h;
  document.getElementById("agHora").textContent = "· " + h + " · " + fmtFechaCorta(selFecha);
  // limpiar formulario
  ["agPatente", "agVin", "agCliente", "agRut", "agFono", "agEmail"].forEach(function (id) { document.getElementById(id).value = ""; });
  document.getElementById("agServicio").value = "MANTENCIÓN POR KILOMETRAJE";
  document.getElementById("agMarca").value = "";
  onMarcaModal();
  // prellenado desde el cotizador
  if (PREFILL) aplicarPrefill();
  ov.classList.add("open");
}
function agCerrarModal() { document.getElementById("agOv").classList.remove("open"); }

function agGuardar() {
  var esMant = document.getElementById("agServicio").value.indexOf("MANTEN") >= 0;
  var pat = document.getElementById("agPatente").value.trim().toUpperCase();
  if (!pat) { alert("Ingresa la patente del vehículo."); return; }
  if (!MSEL.marca || !MSEL.modelo) { alert("Selecciona la marca y el modelo del vehículo."); return; }
  if (esMant && (!MSEL.versionId || document.getElementById("agMantSel").value === "")) {
    alert("Para una mantención por kilometraje selecciona la versión y la mantención (km)."); return;
  }
  var revN = null, km = null, valorRef = null, anio = document.getElementById("agAnioSel").value || null;
  if (esMant && MSEL.pauta) {
    revN = document.getElementById("agMantSel").value;
    var plan = planDe(MSEL.pauta, anio);
    var itv = (plan && plan.intervalos || []).find(function (x) { return String(x.n) === String(revN); });
    if (itv) { km = itv.km || null; valorRef = valorItv(itv); }
  }
  var verSel = document.getElementById("agVersionSel");
  var a = {
    oc: DB.ocSeq++,
    fecha: selFecha,
    hora: document.getElementById("agOv").dataset.hora,
    sucursal: document.getElementById("fComercio").value,
    serv: document.getElementById("agServicio").value,
    pat: pat,
    marcaNombre: MSEL.marca.nombre,
    modeloNombre: MSEL.modelo.nombre,
    versionNombre: MSEL.versionId ? verSel.options[verSel.selectedIndex].text : null,
    pautaId: MSEL.versionId || null,
    anio: anio, km: km, revN: revN, valorRef: valorRef,
    vin: document.getElementById("agVin").value.trim() || null,
    cli: document.getElementById("agCliente").value.trim() || "Cliente",
    rut: document.getElementById("agRut").value.trim() || null,
    fono: document.getElementById("agFono").value.trim() || null,
    email: document.getElementById("agEmail").value.trim() || null,
    asesor: document.getElementById("agAsesor").value || null,
    estado: "agendado"
  };
  DB.agendamientos.push(a);
  save();
  if (PREFILL) { localStorage.removeItem(PREKEY); PREFILL = null; renderPrefillBanner(); }
  agCerrarModal();
  renderCal(); renderSlots(); renderAgendaTable();
  alert("Agendamiento " + a.oc + " creado para el " + fmtFechaCorta(a.fecha) + " a las " + a.hora + ".\nUsa el botón “Ingresar” en la tabla de Agendamiento para abrir su recepción.");
}

/* ---------------- prellenado desde el cotizador ---------------- */
var PREFILL = null;
function cargarPrefill() {
  try {
    var raw = localStorage.getItem(PREKEY);
    if (!raw) return;
    var p = JSON.parse(raw);
    if (p && p.pautaId && Date.now() - (p.ts || 0) < 12 * 60 * 60 * 1000) PREFILL = p;
    else localStorage.removeItem(PREKEY);
  } catch (e) { /* ignorar */ }
}
function renderPrefillBanner() {
  var b = document.getElementById("prefillBanner");
  if (!PREFILL) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = "📋 Cotización lista para agendar: <b>" + PREFILL.marcaNombre + " " + PREFILL.modelo +
    " · " + PREFILL.version + "</b> — Rev. " + PREFILL.revN + (PREFILL.km ? " · " + etiquetaKm(PREFILL.km) : "") +
    (PREFILL.valor != null ? " · " + money(PREFILL.valor) : "") +
    ". Elige una <b>hora libre</b> en el calendario para completar el agendamiento." +
    '<button class="agbtn agbtn-ghost agbtn-sm" onclick="descartarPrefill()">Descartar</button>';
}
function descartarPrefill() {
  localStorage.removeItem(PREKEY);
  PREFILL = null;
  renderPrefillBanner();
}
function aplicarPrefill() {
  if (!PREFILL || !INDICE) return;
  // ubicar marca/modelo/versión por pautaId
  var found = null;
  INDICE.marcas.forEach(function (m) {
    m.modelos.forEach(function (mo) {
      mo.versiones.forEach(function (v) { if (v.id === PREFILL.pautaId) found = { m: m, mo: mo, v: v }; });
    });
  });
  if (!found) return;
  document.getElementById("agServicio").value = "MANTENCIÓN POR KILOMETRAJE";
  document.getElementById("agMarca").value = found.m.id;
  onMarcaModal();
  var idx = MSEL._modelos.findIndex(function (x) { return x.nombre === found.mo.nombre; });
  document.getElementById("agModeloSel").value = String(idx);
  onModeloModal();
  document.getElementById("agVersionSel").value = found.v.id;
  MSEL.versionId = found.v.id;
  cargarPauta(found.v.id).then(function (p) {
    MSEL.pauta = p;
    var selA = document.getElementById("agAnioSel");
    if (p && p.anios && p.anios.length) {
      selA.innerHTML = '<option value="">Elige el año</option>' + p.anios.map(function (a) { return "<option>" + a + "</option>"; }).join("");
      selA.disabled = false;
      if (PREFILL.anio) selA.value = String(PREFILL.anio);
    }
    llenarMantModal();
    if (PREFILL.revN != null) {
      document.getElementById("agMantSel").value = String(PREFILL.revN);
      onMantModal();
    }
  });
}

/* ============================================================
   Entrega del vehículo (desde el detalle de la orden en JPCB)
   ============================================================ */
function agEntregar(ro) {
  var o = byRo(ro);
  if (!o) return;
  if (!confirm("¿Registrar la entrega del vehículo " + o.pat + " (RO " + o.ro + ")?")) return;
  o.etapa = "entregado";
  var a = o.oc ? agFind(o.oc) : null;
  if (a) a.estado = "entregado";
  save();
  closeM();
  renderAll();
  renderAgendaTable();
}

/* ============================================================
   2 · RECEPCIÓN
   ============================================================ */
var agRecSel = null;
function agAbrirRecepcion(oc) {
  agRecSel = agFind(oc);
  if (!agRecSel) return;
  document.getElementById("recVacia").hidden = true;
  var f = document.getElementById("recForm");
  f.hidden = false; f.classList.remove("hidden");
  document.getElementById("recTitulo").textContent = agRecSel.pat + " — " + agRecSel.marcaNombre + " " + agRecSel.modeloNombre;
  document.getElementById("recOC").textContent = agRecSel.oc;
  document.getElementById("recFecha").textContent = fmtFechaCorta(agRecSel.fecha) + " " + agRecSel.hora;
  document.getElementById("rcCliente").textContent = agRecSel.cli || "—";
  document.getElementById("rcRut").textContent = agRecSel.rut || "—";
  document.getElementById("rcFono").textContent = agRecSel.fono || "—";
  document.getElementById("rcEmail").textContent = agRecSel.email || "—";
  document.getElementById("rcPatente").textContent = agRecSel.pat;
  document.getElementById("rcModelo").textContent = agRecSel.marcaNombre + " " + agRecSel.modeloNombre + (agRecSel.versionNombre ? " · " + agRecSel.versionNombre : "");
  document.getElementById("rcAnio").textContent = agRecSel.anio || "—";
  document.getElementById("rcKm").textContent = agRecSel.km ? etiquetaKm(agRecSel.km) : "—";
  document.getElementById("rcServ").textContent = agRecSel.serv + (agRecSel.km ? " · " + etiquetaKm(agRecSel.km) : "");
  document.getElementById("rcValor").textContent = agRecSel.valorRef != null ? money(agRecSel.valorRef) + " neto s/IVA" : "—";
  var ag = document.getElementById("accGrid");
  ag.innerHTML = AGACC.map(function (a) { return '<label class="acc"><input type="checkbox"> ' + a + "</label>"; }).join("");
  var pw = document.getElementById("photoWrap");
  pw.innerHTML = AGFOTOS.map(function (fo) { return '<button class="photo-btn" type="button">' + fo + " 📷</button>"; }).join("");
  agGoTab("recep");
}
function agCancelarRecepcion() {
  agRecSel = null;
  document.getElementById("recForm").hidden = true;
  document.getElementById("recVacia").hidden = false;
  agGoTab("agenda");
}
function agIngresarTaller() {
  if (!agRecSel) return;
  var a = agRecSel;
  var itv = null;
  if (a.pautaId && pautaCargada(a.pautaId)) {
    var plan = planDe(pautaCargada(a.pautaId), a.anio);
    if (plan && plan.intervalos) itv = plan.intervalos.find(function (x) { return String(x.n) === String(a.revN); }) || null;
  }
  var tipo = mapTipo(a.serv);
  var dur = (itv && horasAMin(itv.horas)) || (tipo === "mant" ? 60 : tipo === "rep" ? 90 : 60);
  var o = {
    ro: String(DB.roSeq++).padStart(4, "0"),
    oc: a.oc,
    fecha: a.fecha,
    pat: a.pat, marca: a.marcaNombre, modelo: a.modeloNombre, version: a.versionNombre,
    anio: a.anio, km: a.km, revN: a.revN, pautaId: a.pautaId, valorRef: a.valorRef,
    vin: a.vin || "—", color: "—", cliente: a.cli, asesor: a.asesor,
    tipo: tipo, dur: dur, rec: a.hora, del: "—",
    tec: null, ini: null, etapa: "citas_hoy", stop: null,
    prep: "rec", picking: "pendiente"
  };
  DB.orders.push(o);
  a.estado = "en_taller";
  save();
  agRecSel = null;
  document.getElementById("recForm").hidden = true;
  document.getElementById("recVacia").hidden = false;
  alert("Recepción " + a.oc + " registrada.\n• Orden de trabajo RO " + o.ro + " creada\n• Publicada en JPCB → Citas de hoy" +
    (getRepuestos(o).length ? "\n• Kit de repuestos publicado en Bodega (pre-picking)" : "") +
    "\n(Integración con el ERP: pendiente)");
  renderAll();
  agGoTab("jpcb");
}

/* ============================================================
   Tarjetas + tableros (Prep / JPCB / Planificador)
   ============================================================ */
function cardHTML(o, ctx) {
  var corner = "";
  if (ctx === "prep" && getRepuestos(o).length) {
    corner = '<span class="pick ' + (o.picking === "listo" ? "listo" : "pend") + '">' + (o.picking === "listo" ? "REP. LISTO" : "REP.") + "</span>";
  } else if (o.stop) {
    var st = STOPS.find(function (s) { return s.id === o.stop; });
    corner = '<span class="stopflag">' + st.t.replace("Esperando ", "") + "</span>";
  }
  return '<div class="card-ot ' + TIPOS[o.tipo].cls + '" draggable="true" data-ro="' + o.ro + '" onclick="detalle(\'' + o.ro + '\')">' + corner +
    '<div><span class="ro">RO ' + o.ro + '</span> · <span class="pat">' + o.pat + "</span></div>" +
    '<div class="meta">' + o.marca + " " + o.modelo + " — " + servicioDesc(o) + "</div>" +
    '<div class="meta">Rec ' + o.rec + " · Entrega " + o.del + "</div></div>";
}
function wireCard(el) {
  el.addEventListener("dragstart", function (e) { e.dataTransfer.setData("ro", el.dataset.ro); el.classList.add("dragging"); });
  el.addEventListener("dragend", function () { el.classList.remove("dragging"); });
}
function wireDnD() {
  document.querySelectorAll(".card-ot").forEach(wireCard);
  function bind(sel, fn) {
    document.querySelectorAll(sel).forEach(function (z) {
      z.addEventListener("dragover", function (e) { e.preventDefault(); z.classList.add("over"); });
      z.addEventListener("dragleave", function () { z.classList.remove("over"); });
      z.addEventListener("drop", function (e) {
        e.preventDefault(); z.classList.remove("over");
        var o = byRo(e.dataTransfer.getData("ro"));
        if (o) { fn(o, z); save(); renderAll(); }
      });
    });
  }
  bind(".drop[data-etapa]", function (o, z) { o.etapa = z.dataset.etapa; o.stop = null; });
  bind(".drop[data-stop]", function (o, z) { o.stop = z.dataset.stop; });
  bind(".drop[data-prep]", function (o, z) { o.prep = z.dataset.prep; });
}
function renderJPCB() {
  var act = ordersActivas();
  document.getElementById("jpcbBoard").innerHTML = ETAPAS.map(function (et) {
    var l = act.filter(function (o) { return o.etapa === et.id; });
    return '<div class="col ' + (et.final ? "final" : "") + '"><h3>' + et.t + ' <span class="count">(' + l.length + ')</span></h3><div class="drop" data-etapa="' + et.id + '">' + l.map(function (o) { return cardHTML(o); }).join("") + "</div></div>";
  }).join("");
  document.getElementById("stopBoard").innerHTML = STOPS.map(function (s) {
    var l = act.filter(function (o) { return o.stop === s.id; });
    return '<div class="col"><h3>' + s.t + ' <span class="count">(' + l.length + ')</span></h3><div class="drop" data-stop="' + s.id + '">' + l.map(function (o) { return cardHTML(o); }).join("") + "</div></div>";
  }).join("");
  wireDnD();
}
function renderPrep() {
  var act = ordersActivas();
  document.getElementById("prepBoard").innerHTML = PREP.map(function (col) {
    var l = act.filter(function (o) { return o.prep === col.id; });
    return '<div class="col"><h3>' + col.t + ' <span class="count">(' + l.length + ')</span></h3><div class="drop" data-prep="' + col.id + '">' + l.map(function (o) { return cardHTML(o, "prep"); }).join("") + "</div></div>";
  }).join("");
  wireDnD();
}
function renderPlan() {
  document.getElementById("legendPlan").innerHTML = "<b>Tipo de trabajo:</b>" +
    Object.keys(TIPOS).map(function (k) { var t = TIPOS[k]; return '<div class="it"><span class="sw" style="background:' + t.color + '"></span>' + t.label + "</div>"; }).join("");
  var act = ordersActivas();
  var bl = document.getElementById("backlogDrop");
  var pend = act.filter(function (o) { return o.tec === null && o.etapa !== null; });
  bl.innerHTML = pend.map(function (o) { return cardHTML(o); }).join("") ||
    '<p style="color:var(--ink-3);font-size:12px;margin:4px">Sin órdenes por asignar.</p>';
  var g = document.getElementById("grid");
  var gh = '<thead><tr><th class="corner"></th>';
  for (var m = START; m < END; m += STEP) gh += '<th class="time">' + hhmm(m) + "</th>";
  gh += "</tr></thead><tbody>";
  TECNICOS.forEach(function (t, ti) {
    gh += '<tr><th class="tech">' + t + "</th>";
    for (var mm = START; mm < END; mm += STEP) gh += '<td class="slot" data-tec="' + ti + '" data-min="' + mm + '"></td>';
    gh += "</tr>";
  });
  g.innerHTML = gh + "</tbody>";
  act.filter(function (o) { return o.tec !== null && o.ini; }).forEach(function (o) {
    var cell = g.querySelector('td[data-tec="' + o.tec + '"][data-min="' + parseHM(o.ini) + '"]');
    if (!cell) return;
    var span = Math.max(o.dur / STEP, 1), d = document.createElement("div");
    d.className = "gblock";
    d.style.width = (span * COLW - 3) + "px";
    d.style.background = TIPOS[o.tipo].color;
    d.style.borderLeftColor = "#555";
    d.draggable = true; d.dataset.ro = o.ro;
    d.innerHTML = '<span class="gdur">' + hhmm(o.dur).replace(/^0/, "") + "</span><b>" + o.pat + "</b> " + (o.stop ? "⛔" : "") + "<br>" + o.modelo;
    d.addEventListener("dragstart", function (e) { e.dataTransfer.setData("ro", o.ro); });
    d.addEventListener("click", function () { detalle(o.ro); });
    cell.appendChild(d);
  });
  bl.addEventListener("dragover", function (e) { e.preventDefault(); });
  bl.addEventListener("drop", function (e) {
    e.preventDefault();
    var o = byRo(e.dataTransfer.getData("ro"));
    if (o) { o.tec = null; o.ini = null; save(); renderAll(); }
  });
  g.querySelectorAll("td.slot").forEach(function (td) {
    td.addEventListener("dragover", function (e) { e.preventDefault(); td.classList.add("over"); });
    td.addEventListener("dragleave", function () { td.classList.remove("over"); });
    td.addEventListener("drop", function (e) {
      e.preventDefault(); td.classList.remove("over");
      var o = byRo(e.dataTransfer.getData("ro"));
      if (o) { o.tec = +td.dataset.tec; o.ini = hhmm(+td.dataset.min); if (!o.etapa) o.etapa = "citas_hoy"; save(); renderAll(); }
    });
  });
  bl.querySelectorAll(".card-ot").forEach(wireCard);
  // línea de hora actual
  var dt = new Date(), now = dt.getHours() * 60 + dt.getMinutes();
  if (now >= START && now <= END) {
    var planner = g.parentElement;
    var old = planner.querySelector(".nowline");
    if (old) old.remove();
    var line = document.createElement("div");
    line.className = "nowline";
    line.style.left = (132 + (now - START) / STEP * COLW) + "px";
    line.style.top = "0px";
    line.style.height = (30 + TECNICOS.length * 60) + "px";
    line.innerHTML = '<span class="lbl">' + hhmm(now) + "</span>";
    planner.appendChild(line);
  }
}

/* ============================================================
   7 · BODEGA — pre-picking con pautas y stock reales
   ============================================================ */
function renderBodega() {
  var board = document.getElementById("bodegaBoard");
  var list = ordersActivas().filter(function (o) { return getRepuestos(o).length; });
  document.getElementById("stockFechaTxt").textContent = STOCK ? "Inventario al " + STOCK.actualizado + " (giro Curifor + giro Frontera)." : "Sin datos de stock cargados.";
  if (!list.length) {
    board.innerHTML = '<p style="color:var(--ink-3)">No hay órdenes con kit de repuestos por recolectar. Las órdenes de mantención por kilometraje generan su kit automáticamente desde la pauta.</p>';
    return;
  }
  board.innerHTML = list.map(function (o) {
    var R = getRepuestos(o);
    var filas = R.map(function (r) {
      return "<tr><td>" + r.codigo + "</td><td>" + r.desc + '</td><td style="text-align:center">' + r.cant + "</td><td>" + stkHTML(r.codigo) + "</td></tr>";
    }).join("");
    var val = valorRefDe(o);
    return '<div class="pickcard">' +
      '<div class="ph"><b>RO ' + o.ro + '</b><span class="badge ' + (o.picking === "listo" ? "listo" : "pend") + '">' + (o.picking === "listo" ? "PREPARADO" : "PENDIENTE") + "</span></div>" +
      '<div class="veh">' +
      '<div><span class="lbl">Patente:</span> ' + o.pat + '</div><div><span class="lbl">Año:</span> ' + (o.anio || "—") + "</div>" +
      '<div><span class="lbl">Marca/Modelo:</span> ' + o.marca + " " + o.modelo + '</div><div><span class="lbl">Km:</span> ' + (o.km ? o.km.toLocaleString("es-CL") : "—") + "</div>" +
      '<div><span class="lbl">VIN:</span> ' + (o.vin || "—") + '</div><div><span class="lbl">Valor ref.:</span> ' + (val != null ? money(val) : "—") + "</div>" +
      '<div style="grid-column:1/3"><span class="lbl">Versión:</span> ' + (o.version || "—") + "</div>" +
      '<div style="grid-column:1/3"><span class="lbl">Servicio:</span> ' + servicioDesc(o) + "</div>" +
      "</div>" +
      "<table><thead><tr><th>Código</th><th>Repuesto</th><th>Cant.</th><th>Stock</th></tr></thead><tbody>" + filas + "</tbody></table>" +
      '<div class="pf">' +
      '<span style="color:var(--ink-3);font-size:11px">' + R.length + " ítems · Cita " + o.rec + "</span>" +
      (o.picking === "listo"
        ? '<button class="agbtn agbtn-grey agbtn-sm" onclick="setPick(\'' + o.ro + '\',\'pendiente\')">Reabrir</button>'
        : '<button class="agbtn agbtn-green agbtn-sm" onclick="setPick(\'' + o.ro + '\',\'listo\')">Marcar preparado</button>') +
      "</div></div>";
  }).join("");
}
function setPick(ro, estado) {
  var o = byRo(ro);
  if (!o) return;
  o.picking = estado;
  if (estado === "listo") o.prep = "rec";
  save();
  renderAll();
}

/* ============================================================
   Detalle de orden
   ============================================================ */
function detalle(ro) {
  var o = byRo(ro);
  if (!o) return;
  var R = getRepuestos(o);
  var val = valorRefDe(o);
  var rep = R.length
    ? '<div class="lbl" style="margin-top:8px">Repuestos (pauta de mantención):</div><table><thead><tr><th>Código</th><th>Repuesto</th><th>Cant.</th><th>Stock</th></tr></thead><tbody>' +
      R.map(function (r) { return "<tr><td>" + r.codigo + "</td><td>" + r.desc + "</td><td>" + r.cant + "</td><td>" + stkHTML(r.codigo) + "</td></tr>"; }).join("") + "</tbody></table>"
    : '<div style="margin-top:8px;color:var(--ink-3)">Sin kit automático (según diagnóstico).</div>';
  var etTxt = "—";
  if (o.etapa === "entregado") etTxt = "Entregado";
  else if (o.etapa) { var et = ETAPAS.find(function (e) { return e.id === o.etapa; }); if (et) etTxt = et.t; }
  document.getElementById("m-title").textContent = "Orden de trabajo RO " + o.ro;
  document.getElementById("m-body").innerHTML =
    '<div><span class="lbl">Cliente:</span> ' + o.cliente + "</div>" +
    '<div><span class="lbl">Vehículo:</span> ' + o.marca + " " + o.modelo + (o.version ? " · " + o.version : "") + (o.anio ? " " + o.anio : "") + " · " + o.pat + "</div>" +
    '<div><span class="lbl">VIN:</span> ' + (o.vin || "—") + ' &nbsp; <span class="lbl">Km:</span> ' + (o.km ? o.km.toLocaleString("es-CL") : "—") + "</div>" +
    '<div><span class="lbl">Servicio:</span> ' + servicioDesc(o) + " (" + TIPOS[o.tipo].label + ", " + o.dur + " min)</div>" +
    (val != null ? '<div><span class="lbl">Valor referencial:</span> ' + money(val) + " neto s/IVA</div>" : "") +
    '<div><span class="lbl">Asesor:</span> ' + (o.asesor || "—") + ' &nbsp; <span class="lbl">Técnico:</span> ' + (o.tec !== null ? TECNICOS[o.tec] : "(sin asignar)") + "</div>" +
    '<div><span class="lbl">Recepción:</span> ' + o.rec + ' &nbsp; <span class="lbl">Inicio:</span> ' + (o.ini || "—") + "</div>" +
    '<div><span class="lbl">Etapa JPCB:</span> ' + etTxt + ' &nbsp; <span class="lbl">Detención:</span> ' + (o.stop ? STOPS.find(function (s) { return s.id === o.stop; }).t : "Ninguna") + "</div>" +
    '<div><span class="lbl">Pre-picking:</span> ' + (o.picking === "listo" ? "Preparado" : "Pendiente") + "</div>" +
    rep +
    '<p class="prox" style="margin-top:10px">Próximamente: notificación al cliente por WhatsApp/e-mail y orden digital.</p>';
  document.getElementById("m-actions").innerHTML =
    (o.etapa === "esp_pago"
      ? '<button class="agbtn agbtn-green" onclick="agEntregar(\'' + o.ro + '\')">Entregar vehículo</button> '
      : "") +
    '<button class="agbtn agbtn-navy" onclick="closeM()">Cerrar</button>';
  document.getElementById("ov").classList.add("open");
}
function closeM() { document.getElementById("ov").classList.remove("open"); }

/* ============================================================
   8 · REPORTES (sobre datos reales)
   ============================================================ */
function renderReportes() {
  var g = document.getElementById("repGrid");
  var hoyStr = hoyISO();
  var act = ordersActivas();
  var agHoy = DB.agendamientos.filter(function (a) { return a.fecha === hoyStr; }).length;
  var valTotal = 0;
  act.forEach(function (o) { var v = valorRefDe(o); if (v) valTotal += v; });
  var kpis = [
    ["Agendamientos hoy", String(agHoy)],
    ["Órdenes activas en taller", String(act.filter(function (o) { return o.etapa; }).length)],
    ["Kits preparados en bodega", act.filter(function (o) { return o.picking === "listo"; }).length + " de " + act.filter(function (o) { return getRepuestos(o).length; }).length],
    ["Valor referencial en curso", money(valTotal)]
  ];
  var html = kpis.map(function (k) {
    return '<div class="rep-card"><h5>' + k[0] + '</h5><div class="kpi">' + k[1] + "</div></div>";
  }).join("");

  // agendamientos últimos 7 días
  var dias = [], cuentas = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date(); d.setDate(d.getDate() - i);
    var iso = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    dias.push(d.toLocaleDateString("es-CL", { weekday: "short" }));
    cuentas.push(DB.agendamientos.filter(function (a) { return a.fecha === iso; }).length);
  }
  html += barChart("Agendamientos últimos 7 días", dias, cuentas);

  // por tipo de servicio
  var servs = {};
  DB.agendamientos.forEach(function (a) { var k = a.serv.split(" ")[0]; servs[k] = (servs[k] || 0) + 1; });
  html += barChart("Agendamientos por tipo de servicio", Object.keys(servs), Object.keys(servs).map(function (k) { return servs[k]; }));

  // órdenes por etapa JPCB
  var etL = [], etC = [];
  ETAPAS.forEach(function (e) {
    var n = act.filter(function (o) { return o.etapa === e.id; }).length;
    if (n) { etL.push(e.t.replace("En espera por ", "Esp. ").replace("Esperando por ", "Esp. ")); etC.push(n); }
  });
  html += barChart("Órdenes por etapa JPCB", etL, etC);

  g.innerHTML = html;
}
function barChart(titulo, labels, vals) {
  var max = Math.max.apply(null, vals.concat([1]));
  var bars = vals.map(function (v, i) {
    return '<div class="bar-item"><i style="height:' + Math.round(v / max * 70 + 4) + 'px" title="' + v + '"></i><span class="bl">' + (labels[i] || "") + "</span></div>";
  }).join("");
  if (!vals.length) bars = '<span style="color:var(--ink-3);font-size:12px">Sin datos aún.</span>';
  return '<div class="rep-card"><h5>' + titulo + '</h5><div class="bars">' + bars + "</div></div>";
}

/* ============================================================
   Datos de demostración
   ============================================================ */
function cargarDemo() {
  if (!INDICE) { alert("Catálogo no cargado: abre la plataforma a través del servidor local o GitHub Pages."); return; }
  if (DB.agendamientos.length || DB.orders.length) {
    if (!confirm("Ya hay datos registrados. ¿Agregar igualmente los datos de demostración?")) return;
  }
  var specs = [
    { pautaId: "ford__ranger--limited-4x2-2-5l-ivct-l4", marca: "Ford", modelo: "Ranger", anio: "2022", pat: "VFLP46", cli: "Pedro Soto", hora: "08:40", revIdx: 1, modo: "orden", etapa: "citas_hoy", prep: "rec" },
    { pautaId: "ford__escape--titanium-2-0l-ecoboost", marca: "Ford", modelo: "Escape", anio: null, pat: "LTCP46", cli: "Ana Reyes", hora: "09:20", revIdx: 0, modo: "orden", etapa: "bajo_serv", prep: "rec", tec: 3, ini: "09:40" },
    { pautaId: "hyundai__tucson-nx4-fl-2-0-mpi-costo", marca: "Hyundai", modelo: "Tucson", anio: null, pat: "TZKG17", cli: "Luis Peña", hora: "10:20", revIdx: 2, modo: "orden", etapa: "esp_serv", prep: "ped", stop: "repuestos" },
    { pautaId: "gac__emzoom-1-5t-at-gl", marca: "GAC", modelo: "EMZOOM", anio: null, pat: "RRDD71", cli: "María Díaz", hora: "11:00", revIdx: 1, modo: "agenda" },
    { pautaId: "ford__territory--trend-1-5l-gtdi", marca: "Ford", modelo: "Territory", anio: null, pat: "KXPL09", cli: "Sofía Rojas", hora: "15:00", revIdx: 0, modo: "agenda" }
  ];
  Promise.all(specs.map(function (s) { return cargarPauta(s.pautaId); })).then(function () {
    specs.forEach(function (s, i) {
      var p = pautaCargada(s.pautaId);
      var itv = null, versionN = null;
      if (p) {
        versionN = p.version || null;
        var plan = planDe(p, s.anio);
        var conKm = (plan && plan.intervalos || []).filter(function (x) { return x.km && !x.gratis; });
        itv = conKm[Math.min(s.revIdx, Math.max(conKm.length - 1, 0))] || null;
      }
      var base = {
        oc: DB.ocSeq++, fecha: hoyISO(), hora: s.hora, sucursal: "CURIFOR TALCA",
        serv: "MANTENCIÓN POR KILOMETRAJE", pat: s.pat,
        marcaNombre: s.marca, modeloNombre: s.modelo, versionNombre: versionN,
        pautaId: s.pautaId, anio: s.anio, km: itv ? itv.km : null, revN: itv ? itv.n : null,
        valorRef: itv ? valorItv(itv) : null,
        vin: null, cli: s.cli + " (demo)", rut: "11.111.111-1", fono: "9 0000 0000", email: "demo@curifor.cl",
        asesor: ASESORES[i % ASESORES.length], estado: s.modo === "agenda" ? "agendado" : "en_taller"
      };
      DB.agendamientos.push(base);
      if (s.modo === "orden") {
        DB.orders.push({
          ro: String(DB.roSeq++).padStart(4, "0"), oc: base.oc, fecha: base.fecha,
          pat: s.pat, marca: s.marca, modelo: s.modelo, version: versionN,
          anio: s.anio, km: base.km, revN: base.revN, pautaId: s.pautaId, valorRef: base.valorRef,
          vin: "—", color: "—", cliente: base.cli, asesor: base.asesor,
          tipo: "mant", dur: (itv && horasAMin(itv.horas)) || 60, rec: s.hora, del: "—",
          tec: s.tec != null ? s.tec : null, ini: s.ini || null,
          etapa: s.etapa, stop: s.stop || null, prep: s.prep || "rec", picking: "pendiente"
        });
      }
    });
    save();
    renderCal(); renderSlots(); renderAgendaTable(); renderAll();
    alert("Datos de demostración cargados: " + specs.length + " agendamientos (" + specs.filter(function (s) { return s.modo === "orden"; }).length + " ya ingresados a taller).");
  });
}
function borrarTodo() {
  if (!confirm("Esto borra TODOS los agendamientos y órdenes guardados en este navegador. ¿Continuar?")) return;
  DB = { agendamientos: [], orders: [], ocSeq: 1190001, roSeq: 60 };
  save();
  renderCal(); renderSlots(); renderAgendaTable(); renderAll();
}

/* ============================================================
   Render global + init
   ============================================================ */
function renderAll() { renderPrep(); renderPlan(); renderJPCB(); renderBodega(); }

function init() {
  cargarDB();
  cargarPrefill();
  document.getElementById("footFecha").textContent = new Date().toLocaleDateString("es-CL", { day: "numeric", month: "long", year: "numeric" });

  // pestañas
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () { agGoTab(t.dataset.v); });
  });
  // calendario
  document.getElementById("calPrev").addEventListener("click", function () {
    calM--; if (calM < 0) { calM = 11; calY--; } renderCal();
  });
  document.getElementById("calNext").addEventListener("click", function () {
    calM++; if (calM > 11) { calM = 0; calY++; } renderCal();
  });
  // modal agendar
  document.getElementById("agMarca").addEventListener("change", onMarcaModal);
  document.getElementById("agModeloSel").addEventListener("change", onModeloModal);
  document.getElementById("agVersionSel").addEventListener("change", onVersionModal);
  document.getElementById("agAnioSel").addEventListener("change", llenarMantModal);
  document.getElementById("agMantSel").addEventListener("change", onMantModal);
  document.getElementById("agServicio").addEventListener("change", llenarMantModal);
  // demo
  document.getElementById("btnDemo").addEventListener("click", cargarDemo);
  document.getElementById("btnBorrarTodo").addEventListener("click", borrarTodo);
  // cerrar modales con clic afuera
  ["ov", "agOv"].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener("click", function (e) { if (e.target === el) el.classList.remove("open"); });
  });

  renderCal(); renderSlots(); renderAgendaTable();
  renderPrefillBanner();
  renderAll();

  // catálogo + stock del cotizador
  var pIdx = fetch("data/indice.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  var pStk = fetch("data/stock.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  Promise.all([pIdx, pStk]).then(function (res) {
    INDICE = res[0]; STOCK = res[1];
    llenarMarcasModal();
    llenarAsesores();
    return precargarPautas();
  }).then(function () {
    renderAll();
    renderAgendaTable();
  });
}
document.addEventListener("DOMContentLoaded", init);
