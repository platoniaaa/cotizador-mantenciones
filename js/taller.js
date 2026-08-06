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

/* ---------------- estado persistente ----------------
   El estado vive en localStorage (rápido y sirve sin red) y, si la estación
   tiene sesión del personal, se sincroniza con la bandeja compartida de su
   sucursal en Supabase. Ver el bloque "estado compartido" más abajo.
   La copia local se guarda por sucursal: cada bandeja es independiente.      */
var DB = { agendamientos: [], orders: [], ocSeq: 1190001, roSeq: 60, webImp: {} };

function tkeyDe(suc) { return TKEY + "::" + (suc || ""); }

function cargarDB() {
  var suc = sucursalEstacion();
  var raw = null;
  try {
    raw = localStorage.getItem(tkeyDe(suc));
    // Migración de un solo uso: lo que había antes de separar por sucursal pasa
    // a la bandeja que esta estación tenga seleccionada, sin perder nada. La
    // clave antigua se retira DESPUÉS de copiarla; si no, al cambiar de sucursal
    // el mismo contenido viejo se clonaría en cada bandeja que se visite.
    if (raw == null) {
      var viejo = localStorage.getItem(TKEY);
      if (viejo != null) {
        raw = viejo;
        localStorage.setItem(tkeyDe(suc), viejo);
        localStorage.removeItem(TKEY);
      }
    }
  } catch (e) { /* almacenamiento no disponible */ }
  DB = { agendamientos: [], orders: [], ocSeq: 1190001, roSeq: 60, webImp: {} };
  try {
    if (raw) { var d = JSON.parse(raw); if (d && d.agendamientos && d.orders) DB = d; }
  } catch (e) { /* estado corrupto: se parte de cero */ }
  if (!DB.webImp) DB.webImp = {};   // ids de reservas web ya pasadas a la agenda
  asegurarUids(DB);
}

function guardarLocal() {
  asegurarUids(DB);   // nada se persiste ni se sube sin identidad propia
  try { localStorage.setItem(tkeyDe(sucursalEstacion()), JSON.stringify(DB)); }
  catch (e) { /* sin espacio */ }
}
function save() { guardarLocal(); agendarSync(); }

/* ============================================================
   ESTADO COMPARTIDO ENTRE ESTACIONES  (tabla taller_estado)
   ------------------------------------------------------------
   Una bandeja por sucursal. El documento completo viaja a Supabase y vuelve,
   de modo que dos estaciones de la misma sucursal ven la misma agenda, el
   mismo JPCB y la misma bodega.

   Choques: el guardado usa bloqueo optimista (`where version = N`). Si otra
   estación grabó primero, la respuesta viene vacía → se relee y se fusiona a
   TRES BANDAS: `base` (lo último que vi del servidor), lo mío y lo del
   servidor. Solo pisa lo que YO cambié desde la base; lo que no toqué queda
   como lo dejó la otra estación. Sin base (primera vez) la fusión une todo,
   que es justo lo que hace falta para subir lo que ya había en el navegador.

   Sin sesión del personal o sin red, todo esto se salta y el taller funciona
   igual que antes, contra localStorage.

   OJO (pendiente de la fase 2): ocSeq/roSeq siguen siendo contadores por
   estación, así que dos estaciones pueden generar el mismo número de OC/RO.
   Al fusionar se detecta y se renumera lo mío para no perder trabajo, pero la
   solución de fondo es mover los correlativos a secuencias de Postgres.
   ============================================================ */
var SUCKEY = "curiforTallerSucursal";     // sucursal de esta estación
var ESTKEY = "curiforTallerEstacionId";   // id local, para construir uids únicos
var TALLER_TABLA = "taller_estado";
var SYNC = { base: null, version: 0, sucursal: null, timer: null, enVuelo: false, pendiente: false, poll: null };

function estacionId() {
  var v = null;
  try { v = localStorage.getItem(ESTKEY); } catch (e) { }
  if (!v) {
    v = "est" + Math.random().toString(36).slice(2, 8);
    try { localStorage.setItem(ESTKEY, v); } catch (e) { }
  }
  return v;
}

// Identidad estable por entidad, independiente del correlativo (que puede
// repetirse entre estaciones). Se asigna antes de guardar o de subir nada.
function asegurarUids(db, prefijo) {
  if (!db) return;
  var p = prefijo || estacionId();
  (db.agendamientos || []).forEach(function (a) { if (a && !a.uid) a.uid = p + "-a" + a.oc; });
  (db.orders || []).forEach(function (o) { if (o && !o.uid) o.uid = p + "-o" + o.ro; });
}

function sucursalEstacion() {
  var g = null;
  try { g = localStorage.getItem(SUCKEY); } catch (e) { }
  if (g) return g;
  var sel = document.getElementById("fComercio");
  return (sel && sel.value) || "CURIFOR TALCA";
}

// Deja el selector de la agenda mostrando la sucursal recordada y, sobre todo,
// FIJA esa sucursal en localStorage. Sin fijarla, sucursalEstacion() se limita a
// devolver lo que diga el selector y el manejador de cambio nunca detectaría un
// cambio (compararía el valor nuevo contra sí mismo).
function restaurarSucursal() {
  var g = sucursalEstacion();
  var sel = document.getElementById("fComercio");
  if (sel) {
    var existe = Array.prototype.some.call(sel.options, function (o) { return o.value === g; });
    if (existe) sel.value = g; else g = sel.value;
  }
  try { localStorage.setItem(SUCKEY, g); } catch (e) { /* sin espacio */ }
}

/* ---- fusión a tres bandas ---- */
function _porClave(arr, clave) {
  var m = {};
  (arr || []).forEach(function (x) { if (x && x[clave] != null) m[String(x[clave])] = x; });
  return m;
}
function _fusionarLista(base, mio, suyo, clave) {
  var B = _porClave(base, clave), M = _porClave(mio, clave), S = _porClave(suyo, clave);
  var out = {}, k;
  for (k in S) out[k] = S[k];                       // punto de partida: el servidor
  for (k in B) if (!(k in M)) delete out[k];        // lo borré yo desde la base
  for (k in M) {                                     // lo creé o lo edité yo
    if (!(k in B) || JSON.stringify(B[k]) !== JSON.stringify(M[k])) out[k] = M[k];
  }
  return Object.keys(out).map(function (k2) { return out[k2]; });
}

// Si un número de OC/RO mío ya lo usa OTRA entidad en el servidor, renumero lo
// mío: sin esto, la fusión por identidad dejaría dos vehículos distintos con el
// mismo número a la vista. Devuelve cuántos se movieron.
function reconciliarCorrelativos(mio, suyo) {
  var ocServidor = {}, roServidor = {};
  (suyo.agendamientos || []).forEach(function (a) { if (a && a.oc != null) ocServidor[String(a.oc)] = a.uid; });
  (suyo.orders || []).forEach(function (o) { if (o && o.ro != null) roServidor[String(o.ro)] = o.uid; });

  var sigOc = Math.max(mio.ocSeq || 0, suyo.ocSeq || 0);
  var sigRo = Math.max(mio.roSeq || 0, suyo.roSeq || 0);
  var movidos = 0;

  (mio.agendamientos || []).forEach(function (a) {
    var duenio = ocServidor[String(a.oc)];
    if (duenio && duenio !== a.uid) {
      var anterior = a.oc;
      a.oc = sigOc++;
      (mio.orders || []).forEach(function (o) { if (o && o.oc === anterior) o.oc = a.oc; });
      movidos++;
    }
  });
  (mio.orders || []).forEach(function (o) {
    var duenio = roServidor[String(o.ro)];
    if (duenio && duenio !== o.uid) { o.ro = String(sigRo++).padStart(4, "0"); movidos++; }
  });

  mio.ocSeq = sigOc; mio.roSeq = sigRo;
  return movidos;
}

function fusionar(base, mio, suyo) {
  base = base || {}; suyo = suyo || {};
  asegurarUids(mio); asegurarUids(suyo, "srv");
  reconciliarCorrelativos(mio, suyo);
  return {
    agendamientos: _fusionarLista(base.agendamientos, mio.agendamientos, suyo.agendamientos, "uid"),
    orders:        _fusionarLista(base.orders,        mio.orders,        suyo.orders,        "uid"),
    ocSeq:  Math.max(mio.ocSeq || 0, suyo.ocSeq || 0),
    roSeq:  Math.max(mio.roSeq || 0, suyo.roSeq || 0),
    webImp: Object.assign({}, suyo.webImp || {}, mio.webImp || {})
  };
}

/* ---- ida y vuelta con Supabase ---- */
function tallerFilaRemota(s) {
  var u = AGW.url + "/rest/v1/" + TALLER_TABLA +
    "?sucursal=eq." + encodeURIComponent(SYNC.sucursal) + "&select=data,version";
  return fetch(u, { headers: { apikey: AGW.anonKey, Authorization: "Bearer " + s.access } })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (rows) { return (rows && rows[0]) || null; });
}

// Devuelve la fila grabada, o null si otra estación se adelantó (choque).
function tallerGuardarRemoto(s, data, version) {
  var base = AGW.url + "/rest/v1/" + TALLER_TABLA;
  var h = {
    apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
    "Content-Type": "application/json", Prefer: "return=representation"
  };
  if (!version) {   // la bandeja todavía no existe
    return fetch(base, {
      method: "POST", headers: h,
      body: JSON.stringify({ sucursal: SYNC.sucursal, data: data, version: 1 })
    }).then(function (r) {
      if (r.status === 409) return null;                  // la creó otra estación
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (rows) { return (rows && rows[0]) || null; });
  }
  return fetch(base + "?sucursal=eq." + encodeURIComponent(SYNC.sucursal) + "&version=eq." + version, {
    method: "PATCH", headers: h,
    body: JSON.stringify({ data: data, version: version + 1 })
  }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(function (rows) { return (rows && rows[0]) || null; });
}

function agendarSync() {
  if (!webCfgOk()) return;
  if (SYNC.timer) clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(function () { SYNC.timer = null; sincronizar(); }, 1200);
}

function sincronizar() {
  if (!webCfgOk()) return Promise.resolve(false);
  if (SYNC.enVuelo) { SYNC.pendiente = true; return Promise.resolve(false); }
  SYNC.enVuelo = true;
  if (!SYNC.sucursal) SYNC.sucursal = sucursalEstacion();
  return webSesion().then(function (s) {
    if (!s) return false;                       // sin login: queda todo local
    asegurarUids(DB);
    return tallerGuardarRemoto(s, DB, SYNC.version).then(function (fila) {
      if (fila) {                               // grabado limpio
        SYNC.version = fila.version;
        SYNC.base = JSON.parse(JSON.stringify(DB));
        return true;
      }
      return tallerFilaRemota(s).then(function (row) {   // choque: releer y fusionar
        if (!row) return false;
        DB = fusionar(SYNC.base, DB, row.data || {});
        SYNC.version = row.version;
        SYNC.base = JSON.parse(JSON.stringify(row.data || {}));
        guardarLocal();
        repintarTodo();
        SYNC.pendiente = true;                  // lo mío se sube en la vuelta siguiente
        return false;
      });
    });
  }).catch(function () { return false; })
    .then(function (r) {
      SYNC.enVuelo = false;
      if (SYNC.pendiente) { SYNC.pendiente = false; agendarSync(); }
      return r;
    });
}

// Trae lo que hayan hecho las otras estaciones (se llama cada poco).
function refrescarRemoto() {
  if (!webCfgOk() || SYNC.enVuelo) return Promise.resolve(false);
  if (!SYNC.sucursal) SYNC.sucursal = sucursalEstacion();
  return webSesion().then(function (s) {
    if (!s) return false;
    return tallerFilaRemota(s).then(function (row) {
      if (!row || row.version === SYNC.version) return false;
      DB = fusionar(SYNC.base, DB, row.data || {});
      SYNC.version = row.version;
      SYNC.base = JSON.parse(JSON.stringify(row.data || {}));
      guardarLocal();
      repintarTodo();
      agendarSync();                            // por si mi fusión aportó algo
      return true;
    });
  }).catch(function () { return false; });
}

function iniciarSincronizacion() {
  if (!webCfgOk()) return;
  SYNC.sucursal = sucursalEstacion();
  SYNC.base = null; SYNC.version = 0;
  webSesion().then(function (s) {
    if (!s) return;                             // sin sesión: modo local, sin ruido
    return tallerFilaRemota(s).then(function (row) {
      if (row) {
        // base vacía a propósito: la primera fusión UNE lo local con lo compartido
        DB = fusionar(null, DB, row.data || {});
        SYNC.version = row.version;
        SYNC.base = JSON.parse(JSON.stringify(row.data || {}));
        guardarLocal();
        repintarTodo();
      }
      agendarSync();                            // sube lo que esta estación tenía
    });
  }).catch(function () { /* sin red: se reintenta en el próximo guardado */ });

  if (SYNC.poll) clearInterval(SYNC.poll);
  SYNC.poll = setInterval(refrescarRemoto, 15000);
}

// El selector de sucursal de la agenda manda: cambia la bandeja que se ve.
function alCambiarSucursal() {
  var sel = document.getElementById("fComercio");
  if (!sel || sel.value === sucursalEstacion()) return;
  guardarLocal();                               // cierro la bandeja anterior
  try { localStorage.setItem(SUCKEY, sel.value); } catch (e) { }
  cargarDB();                                   // abro la de la sucursal nueva
  repintarTodo();
  iniciarSincronizacion();
}

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
    // id de la reserva web (Supabase) si este agendamiento vino de una solicitud
    // del cliente: permite cerrar el ciclo (estado) en el servidor al recibir.
    webId: (PREFILL && PREFILL.web && PREFILL.web.id) || null,
    estado: "agendado"
  };
  DB.agendamientos.push(a);
  if (PREFILL && PREFILL.web && PREFILL.web.id) DB.webImp[PREFILL.web.id] = 1;
  // Agendamiento interno (no vino de solicitud web): persistirlo también en
  // Supabase para que la agenda sea multi-estación. Fail-safe: sin sesión, sin
  // fono válido, o si falla la red, queda solo local (como antes).
  if (!a.webId && a.fono && String(a.fono).length >= 8 && typeof webCrearReserva === "function") {
    webCrearReserva({
      nombre: a.cli || "Cliente", fono: a.fono, email: a.email,
      patente: a.pat, fecha: a.fecha, hora: a.hora,
      marca: a.marcaNombre, modelo: a.modeloNombre, version: a.versionNombre,
      anio: a.anio, pauta_id: a.pautaId, rev_n: a.revN != null ? String(a.revN) : null,
      km: a.km, valor: a.valorRef, rut: a.rut, asesor: a.asesor,
      sucursal: a.sucursal, vin: a.vin, origen: "taller", estado: "agendada"
    }).then(function (id) { if (id) { a.webId = id; save(); } })
      .catch(function () { /* queda solo local */ });
  }
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
  var auto = "<b>" + PREFILL.marcaNombre + " " + PREFILL.modelo + " · " + PREFILL.version + "</b> — Rev. " +
    PREFILL.revN + (PREFILL.km ? " · " + etiquetaKm(PREFILL.km) : "");
  var descartar = '<button class="agbtn agbtn-ghost agbtn-sm" onclick="descartarPrefill()">Descartar</button>';
  var w = PREFILL.web;
  if (w) {
    b.innerHTML = "🌐 Reserva web de <b>" + esc(w.cli) + "</b> (" + esc(w.fono) + "): " + auto +
      ". Pidió el <b>" + fmtFechaCorta(w.fecha) + "</b>" +
      (w.hora && w.hora !== "indiferente" ? " a las <b>" + w.hora + "</b>" : " (hora por definir)") +
      ". Elige una <b>hora libre</b> en el calendario para confirmarla." + descartar;
    return;
  }
  b.innerHTML = "📋 Cotización lista para agendar: " + auto +
    (PREFILL.valor != null ? " · " + money(PREFILL.valor) : "") +
    ". Elige una <b>hora libre</b> en el calendario para completar el agendamiento." + descartar;
}
function descartarPrefill() {
  localStorage.removeItem(PREKEY);
  PREFILL = null;
  renderPrefillBanner();
}
function aplicarPrefill() {
  if (!PREFILL || !INDICE) return;
  // datos de contacto de la reserva web (si vino de ahí)
  var w = PREFILL.web;
  if (w) {
    if (w.cli) document.getElementById("agCliente").value = w.cli;
    if (w.fono) document.getElementById("agFono").value = w.fono;
    if (w.email) document.getElementById("agEmail").value = w.email;
    if (w.pat) document.getElementById("agPatente").value = w.pat;
  }
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
   Reservas web (Supabase) — el cliente pide hora en cliente.html
   y acá se pasan a la agenda. Leerlas requiere el login del
   personal (Supabase Auth); la sesión queda en este navegador.
   Config en js/agenda-config.js; SQL en
   herramientas/setup_supabase_reservas.sql.
   ============================================================ */
var AGW = window.CURIFOR_AGENDA || {};
var WEBKEY = "curiforTallerWebSes_v1";
var WEBRES = [];   // últimas reservas traídas del servidor

function webCfgOk() { return !!(AGW.url && AGW.anonKey); }
function webTabla() { return AGW.tabla || "reservas_web"; }
function esc(s) {
  return s == null ? "" : String(s).replace(/[&<>"]/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
  });
}

function webSesGuardada() {
  try { return JSON.parse(localStorage.getItem(WEBKEY) || "null"); } catch (e) { return null; }
}
function webGuardarSes(s) {
  try {
    if (s) localStorage.setItem(WEBKEY, JSON.stringify(s));
    else localStorage.removeItem(WEBKEY);
  } catch (e) { /* sin espacio */ }
}

function webAuth(body, grant) {
  return fetch(AGW.url + "/auth/v1/token?grant_type=" + grant, {
    method: "POST",
    headers: { apikey: AGW.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (j) { return r.ok ? j : Promise.reject(j); });
  }).then(function (j) {
    var s = {
      access: j.access_token,
      refresh: j.refresh_token,
      exp: j.expires_at || (Date.now() / 1000 + (j.expires_in || 3600)),
      email: (j.user && j.user.email) || ""
    };
    webGuardarSes(s);
    return s;
  });
}

// sesión vigente (refresca si está por vencer) o null si hay que loguearse
function webSesion() {
  var s = webSesGuardada();
  if (!s || !s.refresh) return Promise.resolve(null);
  if (s.exp - 60 > Date.now() / 1000) return Promise.resolve(s);
  return webAuth({ refresh_token: s.refresh }, "refresh_token")
    .catch(function () { webGuardarSes(null); return null; });
}

function webFetchReservas(s) {
  var desde = new Date(Date.now() - 60 * 864e5).toISOString();
  var u = AGW.url + "/rest/v1/" + webTabla() +
    "?select=*&creado_en=gte." + encodeURIComponent(desde) +
    "&order=fecha.asc%2Chora.asc";
  return fetch(u, { headers: { apikey: AGW.anonKey, Authorization: "Bearer " + s.access } })
    .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); });
}

// Actualiza el estado de una reserva EN SUPABASE (server-side, multi-estación):
// nueva -> agendada -> recibida -> en_taller -> cerrada. Requiere sesión @curifor.com.
function webActualizarEstado(id, nuevoEstado, extra) {
  return webSesion().then(function (s) {
    if (!s) return Promise.reject(new Error("sin sesión"));
    var body = Object.assign({}, extra || {});
    if (nuevoEstado) body.estado = nuevoEstado;   // estado opcional (p.ej. solo fotos)
    return fetch(AGW.url + "/rest/v1/" + webTabla() + "?id=eq." + encodeURIComponent(id), {
      method: "PATCH",
      headers: {
        apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
        "Content-Type": "application/json", Prefer: "return=minimal"
      },
      body: JSON.stringify(body)
    }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return true; });
  });
}

// texto del pill según el estado del flujo en el servidor
function webEtiquetaEstado(e) {
  return { nueva: "Nueva", agendada: "En agenda", recibida: "Recibida",
           en_taller: "En taller", cerrada: "Cerrada",
           rechazada: "Rechazada", cancelada: "Cancelada" }[e] || e || "Nueva";
}

// Crea una reserva EN SUPABASE desde el taller (agendamiento interno) y devuelve
// su id (o null). Así la agenda hecha por el asesor también vive en el backend y
// es visible entre estaciones. Requiere sesión @curifor.com (policy insert_staff).
function webCrearReserva(datos) {
  return webSesion().then(function (s) {
    if (!s) return null;
    return fetch(AGW.url + "/rest/v1/" + webTabla(), {
      method: "POST",
      headers: {
        apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
        "Content-Type": "application/json", Prefer: "return=representation"
      },
      body: JSON.stringify(datos)
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (rows) { return (rows && rows[0] && rows[0].id) || null; });
  });
}

function webAbrir() {
  webSesion().then(function (s) {
    if (!s) { webAbrirLogin(); return; }
    webCargarLista();
  });
}
function webAbrirLogin() {
  document.getElementById("webLoginErr").hidden = true;
  document.getElementById("webLoginOv").classList.add("open");
}
function webCerrarLogin() { document.getElementById("webLoginOv").classList.remove("open"); }
function webCerrarLista() { document.getElementById("webResOv").classList.remove("open"); }
function webDesconectar() { webGuardarSes(null); webCerrarLista(); }

function webLogin() {
  var em = document.getElementById("webEmail").value.trim();
  var pw = document.getElementById("webPass").value;
  var err = document.getElementById("webLoginErr");
  if (!em || !pw) { err.textContent = "Ingresa e-mail y clave."; err.hidden = false; return; }
  var btn = document.getElementById("webLoginBtn");
  btn.disabled = true;
  webAuth({ email: em, password: pw }, "password")
    .then(function () {
      document.getElementById("webPass").value = "";
      webCerrarLogin(); webCargarLista();
      // recién ahora hay sesión: engancha la bandeja compartida de la sucursal
      iniciarSincronizacion();
    })
    .catch(function (e) {
      err.textContent = "No se pudo conectar: " +
        ((e && (e.error_description || e.msg)) || "revisa el e-mail y la clave.");
      err.hidden = false;
    })
    .then(function () { btn.disabled = false; });
}

function webCargarLista() {
  var cont = document.getElementById("webResLista");
  cont.innerHTML = '<p style="color:var(--ink-3);padding:8px 0">Cargando reservas…</p>';
  document.getElementById("webResOv").classList.add("open");
  webSesion().then(function (s) {
    if (!s) { webCerrarLista(); webAbrirLogin(); return; }
    document.getElementById("webResInfo").textContent = "· " + (s.email || "");
    return webFetchReservas(s).then(function (rows) {
      WEBRES = rows || [];
      webPintarLista();
      webBadge();
    });
  }).catch(function () {
    cont.innerHTML = '<p style="color:#c62828;padding:8px 0">No se pudieron traer las reservas. Reintenta.</p>';
  });
}

function webPintarLista() {
  var cont = document.getElementById("webResLista");
  if (!WEBRES.length) {
    cont.innerHTML = '<p style="color:var(--ink-3);padding:8px 0">No hay reservas web en los últimos 60 días.</p>';
    return;
  }
  var hoyStr = hoyISO();
  cont.innerHTML = WEBRES.map(function (r, i) {
    // "gestionada" = ya la tomó alguien (estado del servidor != nueva) o marca local
    var gestionada = (r.estado && r.estado !== "nueva") || !!DB.webImp[r.id];
    var vieja = r.fecha < hoyStr;
    var est = gestionada ? '<span class="ag-pill en">' + esc(webEtiquetaEstado(r.estado || "agendada")) + '</span>'
      : vieja ? '<span class="ag-pill ent">Vencida</span>'
      : '<span class="ag-pill por">Nueva</span>';
    var imp = gestionada;
    var auto = [r.marca, r.modelo, r.version].filter(Boolean).join(" ") + (r.anio ? " (" + r.anio + ")" : "");
    var mant = r.km ? "Mantención " + etiquetaKm(r.km) : (r.rev_n ? "Rev. " + r.rev_n : "Mantención");
    var hora = r.hora === "indiferente" ? "hora por definir" : (r.hora || "") + " h";
    return '<div class="webres-item">' +
      '<div class="webres-cab"><b>' + fmtFechaCorta(r.fecha) + "</b> · " + hora + " " + est + "</div>" +
      '<div class="webres-det">' + esc(r.nombre) + " · " + esc(r.fono) +
        (r.email ? " · " + esc(r.email) : "") + (r.patente ? " · pat. " + esc(r.patente) : "") + "</div>" +
      '<div class="webres-det">' + esc(auto) + " — " + mant +
        (r.extras ? " + " + esc(r.extras) : "") + "</div>" +
      (r.comentario ? '<div class="webres-com">“' + esc(r.comentario) + "”</div>" : "") +
      (imp ? "" : '<button class="agbtn agbtn-blue agbtn-sm" onclick="webPasar(' + i + ')">Pasar a la agenda</button>') +
      "</div>";
  }).join("");
}

// arma un PREFILL con la reserva y salta el calendario al día pedido:
// el flujo sigue igual que siempre (clic en hora libre → modal prellenado)
function webPasar(i) {
  var r = WEBRES[i];
  if (!r || !r.pauta_id) return;
  PREFILL = {
    pautaId: r.pauta_id, marcaNombre: r.marca, modelo: r.modelo, version: r.version,
    anio: r.anio || null, revN: r.rev_n != null ? r.rev_n : null, km: r.km || null,
    valor: null, ts: Date.now(),
    web: { id: r.id, cli: r.nombre, fono: r.fono, email: r.email, pat: r.patente,
           fecha: r.fecha, hora: r.hora, comentario: r.comentario }
  };
  try { localStorage.setItem(PREKEY, JSON.stringify(PREFILL)); } catch (e) { /* sin espacio */ }
  // Marca la reserva como 'agendada' EN SUPABASE (server-side): así cualquier
  // otra estación la ve tomada y no la duplica. Si falla la red, el flujo local
  // sigue igual (no bloquea al asesor).
  var _ses = webSesGuardada();
  webActualizarEstado(r.id, "agendada", { asesor: (_ses && _ses.email) || null })
    .then(function () { r.estado = "agendada"; DB.webImp[r.id] = 1; save(); })
    .catch(function () { /* offline: queda solo la marca local */ DB.webImp[r.id] = 1; save(); });
  var p = r.fecha.split("-");
  calY = +p[0]; calM = +p[1] - 1; selFecha = r.fecha;
  webCerrarLista();
  agGoTab("agenda");
  renderPrefillBanner();
}

function webBadge() {
  var b = document.getElementById("webResBadge");
  if (!b) return;
  var hoyStr = hoyISO();
  var n = WEBRES.filter(function (r) {
    var gestionada = (r.estado && r.estado !== "nueva") || !!DB.webImp[r.id];
    return !gestionada && r.fecha >= hoyStr;
  }).length;
  b.hidden = !n;
  b.textContent = n;
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
  agPintarRecepcion();
}

// Pinta el formulario de recepción a partir de agRecSel (venga de la agenda
// local o de una búsqueda por patente en Supabase).
function agPintarRecepcion() {
  if (!agRecSel) return;
  var mm = [agRecSel.marcaNombre, agRecSel.modeloNombre].filter(Boolean).join(" ");
  document.getElementById("recVacia").hidden = true;
  var f = document.getElementById("recForm");
  f.hidden = false; f.classList.remove("hidden");
  document.getElementById("recTitulo").textContent = agRecSel.pat + (mm ? " — " + mm : "");
  document.getElementById("recOC").textContent = agRecSel.oc;
  document.getElementById("recFecha").textContent = (agRecSel.fecha ? fmtFechaCorta(agRecSel.fecha) : "hoy") + " " + (agRecSel.hora || "");
  document.getElementById("rcCliente").textContent = agRecSel.cli || "—";
  document.getElementById("rcRut").textContent = agRecSel.rut || "—";
  document.getElementById("rcFono").textContent = agRecSel.fono || "—";
  document.getElementById("rcEmail").textContent = agRecSel.email || "—";
  document.getElementById("rcPatente").textContent = agRecSel.pat;
  document.getElementById("rcModelo").textContent = (mm || "—") + (agRecSel.versionNombre ? " · " + agRecSel.versionNombre : "");
  document.getElementById("rcAnio").textContent = agRecSel.anio || "—";
  document.getElementById("rcKm").textContent = agRecSel.km ? etiquetaKm(agRecSel.km) : "—";
  document.getElementById("rcServ").textContent = (agRecSel.serv || "Recepción") + (agRecSel.km ? " · " + etiquetaKm(agRecSel.km) : "");
  document.getElementById("rcValor").textContent = agRecSel.valorRef != null ? money(agRecSel.valorRef) + " neto s/IVA" : "—";
  var ag = document.getElementById("accGrid");
  ag.innerHTML = AGACC.map(function (a) { return '<label class="acc"><input type="checkbox"> ' + a + "</label>"; }).join("");
  agRenderFotos();
  agGoTab("recep");
}

// Recepción AUTÓNOMA por patente: busca en Supabase la reserva agendada + los
// datos del vehículo/cliente y abre la recepción, sin depender de la agenda local.
function agRecepcionPorPatente(pat) {
  pat = (pat || "").trim().toUpperCase();
  var msg = document.getElementById("recBuscarMsg");
  if (!pat) { if (msg) msg.textContent = "Escribe una patente."; return; }
  if (msg) msg.textContent = "Buscando…";
  webSesion().then(function (s) {
    if (!s) { webAbrirLogin(); throw new Error("sin sesión"); }
    var hdr = { apikey: AGW.anonKey, Authorization: "Bearer " + s.access };
    var base = AGW.url + "/rest/v1/";
    var pe = encodeURIComponent(pat);
    return Promise.all([
      fetch(base + "reservas_web?patente=eq." + pe + "&estado=in.(nueva,agendada,recibida)&order=fecha.desc&limit=1", { headers: hdr }).then(function (r) { return r.ok ? r.json() : []; }),
      fetch(base + "vehiculos?patente=eq." + pe + "&select=*&limit=1", { headers: hdr }).then(function (r) { return r.ok ? r.json() : []; })
    ]).then(function (res) {
      var r = (res[0] && res[0][0]) || null;
      var veh = (res[1] && res[1][0]) || null;
      if (!r && !veh) { if (msg) msg.textContent = "Sin registro de esa patente en el sistema."; return; }
      var rut = (r && r.rut) || (veh && veh.rut) || null;
      var pCli = rut
        ? fetch(base + "clientes?rut=eq." + encodeURIComponent(rut) + "&select=*&limit=1", { headers: hdr }).then(function (x) { return x.ok ? x.json() : []; }).then(function (a) { return a[0] || null; })
        : Promise.resolve(null);
      return pCli.then(function (cli) {
        r = r || {};
        agRecSel = {
          pat: pat, oc: r.id || "—", webId: r.id || null,
          marcaNombre: r.marca || "", modeloNombre: r.modelo || (veh && veh.modelo) || "",
          versionNombre: r.version || null, pautaId: r.pauta_id || null,
          anio: r.anio || (veh && veh.anio) || null,
          km: r.km || (veh && veh.km) || null, revN: r.rev_n || null,
          valorRef: (r.valor != null ? r.valor : null),
          serv: r.km ? "Mantención" : "Recepción",
          cli: (cli && cli.nombre) || r.nombre || "Cliente",
          rut: rut, fono: (cli && (cli.cel || cli.fono)) || r.fono || null,
          email: (cli && cli.mail) || r.email || null,
          vin: r.vin || (veh && veh.vin) || null, asesor: r.asesor || null,
          fecha: r.fecha || null, hora: r.hora || "", sucursal: r.sucursal || null,
          fotos: {}
        };
        if (msg) msg.textContent = "";
        var inp = document.getElementById("recBuscarPat"); if (inp) inp.value = "";
        agPintarRecepcion();
      });
    });
  }).catch(function () { if (msg) msg.textContent = "No se pudo buscar (¿sesión de asesor iniciada?)."; });
}

// carpeta estable de las fotos de esta recepción dentro del bucket 'recepciones'
function agFotoCarpeta() {
  if (!agRecSel) return null;
  return agRecSel.webId || ((agRecSel.pat || "sinpat") + "_" + agRecSel.oc);
}

// Dibuja los slots de foto: cada vista abre la cámara (tablet/celular) o el
// selector de archivo (PC). Muestra la foto ya subida si existe.
function agRenderFotos() {
  var pw = document.getElementById("photoWrap");
  if (!pw) return;
  var fotos = (agRecSel && agRecSel.fotos) || {};
  pw.innerHTML = AGFOTOS.map(function (fo, i) {
    var sub = fotos[fo];
    return '<label class="photo-slot' + (sub ? " has-photo" : "") + '" id="slot_' + i + '"' +
        (sub ? ' style="background-image:url(' + esc(sub.preview || "") + ')"' : "") + '>' +
      '<input type="file" accept="image/*" capture="environment" ' +
        'onchange="agSubirFoto(this,' + i + ')">' +
      '<span class="photo-cam">📷</span>' +
      '<span class="photo-lbl">' + esc(fo) + '</span>' +
      '<span class="photo-st" id="fst_' + i + '">' + (sub ? "✓" : "") + '</span>' +
    '</label>';
  }).join("");
}

// Sube una foto a Supabase Storage (bucket recepciones) y la asocia a la reserva.
function agSubirFoto(input, i) {
  var file = input.files && input.files[0];
  if (!file || !agRecSel) return;
  var vista = AGFOTOS[i];
  var slot = document.getElementById("slot_" + i);
  var st = document.getElementById("fst_" + i);
  var url = URL.createObjectURL(file);           // preview inmediato
  if (slot) { slot.style.backgroundImage = "url(" + url + ")"; slot.classList.add("has-photo"); }
  if (st) st.textContent = "Subiendo…";
  var carpeta = agFotoCarpeta();
  var slug = vista.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  var ext = ((file.type || "image/jpeg").split("/")[1] || "jpg").replace("jpeg", "jpg");
  var path = carpeta + "/" + slug + "_" + Date.now() + "." + ext;
  webSesion().then(function (s) {
    if (!s) throw new Error("sin sesión");
    return fetch(AGW.url + "/storage/v1/object/recepciones/" + encodeURI(path), {
      method: "POST",
      headers: {
        apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
        "Content-Type": file.type || "image/jpeg", "x-upsert": "true"
      },
      body: file
    });
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (st) st.textContent = "✓";
    agRecSel.fotos = agRecSel.fotos || {};
    agRecSel.fotos[vista] = { path: path, preview: url };
    save();
    // refleja las fotos en Supabase si la reserva existe allá
    if (agRecSel.webId && typeof webActualizarEstado === "function") {
      var paths = Object.keys(agRecSel.fotos).map(function (k) { return agRecSel.fotos[k].path; });
      webActualizarEstado(agRecSel.webId, null, { fotos: paths }).catch(function () {});
    }
  }).catch(function () {
    if (st) st.textContent = "✕ reintentar";
    if (slot) slot.classList.add("photo-err");
  });
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
  // Cierra el ciclo en Supabase si vino de una reserva web: la marca en_taller
  // con su RO para que toda estación vea que ya entró al taller (fail-safe).
  if (a.webId && typeof webActualizarEstado === "function") {
    webActualizarEstado(a.webId, "en_taller", { ro: o.ro, sucursal: a.sucursal || null })
      .catch(function () { /* offline: no bloquea la recepción local */ });
  }
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
  // Con la bandeja compartida esto ya no es "borrar lo mío": el vaciado viaja a
  // Supabase y lo ven todas las estaciones de la sucursal. El aviso lo dice.
  var suc = sucursalEstacion();
  if (!confirm("Esto borra TODOS los agendamientos y órdenes de " + suc +
               ", en esta y en las demás estaciones de la sucursal. ¿Continuar?")) return;
  DB = { agendamientos: [], orders: [], ocSeq: 1190001, roSeq: 60, webImp: {} };
  save();
  repintarTodo();
}

/* ============================================================
   Render global + init
   ============================================================ */
function renderAll() { renderPrep(); renderPlan(); renderJPCB(); renderBodega(); }

// Redibuja TODO: se usa cuando el estado cambió por fuera de la pantalla
// (fusión con lo que hizo otra estación, o cambio de sucursal).
function repintarTodo() {
  renderCal(); renderSlots(); renderAgendaTable(); renderAll();
}

function init() {
  restaurarSucursal();   // el selector manda qué bandeja se abre
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
  ["ov", "agOv", "webLoginOv", "webResOv"].forEach(function (id) {
    var el = document.getElementById(id);
    el.addEventListener("click", function (e) { if (e.target === el) el.classList.remove("open"); });
  });
  // reservas web: botón visible solo con la agenda configurada; si ya hay
  // sesión del personal, trae el contador de reservas nuevas en silencio
  if (webCfgOk()) {
    var btnW = document.getElementById("btnWebRes");
    btnW.hidden = false;
    btnW.addEventListener("click", webAbrir);
    webSesion().then(function (s) {
      if (!s) return;
      return webFetchReservas(s).then(function (rows) { WEBRES = rows || []; webBadge(); });
    }).catch(function () { /* sin red o sin permiso: el botón sigue operativo */ });
  }

  // cambiar de sucursal cambia la bandeja compartida que se está viendo
  var selSuc = document.getElementById("fComercio");
  if (selSuc) selSuc.addEventListener("change", alCambiarSucursal);

  // Las herramientas de prueba no van a la vista del equipo: con la bandeja
  // compartida, "Borrar todos los datos" vacía la sucursal completa. Quedan a
  // mano entrando con ?demo=1 (los botones siguen enganchados igual).
  var demoTools = document.querySelector(".demo-tools");
  if (demoTools && !/[?&]demo=1(&|$)/.test(location.search)) demoTools.style.display = "none";

  renderCal(); renderSlots(); renderAgendaTable();
  renderPrefillBanner();
  renderAll();

  // estado compartido con las demás estaciones de la sucursal (si hay sesión)
  iniciarSincronizacion();

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
