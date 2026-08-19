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
/* ---------------- personal de la sucursal ----------------
   Técnicos y asesores salen de la tabla `personal` de Supabase (nómina de
   RRHH), NO de una lista escrita acá: el repositorio es público y son datos
   personales de terceros. Además así las altas y bajas no necesitan un deploy.

   Se cargan al entrar y se filtran por la sucursal que opera la estación: la
   grilla del planificador con los 49 técnicos del país sería ilegible.
   Sin sesión o sin red quedan vacíos y la vista lo dice, en vez de inventar
   nombres.                                                                   */
var PERSONAL = [];        // [{rut, nombre, corto, rol, sucursal}]
var TECNICOS = [];        // los de la sucursal actual, en orden alfabético
var ASESORES = [];
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
/* Estado del kit de repuestos de una CITA.
   ------------------------------------------------------------
   Antes el tablero de preparación tenía cinco columnas que mezclaban dos ejes
   distintos: cuánto falta para la cita (3/2/1 días antes) y en qué va el kit
   (pedidos / recibidos). El primero es un dato que el sistema conoce EXACTO
   —está la fecha de la cita— y se le pedía a una persona que lo reflejara
   arrastrando tarjetas todos los días; si nadie arrastraba, la etiqueta mentía
   sin que nadie se enterara.

   Ahora el tiempo lo calcula el tablero (columnas por fecha) y este enum se
   queda solo con lo que el sistema NO puede saber: si alguien ya pidió los
   repuestos y si ya llegaron.                                                 */
var KIT = [
  { id: "por_revisar", t: "Por revisar", cls: "kit-rev" },
  { id: "pedido",      t: "Pedido",      cls: "kit-ped" },
  { id: "recibido",    t: "Recibido",    cls: "kit-rec" }
];
var AGAM = ["08:40", "09:00", "09:20", "09:40", "10:00", "10:20", "10:40", "11:00", "11:20", "11:40", "12:00", "12:20", "12:40"];
var AGPM = ["14:00", "14:20", "14:40", "15:00", "15:20", "15:40", "16:00", "16:20", "16:40", "17:00"];
var AGACC = ["Tag", "Sello verde", "Llaves", "Cono/tapas", "Patentes", "Gata", "Manivela", "Rueda Rpto.", "Extintor", "Documentos", "Pisos", "Encendedor", "Llave rueda", "Botiquín", "Antena", "Radio", "Parlantes", "Triángulos", "Herramientas", "CD"];
var AGFOTOS = ["Frente Izq", "Frente Der", "Posterior Izq", "Posterior Der", "Tapiz", "Parabrisas", "Tablero", "Adicional"];

/* Las fotos que SÍ o SÍ tienen que estar. "Adicional" queda fuera a propósito:
   es el recuadro para lo que aparezca —un daño puntual, algo que el cliente
   quiere dejar registrado— y muchas veces no hay nada que fotografiar.
   Exigirlo obligaría al asesor a sacar una foto de relleno solo para poder
   seguir, que es exactamente el problema que se está tratando de resolver. */
var AGFOTOS_OBLIGATORIAS = AGFOTOS.filter(function (v) { return v !== "Adicional"; });

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

/* ---------------- sellos de tiempo y responsable ----------------
   No había ni una marca de tiempo real en todo el flujo. Lo que se mostraba
   como "hora de recepción" era la hora de la CITA, no la hora en que llegó el
   auto, y no quedaba registro de quién recibió, quién firmó ni cuándo cambió
   de etapa. Para un taller eso es lo primero que se pregunta cuando el cliente
   reclama. Todo hito pasa por acá.                                            */
function ahoraISO() { return new Date().toISOString(); }

// Quién está operando esta estación. Sale de la sesión del personal; sin
// sesión queda null y el hito igual conserva su hora.
function quienSoy() {
  var s = webSesGuardada();
  return (s && s.email) || null;
}
function fmtHora(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit", hour12: false });
}
function fmtFechaHora(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleString("es-CL", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
}

// Anota un hito en la traza de la orden. Se acota a los últimos 40: la orden
// viaja dentro de la bandeja compartida y un historial sin techo la haría
// crecer sola, que es justo el problema que se está corrigiendo.
function anotar(o, que, detalle) {
  if (!o) return;
  o.hist = (o.hist || []).concat([{ q: que, d: detalle || null, en: ahoraISO(), por: quienSoy() }]);
  if (o.hist.length > 40) o.hist = o.hist.slice(-40);
}

/* ---------------- estado persistente ----------------
   El estado vive en localStorage (rápido y sirve sin red) y, si la estación
   tiene sesión del personal, se sincroniza con la bandeja compartida de su
   sucursal en Supabase. Ver el bloque "estado compartido" más abajo.
   La copia local se guarda por sucursal: cada bandeja es independiente.      */
/* Formato de los correlativos: 7 dígitos, y el primero dice de qué se trata.
   El agendamiento (OC) parte con 1 y la orden de trabajo (RO) con 2, así se
   distinguen de un vistazo y no se confunde una con otra al buscarlas.

   Son PISOS, no solo valores iniciales: al pedir un número siempre se manda el
   mayor entre el contador guardado y este mínimo. Sin eso, una estación que ya
   tenía su bandeja seguiría entregando los números viejos (iba en 61), porque
   el contador se lee de lo guardado y no del valor inicial de acá. */
var OC_MINIMO = 1190001;
var RO_MINIMO = 2000001;
var RO_DIGITOS = 7;

var DB = { agendamientos: [], orders: [], ocSeq: OC_MINIMO, roSeq: RO_MINIMO, webImp: {} };

/* El número tal como se muestra y se guarda: 7 dígitos. El relleno con ceros
   solo actúa sobre los números antiguos; los nuevos ya nacen con 7. */
function formatearRO(n) {
  return String(n).padStart(RO_DIGITOS, "0");
}

function tkeyDe(suc) { return TKEY + "::" + (suc || ""); }

function cargarDB() {
  var suc = sucursalEstacion();
  if (!suc) {   // todavía no eligió sucursal: se parte en blanco, sin leer nada
    DB = { agendamientos: [], orders: [], ocSeq: OC_MINIMO, roSeq: RO_MINIMO, webImp: {} };
    return;
  }
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
  DB = { agendamientos: [], orders: [], ocSeq: OC_MINIMO, roSeq: RO_MINIMO, webImp: {} };
  try {
    if (raw) { var d = JSON.parse(raw); if (d && d.agendamientos && d.orders) DB = d; }
  } catch (e) { /* estado corrupto: se parte de cero */ }
  if (!DB.webImp) DB.webImp = {};   // ids de reservas web ya pasadas a la agenda
  asegurarUids(DB);
}

var _sinEspacio = false;

function guardarLocal() {
  var suc = sucursalEstacion();
  if (!suc) return;   // sin sucursal elegida no hay bandeja donde guardar
  asegurarUids(DB);   // nada se persiste ni se sube sin identidad propia
  try {
    localStorage.setItem(tkeyDe(suc), JSON.stringify(DB));
    if (_sinEspacio) { _sinEspacio = false; avisoAlmacenamiento(); }
  } catch (e) {
    // Antes esto se tragaba en silencio: al llegar al tope de localStorage
    // (~5 MB) la estación seguía trabajando y NADA se guardaba, sin que nadie
    // se enterara. Ahora se avisa y se intenta liberar archivando lo cerrado.
    if (!_sinEspacio) {
      _sinEspacio = true;
      avisoAlmacenamiento();
      try { podarBandeja(); } catch (e2) { /* sin red: queda el aviso */ }
    }
  }
}

// Barra de aviso: el trabajo NO se está guardando en este navegador. Se crea
// al vuelo para no dejar markup muerto en las tres vistas.
function avisoAlmacenamiento() {
  var el = document.getElementById("avisoDisco");
  if (!_sinEspacio) { if (el) el.remove(); return; }
  if (el) return;
  el = document.createElement("div");
  el.id = "avisoDisco";
  el.className = "aviso-disco";
  el.innerHTML = "⚠ <b>No se está guardando en este equipo</b>: se llenó el " +
    "almacenamiento del navegador. Lo que ya está sincronizado sigue en la " +
    "bandeja de la sucursal, pero avisa a soporte antes de seguir cargando datos.";
  document.body.appendChild(el);
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
var SYNC = { base: null, version: 0, sucursal: null, timer: null, enVuelo: false, pendiente: false, poll: null, fallos: 0 };

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

// La sucursal FIJADA por esta estación, o null si todavía no eligió ninguna.
function sucursalGuardada() {
  try { return localStorage.getItem(SUCKEY) || null; } catch (e) { return null; }
}

// Devuelve "" mientras la estación no haya elegido su sucursal. A propósito no
// se asume ninguna: con la bandeja compartida, escribir en la sucursal
// equivocada mezcla las citas de dos talleres.
function sucursalEstacion() {
  var g = sucursalGuardada();
  if (g) return g;
  var sel = document.getElementById("fComercio");
  return (sel && sel.value) || "";
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
  // si todavía no eligió, no se guarda nada: el selector queda en el aviso
  if (!g) return;
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

  // Los pisos también valen acá: al renumerar por un choque, el número nuevo
  // tiene que respetar el formato, no volver a la numeración antigua.
  var sigOc = Math.max(mio.ocSeq || 0, suyo.ocSeq || 0, OC_MINIMO);
  var sigRo = Math.max(mio.roSeq || 0, suyo.roSeq || 0, RO_MINIMO);
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
    if (duenio && duenio !== o.uid) { o.ro = formatearRO(sigRo++); movidos++; }
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
      SYNC.fallos = 0;
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
  }).catch(function () { SYNC.fallos++; return false; })
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
      SYNC.fallos = 0;
      if (!row || row.version === SYNC.version) return false;
      DB = fusionar(SYNC.base, DB, row.data || {});
      SYNC.version = row.version;
      SYNC.base = JSON.parse(JSON.stringify(row.data || {}));
      guardarLocal();
      repintarTodo();
      agendarSync();                            // por si mi fusión aportó algo
      return true;
    });
  }).catch(function () { SYNC.fallos++; return false; });
}

// Sondeo con freno: si el backend no responde (tabla que aún no existe, RLS,
// caída), pasar de 15 s a 5 min evita miles de peticiones fallidas por estación
// al día. Vuelve al ritmo normal en cuanto una respuesta llega bien.
function _programarSondeo() {
  if (SYNC.poll) clearTimeout(SYNC.poll);
  SYNC.poll = setTimeout(function () {
    // La poda va colgada del sondeo y no del guardado: archivar no puede
    // meterle latencia a un asesor apretando "Guardar". Ella misma se limita a
    // una pasada cada 10 minutos.
    refrescarRemoto()
      .then(function () { return refrescarReservas(); })
      .then(function () { return podarBandeja(); })
      // Las columnas del tablero de preparación se calculan desde la fecha,
      // pero nada las repinta cuando cambia el día: un tablero abierto toda la
      // noche amanecería mostrando las citas de ayer como "Hoy". Se cuelga del
      // mismo sondeo, que es lo único que corre siempre.
      .then(function () { if (_prepDia && _prepDia !== hoyISO()) repintarTodo(); })
      // Solicitudes que alguien tomó y nunca agendó vuelven solas a la cola.
      .then(function () { return liberarGestionesViejas(); })
      .then(_programarSondeo, _programarSondeo);
  }, SYNC.fallos >= 3 ? 300000 : 15000);
}

function iniciarSincronizacion() {
  if (!webCfgOk() || !sucursalEstacion()) return;
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

  _programarSondeo();
}

// El selector de sucursal de la agenda manda: cambia la bandeja que se ve.
function alCambiarSucursal() {
  var sel = document.getElementById("fComercio");
  // se compara contra la sucursal FIJADA, no contra sucursalEstacion(): mientras
  // no haya ninguna fijada, esa función devuelve el propio valor del selector y
  // la comparación siempre daría igual, sin llegar a guardar la elección.
  if (!sel || !sel.value || sel.value === sucursalGuardada()) return;
  guardarLocal();                               // cierro la bandeja anterior
  try { localStorage.setItem(SUCKEY, sel.value); } catch (e) { }
  cargarDB();                                   // abro la de la sucursal nueva
  refrescarPersonalSucursal();                  // sus técnicos y sus asesores
  repintarTodo();
  iniciarSincronizacion();
}

/* ============================================================
   PODA Y ARCHIVO DE LA BANDEJA  (tabla taller_archivo)
   ------------------------------------------------------------
   La bandeja de la sucursal es UN documento JSON que viaja entero en cada
   guardado y que hasta ahora solo crecía. Con un año de operación —miles de
   citas y órdenes— cada sync mandaría un archivo enorme y, antes de eso,
   localStorage (~5 MB) dejaría de guardar.

   Acá se saca de la bandeja lo que ya está cerrado y se deja en
   taller_archivo, UNA FILA POR ENTIDAD (que es como debería haber vivido
   siempre). La bandeja queda acotada a lo que está vivo y la historia se
   conserva completa, además consultable sin abrir el bloque entero.

   Regla de oro: nunca se poda antes de tener la confirmación del servidor. Si
   el archivo falla, no se borra absolutamente nada.
   ============================================================ */
var ARCH_TABLA = "taller_archivo";
var ARCH_DIAS = 45;                  // ventana viva de la bandeja
var ARCH_MIN_MS = 10 * 60 * 1000;    // como mucho una pasada cada 10 min
var _archUltima = 0;

function _fechaCorte() {
  var d = new Date();
  d.setDate(d.getDate() - ARCH_DIAS);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// Qué se puede archivar: citas viejas que ya no tienen una orden viva, y
// órdenes viejas ya entregadas. Todo lo que siga en el taller se queda, por
// antiguo que sea: un auto detenido esperando repuestos hace tres meses no
// puede desaparecer del JPCB.
function _loArchivable() {
  var corte = _fechaCorte();
  var ocsVivas = {};
  DB.orders.forEach(function (o) { if (o.etapa !== "entregado") ocsVivas[String(o.oc)] = 1; });
  return {
    ags: DB.agendamientos.filter(function (a) {
      return a.fecha && a.fecha < corte && !ocsVivas[String(a.oc)];
    }),
    ords: DB.orders.filter(function (o) {
      return o.fecha && o.fecha < corte && o.etapa === "entregado";
    })
  };
}

function _filaArchivo(x, tipo) {
  return {
    uid: x.uid,
    sucursal: SYNC.sucursal || sucursalEstacion(),
    tipo: tipo,
    ref: String(tipo === "orden" ? x.ro : x.oc),
    fecha: x.fecha || null,
    patente: x.pat || null,
    data: x
  };
}

function podarBandeja() {
  if (!webCfgOk() || SYNC.enVuelo) return Promise.resolve(0);
  if (Date.now() - _archUltima < ARCH_MIN_MS) return Promise.resolve(0);
  if (!(SYNC.sucursal || sucursalEstacion())) return Promise.resolve(0);
  asegurarUids(DB);
  var lote = _loArchivable();
  if (!lote.ags.length && !lote.ords.length) { _archUltima = Date.now(); return Promise.resolve(0); }
  var filas = lote.ags.map(function (a) { return _filaArchivo(a, "agendamiento"); })
    .concat(lote.ords.map(function (o) { return _filaArchivo(o, "orden"); }));

  return webSesion().then(function (s) {
    if (!s) return 0;                       // sin login no se archiva ni se poda
    return fetch(AGW.url + "/rest/v1/" + ARCH_TABLA, {
      method: "POST",
      headers: {
        apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
        "Content-Type": "application/json",
        // merge-duplicates: reintentar es inofensivo, la fila se reescribe
        Prefer: "resolution=merge-duplicates,return=minimal"
      },
      body: JSON.stringify(filas)
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      // recién con el archivo confirmado se saca de la bandeja
      var fuera = {};
      filas.forEach(function (f) { fuera[f.uid] = 1; });
      DB.agendamientos = DB.agendamientos.filter(function (a) { return !fuera[a.uid]; });
      DB.orders = DB.orders.filter(function (o) { return !fuera[o.uid]; });
      podarWebImp();
      _archUltima = Date.now();
      save();                               // la poda viaja como un borrado normal
      repintarTodo();
      return filas.length;
    });
  }).catch(function () { return 0; });      // sin red: se reintenta más rato
}

// webImp es un diccionario de ids de reserva que también crecía sin techo.
// Solo se poda cuando la lista del servidor está cargada: sin ella no se puede
// distinguir "ya la gestioné" de "todavía no la veo", y borrar la marca haría
// reaparecer solicitudes ya atendidas.
function podarWebImp() {
  if (!WEBRES || !WEBRES.length) return;
  var vivos = {};
  DB.agendamientos.forEach(function (a) { if (a.webId) vivos[a.webId] = 1; });
  WEBRES.forEach(function (r) { if (r && r.id) vivos[r.id] = 1; });
  var nuevo = {};
  Object.keys(DB.webImp || {}).forEach(function (k) { if (vivos[k]) nuevo[k] = 1; });
  DB.webImp = nuevo;
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

/* Aviso inline de la agenda. Reemplaza a los alert() en el flujo de las
   solicitudes web: un alert congela el JavaScript —y con él el sondeo de
   sincronización—, el navegador puede suprimirlo tras el segundo, y tapa
   justo la fila de la que está hablando. */
var _avisoTimer = null;
function avisoAgenda(texto, tipo) {
  var el = document.getElementById("agAviso");
  if (!el) return;
  clearTimeout(_avisoTimer);
  el.textContent = texto;
  el.className = "ag-aviso ag-aviso--" + (tipo || "info");
  el.hidden = false;
  // los de éxito se van solos; los de advertencia se quedan hasta el siguiente
  if (tipo === "ok" || tipo === "info") {
    _avisoTimer = setTimeout(function () { el.hidden = true; }, 6000);
  }
}

/* ============================================================
   1 · AGENDAMIENTO — calendario real + slots
   ============================================================ */
var hoy = new Date();
var calY = hoy.getFullYear(), calM = hoy.getMonth();
var selFecha = hoyISO();

// Días con citas, de TODAS las sucursales: el calendario de la central no puede
// marcar solo los de la bandeja abierta.
function fechasConAgenda() {
  var s = {};
  DB.agendamientos.forEach(function (a) { if (a.estado !== "anulado") s[a.fecha] = 1; });
  (WEBRES || []).forEach(function (r) {
    if (r && r.fecha && ["agendada", "recibida", "en_taller", "cerrada"].indexOf(r.estado) >= 0) s[r.fecha] = 1;
  });
  return s;
}
function renderCal() {
  var titulo = new Date(calY, calM, 1).toLocaleDateString("es-CL", { month: "long", year: "numeric" });
  document.getElementById("calTitulo").textContent = titulo;
  var primero = new Date(calY, calM, 1);
  var dias = new Date(calY, calM + 1, 0).getDate();
  var dow = (primero.getDay() + 6) % 7; // lunes = 0
  var marcadas = fechasConAgenda();
  var conSolicitud = fechasConSolicitud();
  var hoyStr = hoyISO();
  var html = "<tr><th>Lu</th><th>Ma</th><th>Mi</th><th>Ju</th><th>Vi</th><th>Sa</th><th>Do</th></tr><tr>";
  var celda = 0;
  for (var i = 0; i < dow; i++) { html += '<td class="off"></td>'; celda++; }
  for (var d = 1; d <= dias; d++) {
    var iso = calY + "-" + String(calM + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    var cls = [];
    if (iso === selFecha) cls.push("on");
    if (iso === hoyStr) cls.push("hoy");
    html += '<td class="' + cls.join(" ") + '" data-f="' + iso + '">' + d +
      (marcadas[iso] ? '<span class="dot"></span>' : "") +
      (conSolicitud[iso] ? '<span class="dot dot-web" title="Hay una solicitud de cliente sin confirmar"></span>' : "") +
      "</td>";
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
/* Horas ya tomadas de un día. `excluirUid` deja fuera una cita puntual: al
   corregir una cita su propia hora no puede contar como ocupada, si no el
   sistema le diría al asesor que su propio cupo está tomado. */
function horasOcupadas(fecha, excluirUid) {
  var dia = fecha || selFecha;
  var s = {};
  DB.agendamientos.forEach(function (a) {
    if (a.fecha !== dia || a.estado === "anulado") return;
    if (excluirUid && a.uid === excluirUid) return;
    s[a.hora] = 1;
  });
  return s;
}

/* Horas con MÁS DE UNA cita el mismo día en la misma sucursal.
   La revalidación al guardar ataja casi todo, pero no puede atajar el caso en
   que dos estaciones guardan al mismo tiempo, offline: ahí la fusión conserva
   las dos citas porque tienen uid distinto y quedan idénticas a cualquier otra.
   Detectarlas y marcarlas es la diferencia entre resolverlo por teléfono el día
   anterior y descubrirlo con los dos autos en la puerta. */
function horasEnConflicto(fecha) {
  var cuenta = {}, out = {};
  DB.agendamientos.forEach(function (a) {
    if (a.estado === "anulado" || !a.hora) return;
    if (fecha && a.fecha !== fecha) return;
    var k = [a.sucursal || "", a.fecha, a.hora].join("|");
    cuenta[k] = (cuenta[k] || 0) + 1;
    if (cuenta[k] > 1) out[a.hora] = (out[a.hora] || 1) + 1;
  });
  return out;
}

/* ---- solicitudes del cliente (autoagendas) ----
   Las horas que pidió un cliente por la web se muestran EN la agenda, no
   escondidas tras un botón: si nadie abre ese modal, la solicitud queda
   invisible y el cliente sin respuesta. Devuelve los índices en WEBRES para
   poder confirmarlas con webPasar(). */
// ¿Esta reserva es de la sucursal que opera esta estación? NO se usa para
// esconder nada: la agenda la ocupa la central y tiene que ver todas las
// sucursales. Sirve solo para marcar de cuál es cada cita y para saber si esta
// estación puede recibir el vehículo (recibir se hace en la sucursal, no en la
// central).
function webEsDeMiSucursal(r) {
  if (!r || !r.sucursal) return true;
  var suc = sucursalEstacion();
  return !suc || r.sucursal === suc;
}

/* Pendientes = lo que el SERVIDOR dice que sigue sin atender.
   Ya no se mira DB.webImp. Esa marca local no se puede revertir de forma
   confiable: fusionar() hace Object.assign de webImp sin comparar contra la
   base, así que una marca ya sincronizada resucita en el siguiente choque —
   una solicitud abandonada quedaba escondida para siempre. El reclamo vive
   ahora en el servidor ('en_gestion'), que sí se puede soltar. */
function webPendientes(fecha) {
  var out = [];
  (WEBRES || []).forEach(function (r, i) {
    if (r && (!r.estado || r.estado === "nueva") && (!fecha || r.fecha === fecha)) out.push({ i: i, r: r });
  });
  return out;
}

/* ---- todas las citas del día, de TODAS las sucursales ----
   La bandeja local (DB) solo tiene la sucursal que esta estación abrió, pero
   la agenda la usa la central: tiene que ver el país entero. reservas_web ya
   es la única verdad de la cita, así que la vista une lo propio (que además
   trae el estado operativo del taller) con lo que hay en el servidor.

   Las de otras sucursales van marcadas y en solo lectura: recibir un vehículo
   se hace en la sucursal donde está el auto. */
function citasVisibles(fecha) {
  var suc = sucursalEstacion();
  var out = [], vistas = {};
  DB.agendamientos.forEach(function (a) {
    if (fecha && a.fecha !== fecha) return;
    if (a.webId) vistas[a.webId] = 1;
    vistas[[a.pat, a.fecha].join("|")] = 1;
    out.push({ a: a, suc: a.sucursal || suc || null, propia: true });
  });
  (WEBRES || []).forEach(function (r) {
    if (!r || !r.fecha || (fecha && r.fecha !== fecha)) return;
    if (["agendada", "recibida", "en_taller", "cerrada"].indexOf(r.estado) < 0) return;  // las 'nueva' son solicitudes, van aparte
    if (vistas[r.id] || vistas[[r.patente, r.fecha].join("|")]) return;
    out.push({ a: _agDesdeReserva(r), suc: r.sucursal || null, propia: false });
  });
  return out.sort(function (x, y) { return (x.a.hora || "") < (y.a.hora || "") ? -1 : 1; });
}
function fechasConSolicitud() {
  var s = {};
  webPendientes(null).forEach(function (p) { s[p.r.fecha] = 1; });
  return s;
}
/* ---------------- vista de mes ----------------
   Muestra el mes completo con las citas dentro de cada día. El calendario chico
   del panel solo dice "hay algo"; acá se ve QUÉ hay y cuánta carga tiene cada
   día, que es lo que necesita el call center para repartir horas. */
var vistaAgenda = "dia";

function agCambiarVista(v) {
  vistaAgenda = v;
  document.getElementById("vistaDia").hidden = (v !== "dia");
  document.getElementById("vistaMes").hidden = (v !== "mes");
  document.querySelectorAll(".ag-vista-btn").forEach(function (b) {
    b.classList.toggle("is-on", b.dataset.vista === v);
  });
  if (v === "mes") renderMes();
}

function renderMes() {
  var cont = document.getElementById("mesGrid");
  if (!cont) return;
  document.getElementById("mesTitulo").textContent =
    new Date(calY, calM, 1).toLocaleDateString("es-CL", { month: "long", year: "numeric" });

  // citas y solicitudes agrupadas por fecha, una sola pasada por cada lista.
  // Van todas las sucursales: la vista de mes es la carga del país, no la de
  // una bandeja.
  var porFecha = {};
  citasVisibles(null).forEach(function (c) {
    var a = c.a;
    if (a.estado === "anulado") return;
    (porFecha[a.fecha] = porFecha[a.fecha] || []).push({
      hora: a.hora || "",
      txt: (a.hora ? a.hora + " " : "") + (a.pat || a.cli || ""),
      suc: c.suc ? sucCorta(c.suc) : "",
      cls: a.estado === "en_taller" ? "taller" : a.estado === "entregado" ? "taller" : "ag"
    });
  });
  webPendientes(null).forEach(function (p) {
    var r = p.r, h = (r.hora && r.hora !== "indiferente") ? r.hora : "";
    (porFecha[r.fecha] = porFecha[r.fecha] || []).push({
      hora: h, txt: (h ? h + " " : "") + (r.patente || r.nombre || "cliente"), cls: "web"
    });
  });
  Object.keys(porFecha).forEach(function (f) {
    porFecha[f].sort(function (x, y) { return x.hora < y.hora ? -1 : 1; });
  });

  var html = ["Lu", "Ma", "Mi", "Ju", "Vi", "Sa", "Do"]
    .map(function (d) { return '<div class="mes-dow">' + d + "</div>"; }).join("");
  var primero = new Date(calY, calM, 1);
  var dow = (primero.getDay() + 6) % 7;              // lunes = 0
  var dias = new Date(calY, calM + 1, 0).getDate();
  var hoyStr = hoyISO();

  for (var i = 0; i < dow; i++) html += '<div class="mes-dia fuera"></div>';
  for (var d = 1; d <= dias; d++) {
    var iso = calY + "-" + String(calM + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
    var cls = ["mes-dia"];
    if (iso === hoyStr) cls.push("hoy");
    if (iso === selFecha) cls.push("sel");
    var items = porFecha[iso] || [];
    // se muestran 3 y el resto se resume, para que la celda no crezca sin control
    var visibles = items.slice(0, 3).map(function (it) {
      var tit = it.txt + (it.suc ? " · " + it.suc : "");
      return '<span class="mes-cita mes-cita--' + it.cls + '" title="' + esc(tit) + '">' + esc(tit) + "</span>";
    }).join("");
    var resto = items.length > 3 ? '<span class="mes-mas">+' + (items.length - 3) + " más</span>" : "";
    html += '<div class="' + cls.join(" ") + '" data-f="' + iso + '">' +
      '<span class="mes-num">' + d + "</span>" + visibles + resto + "</div>";
  }
  cont.innerHTML = html;

  cont.querySelectorAll(".mes-dia[data-f]").forEach(function (el) {
    el.addEventListener("click", function () {
      selFecha = el.dataset.f;
      agCambiarVista("dia");                        // al pinchar un día se abre ese día
      renderCal(); renderSlots(); renderAgendaTable();
    });
  });
}

function renderSlots() {
  document.getElementById("fechaSelTxt").textContent = fmtFechaLarga(selFecha);
  var st = document.getElementById("sucSelTxt");
  if (st) st.textContent = sucursalEstacion() ? sucCorta(sucursalEstacion()) : "tu sucursal";
  var ocup = horasOcupadas();
  var choque = horasEnConflicto(selFecha);
  // Sin sucursal elegida los cupos no significan nada: son POR sucursal. Antes
  // se pintaban todos libres y clicables, y el asesor recién se enteraba con un
  // alert después de haber elegido una hora. Prevenir es mejor que corregir.
  var suc = sucursalEstacion();
  var aviso = document.getElementById("agSinSucursal");
  if (aviso) aviso.hidden = !!suc;
  // ¿quién ocupa cada hora? para decirlo en el tooltip en vez de solo "ocupado"
  var quien = {};
  DB.agendamientos.forEach(function (a) {
    if (a.fecha !== selFecha || a.estado === "anulado" || !a.hora) return;
    (quien[a.hora] = quien[a.hora] || []).push((a.pat || "?") + (a.cli ? " · " + a.cli : ""));
  });
  // hora pedida por un cliente y todavía sin confirmar
  var pedidas = {};
  webPendientes(selFecha).forEach(function (p) { if (p.r.hora) pedidas[p.r.hora] = p.i; });
  function fill(cont, arr) {
    cont.innerHTML = "";
    arr.forEach(function (h) {
      var busy = !!ocup[h];
      var pedida = !busy && pedidas[h] !== undefined;
      var d = document.createElement("div");
      d.className = "ag-slot " + (!suc ? "off" : busy ? "busy" : pedida ? "web" : "free") +
                    (choque[h] ? " choque" : "");
      d.textContent = h;
      if (!suc) {
        d.title = "Elige tu sucursal para ver qué horas están libres";
      } else if (choque[h]) {
        d.title = "⚠ " + choque[h] + " citas a la misma hora: " + (quien[h] || []).join(" · ") +
                  ". Hay que resolverlo con el cliente.";
      } else if (busy) {
        d.title = "Ocupado: " + (quien[h] || []).join(" · ");
      }
      if (!suc) { /* sin sucursal no se agenda nada */ }
      else if (pedida) {
        d.title = "Solicitud de un cliente por la web — clic para confirmarla";
        d.onclick = function () { webPasar(pedidas[h]); };
      } else if (!busy) {
        d.onclick = function () { agAbrirModal(h); };
      }
      cont.appendChild(d);
    });
  }
  fill(document.getElementById("agSlotsAM"), AGAM);
  fill(document.getElementById("agSlotsPM"), AGPM);
}
function renderAgendaTable() {
  var t = document.getElementById("tblAgenda");
  // La central ve TODAS las sucursales, no solo la bandeja abierta en esta
  // estación. Ver citasVisibles().
  var lista = citasVisibles(selFecha);

  // Las solicitudes que hizo el cliente por la web van arriba, marcadas y con
  // su botón para confirmarlas. Es lo que el call center tiene que atender.
  var solicitudes = webPendientes(selFecha).sort(function (x, y) {
    return (x.r.hora || "") < (y.r.hora || "") ? -1 : 1;
  });
  var filasWeb = solicitudes.map(function (p) {
    var r = p.r;
    var auto = [r.marca, r.modelo].filter(Boolean).join(" ") || "—";
    var hora = r.hora === "indiferente" || !r.hora ? "por definir" : r.hora;
    return '<tr class="fila-web">' +
      '<td>web</td><td>' + esc(hora) + "</td><td>" + esc(r.nombre || "—") + "</td><td>" + esc(auto) +
      "</td><td>" + esc(r.patente || "—") + "</td><td>" +
      (r.rev_n ? "Mantención " + esc(String(r.rev_n)) : "Por definir") + "</td>" +
      "<td>" + (r.sucursal ? esc(sucCorta(r.sucursal)) : '<i style="color:var(--ink-3)">por asignar</i>') + "</td>" +
      '<td><span class="ag-pill web">Solicitud del cliente</span></td>' +
      '<td><button class="agbtn agbtn-blue agbtn-sm" onclick="webPasar(' + p.i + ')">Confirmar</button></td>' +
      "</tr>";
  }).join("");

  // el panel de recibidos va siempre con la tabla: misma fecha, mismo refresco
  renderRecepDia();

  if (!lista.length && !filasWeb) {
    t.innerHTML = '<tr><td colspan="9" style="color:var(--ink-3);padding:16px">' +
      "Sin agendamientos para esta fecha en ninguna sucursal.</td></tr>";
    return;
  }
  var miSuc = sucursalEstacion();
  t.innerHTML = filasWeb + lista.map(function (c) {
    var a = c.a;
    var est = a.estado === "agendado" ? '<span class="ag-pill por">Agendado</span>'
      : a.estado === "en_taller" ? '<span class="ag-pill en">En taller</span>'
      : a.estado === "anulado"
        ? '<span class="ag-pill anu" title="' + esc("Anulada el " + fmtFechaHora(a.anuladoEn) +
            (a.anuladoPor ? " por " + a.anuladoPor : "")) + '">Anulado</span>'
      : '<span class="ag-pill ent">Entregado</span>';
    // Recibir el vehículo se hace EN la sucursal, que es donde está el auto y
    // donde vive su bandeja. Desde la central se ve y se puede anular (eso viaja
    // por el servidor y llega a la sucursal), pero no se recibe.
    var acc = "";
    if (a.estado === "agendado") {
      if (c.propia && (!c.suc || !miSuc || c.suc === miSuc)) {
        acc = '<button class="agbtn agbtn-blue agbtn-sm" onclick="agAbrirRecepcion(' + a.oc + ')">Ingresar</button> ';
      }
      // Corregir se puede desde cualquier estación, igual que anular: el error
      // lo suele detectar quien atiende el teléfono, no la sucursal.
      if (c.propia) {
        acc += '<button class="agbtn agbtn-grey agbtn-sm" onclick="agEditarCita(' + a.oc + ')">Editar</button> ';
      }
      acc += '<button class="agbtn agbtn-red agbtn-sm" onclick="agAnular(\'' +
             esc(String(a.webId || a.oc)) + '\')">Anular</button>';
    }
    // los campos que pueden faltar se muestran como "—" en vez de imprimir
    // "undefined", y se escapan porque son datos escritos por personas
    var auto = [a.marcaNombre, a.modeloNombre].filter(Boolean).join(" ");
    var ajena = c.suc && miSuc && c.suc !== miSuc;
    return '<tr class="' + (a.estado === "anulado" ? "fila-anulada " : "") +
      (ajena ? "fila-otra-suc" : "") + '"><td>' +
      esc(String(a.oc == null ? "—" : a.oc)) + "</td><td>" + esc(a.hora || "—") +
      "</td><td>" + esc(a.cli || "—") +
      // Si la cita trae comentario se avisa acá: es lo que hay que leer ANTES
      // de que llegue el auto, y en la tabla no cabe entero.
      (a.coment ? ' <span class="ag-tiene-coment" title="' + esc(a.coment) + '">💬</span>' : "") +
      "</td><td>" + esc(auto || "—") +
      "</td><td>" + esc(a.pat || "—") + "</td><td>" + esc(a.serv || "—") +
      '</td><td><span class="celda-suc" title="' + esc(c.suc || "sin sucursal asignada") + '">' +
      esc(c.suc ? sucCorta(c.suc) : "—") + "</span></td><td>" + est + "</td><td>" + acc + "</td></tr>";
  }).join("");
}

// "CURIFOR CHILLÁN VIEJO" -> "Chillán Viejo". El prefijo se repite en las 12
// sucursales y en una columna estrecha solo gasta ancho.
function sucCorta(s) {
  if (!s) return "—";
  var t = String(s).replace(/^CURIFOR\s+/i, "");
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}
/* ---- panel de recibidos del día ----
   La recepción se hace en su propio módulo, así que la agenda no puede saber
   "qué pasó con el auto" mirando solo sus citas. Este panel muestra los que ya
   entraron: en qué etapa van, y si quedaron con fotos y firmas. */
function renderRecepDia() {
  var cont = document.getElementById("recepDia");
  if (!cont) return;
  var lista = document.getElementById("recepDiaLista");
  var ordenes = DB.orders.filter(function (o) { return o.fecha === selFecha; })
    .sort(function (a, b) { return (a.recibidoEn || a.rec || "") < (b.recibidoEn || b.rec || "") ? -1 : 1; });

  if (!ordenes.length) { cont.hidden = true; return; }
  cont.hidden = false;
  document.getElementById("recepDiaFecha").textContent = "· " + fmtFechaCorta(selFecha);

  lista.innerHTML = ordenes.map(function (o) {
    var etapa = ETAPAS.find(function (e) { return e.id === o.etapa; });
    var a = o.oc != null ? agFind(o.oc) : null;
    var nFotos = a && a.fotos ? Object.keys(a.fotos).length : 0;
    var nFirmas = a && a.firmas ? Object.keys(a.firmas).length : 0;
    var detenido = o.stop ? (STOPS.find(function (s) { return s.id === o.stop; }) || {}).t : null;
    // Hora REAL de llegada. Si la orden es anterior a que existiera el sello se
    // muestra la de la cita, pero marcada como tal para no confundirlas.
    var llegada = o.recibidoEn
      ? { txt: fmtHora(o.recibidoEn), tit: "Llegada real: " + fmtFechaHora(o.recibidoEn) +
            (o.recibidoPor ? " · recibió " + o.recibidoPor : ""), real: true }
      : { txt: o.rec || "", tit: "Hora de la cita (sin registro de llegada real)", real: false };
    // Estado del acta: los tres datos que respaldan al taller si hay reclamo.
    var nAcc = o.acc ? Object.keys(o.acc).length : 0;
    var actaOk = (o.kmReal != null) && !!o.comb;
    return '<div class="recep-item' + (detenido ? " recep-item--stop" : "") +
      '" role="button" tabindex="0" title="Ver el detalle de la recepción"' +
      ' onclick="agVerRecepcion(\'' + esc(String(o.ro)) + '\')"' +
      ' onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();agVerRecepcion(\'' + esc(String(o.ro)) + '\');}">' +
      '<div class="recep-item__cab"><b>' + esc(o.pat || "—") + "</b>" +
        '<span class="recep-item__ro">RO ' + esc(o.ro) + "</span>" +
        (llegada.txt
          ? '<span class="recep-item__hora' + (llegada.real ? "" : " es-cita") + '" title="' +
            esc(llegada.tit) + '">' + (llegada.real ? "" : "~") + esc(llegada.txt) + "</span>"
          : "") + "</div>" +
      '<div class="recep-item__det">' + esc(o.cliente || "—") +
        (o.marca || o.modelo ? " · " + esc([o.marca, o.modelo].filter(Boolean).join(" ")) : "") + "</div>" +
      '<div class="recep-item__pie">' +
        '<span class="recep-pill">' + esc(detenido || (etapa && etapa.t) || o.etapa || "—") + "</span>" +
        '<span class="recep-ico" title="fotos de la inspección">📷 ' + nFotos + "</span>" +
        '<span class="recep-ico' + (nFirmas >= 2 ? " ok" : "") + '" title="firmas del acta">✍ ' + nFirmas + "/2</span>" +
        '<span class="recep-ico' + (actaOk ? " ok" : " falta") + '" title="' +
          esc("Acta: " + (o.kmReal != null ? o.kmReal.toLocaleString("es-CL") + " km" : "sin km real") +
              " · combustible " + (o.comb || "sin registrar") + " · " + nAcc + " accesorios") +
          '">📋 ' + (actaOk ? "✓" : "!") + "</span>" +
      "</div></div>";
  }).join("");
}

/* ============================================================
   Detalle de una recepción ya hecha

   La tarjeta de RECIBIDOS resume en cuatro íconos lo que se llenó en el mesón.
   Cuando alguien pregunta "¿con cuánta bencina llegó?" o "¿le sacaron foto al
   tablero?", eso no se responde con un ícono. Acá está todo, incluidas las
   fotos y las firmas, que viven en el bucket privado.
   ============================================================ */

/* Enlace temporal para ver un archivo del bucket privado. Sin esto las fotos
   no se pueden mostrar: `recepciones` no es público a propósito. */
function webUrlFirmada(path, segundos) {
  if (!path || !webCfgOk()) return Promise.resolve(null);
  return webSesion().then(function (s) {
    if (!s) return null;
    return fetch(AGW.url + "/storage/v1/object/sign/recepciones/" + encodeURI(path), {
      method: "POST",
      headers: {
        apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ expiresIn: segundos || 3600 })
    }).then(function (r) { return r.ok ? r.json() : null; });
  }).then(function (j) {
    return j && j.signedURL ? AGW.url + "/storage/v1" + j.signedURL : null;
  }).catch(function () { return null; });
}

var _recDetActual = null;

function agVerRecepcion(ro) {
  var o = byRo(String(ro));
  if (!o) { avisoAgenda("No se encontró la orden RO " + ro + ".", "warn"); return; }
  var a = o.oc != null ? agFind(o.oc) : null;
  _recDetActual = { o: o, a: a };

  document.getElementById("recDetTitulo").textContent =
    (o.pat || "—") + " · RO " + o.ro;
  document.getElementById("recDetSub").textContent =
    [o.cliente, [o.marca, o.modelo].filter(Boolean).join(" "),
     o.oc != null ? "cita " + o.oc : null].filter(Boolean).join(" · ");

  document.getElementById("recDetCuerpo").innerHTML = _recDetHTML(o, a);
  document.getElementById("recDetOv").classList.add("open");
  document.getElementById("recDetPdf").onclick = function () { _recDetPDF(o, a); };

  // Las fotos y firmas se piden después de pintar: cada una necesita su enlace
  // firmado y no tiene sentido dejar la pantalla en blanco esperándolas.
  _recDetCargarImagenes(a);
}

function agCerrarDetalle() {
  document.getElementById("recDetOv").classList.remove("open");
  _recDetActual = null;
}

function _recDetHTML(o, a) {
  var acc = o.acc || (a && a.acc) || {};
  var presentes = AGACC.filter(function (x) { return acc[x]; });
  var ausentes = AGACC.filter(function (x) { return !acc[x]; });
  var coment = (o.coment || (a && a.coment) || "").trim();
  var obs = (o.obs || (a && a.obs) || "").trim();
  var kmReal = o.kmReal != null ? o.kmReal : (a && a.kmReal != null ? a.kmReal : null);
  var comb = o.comb || (a && a.comb) || null;
  var fotos = (a && a.fotos) || {};
  var firmas = (a && a.firmas) || {};

  function fila(t, v, falta) {
    return "<dt>" + esc(t) + "</dt><dd" + (falta ? ' class="falta"' : "") + ">" +
           (v == null || v === "" ? "—" : esc(String(v))) + "</dd>";
  }

  var h = "";

  // Lo que se sabía antes de que llegara
  if (coment) {
    h += '<div class="rec-coment"><span class="rec-coment__t">Comentario del agendamiento</span><p>' +
         esc(coment) + "</p></div>";
  }

  h += '<section class="rec-det__blk"><h4>Recepción</h4><dl class="rec-det__datos">' +
    fila("Llegada real", o.recibidoEn ? fmtFechaHora(o.recibidoEn) : null, !o.recibidoEn) +
    fila("Recibió", o.recibidoPor) +
    fila("Hora de la cita", o.rec || (a && a.hora)) +
    fila("Etapa", (ETAPAS.find(function (e) { return e.id === o.etapa; }) || {}).t || o.etapa) +
    fila("Asesor", o.asesor || (a && a.asesor)) +
    "</dl></section>";

  h += '<section class="rec-det__blk"><h4>Vehículo</h4><dl class="rec-det__datos">' +
    fila("Patente", o.pat) + fila("VIN", o.vin) +
    fila("Marca / Modelo", [o.marca, o.modelo].filter(Boolean).join(" ")) +
    fila("Versión", o.version) + fila("Año", o.anio) +
    fila("Km de la cita", o.km ? etiquetaKm(o.km) : null) +
    // El km real es el que define qué mantención corresponde: si falta, se marca
    fila("Kilometraje real", kmReal != null ? kmReal.toLocaleString("es-CL") + " km" : "sin registrar", kmReal == null) +
    fila("Combustible", comb || "sin registrar", !comb) +
    fila("Servicio", o.serv || (a && a.serv)) +
    "</dl></section>";

  h += '<section class="rec-det__blk"><h4>Accesorios <span class="rec-det__n">' +
       presentes.length + " de " + AGACC.length + "</span></h4>" +
    '<div class="rec-det__acc">' +
      AGACC.map(function (x) {
        return '<span class="rec-acc' + (acc[x] ? " si" : " no") + '">' +
               (acc[x] ? "✓" : "·") + " " + esc(x) + "</span>";
      }).join("") +
    "</div>" +
    (ausentes.length
      ? '<p class="rec-det__nota">No venían: ' + esc(ausentes.join(", ")) + ".</p>"
      : '<p class="rec-det__nota">Venían todos.</p>') +
    "</section>";

  h += '<section class="rec-det__blk"><h4>Observaciones</h4>' +
    (obs ? "<p>" + esc(obs) + "</p>"
         : '<p class="rec-det__vacio">Sin observaciones: se recibió sin daños ni faltantes declarados.</p>') +
    "</section>";

  h += '<section class="rec-det__blk"><h4>Autorización de datos</h4>' +
    "<p>Comunicaciones comerciales: <b>" + ((a && a.marketing) ? "SÍ" : "NO") + "</b> autorizadas." +
    ((a && a.condVersion) ? ' <span class="rec-det__n">condiciones ' + esc(a.condVersion) + "</span>" : "") +
    "</p></section>";

  /* Los daños marcados en el diagrama. Van como lista y no como dibujo: acá se
     está revisando una recepción pasada, casi siempre para responder "¿esto ya
     venía?", y la respuesta se lee más rápido en texto. El dibujo con los
     puntos está en el acta en PDF, a un botón de distancia. */
  var dns = (a && a.danos) || [];
  if (dns.length && window.DanoMapa) {
    h += '<section class="rec-det__blk"><h4>Daños marcados al recibir ' +
      '<span class="rec-det__n">' + dns.length + "</span></h4><ul class=\"rec-det__danos\">" +
      window.DanoMapa.resumen(dns).map(function (t) { return "<li>" + esc(t) + "</li>"; }).join("") +
      "</ul></section>";
  }

  // Fotos: los recuadros se pintan ya, las imágenes llegan después
  h += '<section class="rec-det__blk"><h4>Inspección fotográfica <span class="rec-det__n">' +
       Object.keys(fotos).length + " de " + AGFOTOS.length + "</span></h4>" +
    '<div class="rec-det__fotos">' +
      AGFOTOS.map(function (v) {
        var f = fotos[v];
        return '<figure class="rec-foto' + (f ? "" : " vacia") + '" data-vista="' + esc(v) + '">' +
               (f ? '<div class="rec-foto__img" id="rf_' + esc(v.replace(/[^a-zA-Z0-9]/g, "")) + '">' +
                    '<span class="rec-foto__cargando">cargando…</span></div>'
                  : '<div class="rec-foto__img"><span class="rec-foto__no">sin foto</span></div>') +
               "<figcaption>" + esc(v) + "</figcaption></figure>";
      }).join("") +
    "</div>" +
    (Object.keys(fotos).length < AGFOTOS.length
      ? '<p class="rec-det__nota falta">Faltaron ' + (AGFOTOS.length - Object.keys(fotos).length) + " fotos.</p>"
      : "") +
    "</section>";

  h += '<section class="rec-det__blk"><h4>Firmas</h4><div class="rec-det__firmas">' +
    ["cliente", "asesor"].map(function (q) {
      var f = firmas[q];
      return '<figure class="rec-firma' + (f ? "" : " vacia") + '">' +
             '<div class="rec-firma__img" id="rfi_' + q + '">' +
             (f ? '<span class="rec-foto__cargando">cargando…</span>' : '<span class="rec-foto__no">sin firmar</span>') +
             "</div><figcaption>Firma " + q +
             (f && f.en ? " · " + fmtHora(f.en) : "") + "</figcaption></figure>";
    }).join("") + "</div></section>";

  // La bitácora responde "quién hizo qué y cuándo", que es la otra mitad de
  // las preguntas que llegan después.
  var hist = (o.hist || []).slice().reverse();
  if (hist.length) {
    h += '<section class="rec-det__blk"><h4>Historial</h4><ul class="rec-det__hist">' +
      hist.map(function (x) {
        return "<li><b>" + esc(x.q) + "</b>" + (x.d ? " · " + esc(x.d) : "") +
               '<span>' + esc(fmtFechaHora(x.en)) + (x.por ? " · " + esc(x.por) : "") + "</span></li>";
      }).join("") + "</ul></section>";
  }
  return h;
}

/* Pide un enlace firmado por cada imagen y las va colocando a medida que
   llegan. Si una falla, ese recuadro lo dice en vez de quedar cargando. */
function _recDetCargarImagenes(a) {
  if (!a) return;
  var fotos = a.fotos || {}, firmas = a.firmas || {};
  AGFOTOS.forEach(function (v) {
    var f = fotos[v];
    if (!f || !f.path) return;
    var cont = document.getElementById("rf_" + v.replace(/[^a-zA-Z0-9]/g, ""));
    if (!cont) return;
    webUrlFirmada(f.path).then(function (url) {
      if (!document.getElementById("recDetOv").classList.contains("open")) return;
      cont.innerHTML = url
        ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' +
          '<img src="' + esc(url) + '" alt="' + esc(v) + '" loading="lazy"></a>'
        : '<span class="rec-foto__no">no se pudo cargar</span>';
    });
  });
  ["cliente", "asesor"].forEach(function (q) {
    var f = firmas[q];
    if (!f || !f.path) return;
    var cont = document.getElementById("rfi_" + q);
    if (!cont) return;
    webUrlFirmada(f.path).then(function (url) {
      if (!document.getElementById("recDetOv").classList.contains("open")) return;
      cont.innerHTML = url
        ? '<img src="' + esc(url) + '" alt="firma ' + q + '">'
        : '<span class="rec-foto__no">no se pudo cargar</span>';
    });
  });
}

/* Vuelve a generar el acta de una recepción ya hecha. Las imágenes ya no están
   en el navegador: se traen del bucket con enlaces firmados. Si alguna no se
   puede leer, el acta sale igual sin ella y se avisa — es mejor un acta sin
   una foto que ningún acta. */
function _recDetPDF(o, a) {
  if (!window.ActaPDF || !window.ActaPDF.disponible()) {
    avisoAgenda("No se pudo generar el PDF del acta.", "warn"); return;
  }
  var btn = document.getElementById("recDetPdf");
  var txt = btn.textContent;
  btn.disabled = true; btn.textContent = "Generando…";

  var datos = Object.assign({}, a || {}, {
    pat: o.pat, cli: o.cliente, marcaNombre: o.marca, modeloNombre: o.modelo,
    anio: o.anio, vin: o.vin, km: o.km, serv: o.serv,
    kmReal: o.kmReal != null ? o.kmReal : (a && a.kmReal),
    comb: o.comb || (a && a.comb), acc: o.acc || (a && a.acc) || {},
    obs: o.obs || (a && a.obs), coment: o.coment || (a && a.coment),
    oc: o.oc, sucursal: (a && a.sucursal) || sucursalEstacion(),
    recibidoEn: o.recibidoEn, recibidoPor: o.recibidoPor, asesor: o.asesor
  });

  var fotos = (a && a.fotos) || {}, firmas = (a && a.firmas) || {};
  var tareasF = AGFOTOS.filter(function (v) { return fotos[v] && fotos[v].path; })
    .map(function (v) {
      return webUrlFirmada(fotos[v].path)
        .then(function (u) { return u ? _reducirImagen(u, 620) : null; })
        .then(function (img) { return img ? { t: v, img: img } : null; });
    });
  var tareasFi = ["cliente", "asesor"].filter(function (q) { return firmas[q] && firmas[q].path; })
    .map(function (q) {
      return webUrlFirmada(firmas[q].path)
        .then(function (u) { return u ? _reducirImagen(u, 500, "image/png") : null; })
        .then(function (img) { return { q: q, img: img }; });
    });

  Promise.all([Promise.all(tareasF), Promise.all(tareasFi), _actaLogo(), _actaDanos(datos)])
    .then(function (r) {
      var fs = {};
      r[1].forEach(function (x) { if (x && x.img) fs[x.q] = x.img; });
      var listaF = r[0].filter(Boolean);
      var doc = window.ActaPDF.generar(datos, o.ro, {
        fotos: listaF, firmas: fs, logo: r[2] || null, danos: r[3] || null,
        asesor: _personaDe(o.asesor || (a && a.asesor)),
        recibio: _personaDe(o.recibidoPor)
      });
      if (!doc) throw new Error("no se pudo armar el documento");
      doc.save(window.ActaPDF.nombreArchivo(datos, o.ro));
      var faltan = Object.keys(fotos).length - listaF.length;
      if (faltan > 0) {
        avisoAgenda("El acta se generó, pero " + faltan + " foto(s) no se pudieron traer del servidor.", "warn");
      }
    })
    .catch(function (e) {
      avisoAgenda("No se pudo generar el acta: " + ((e && e.message) || e), "warn");
    })
    .then(function () { btn.disabled = false; btn.textContent = txt; });
}

// `ref` es el número de OC si la cita está en esta bandeja, o el id de la
// reserva si es de otra sucursal (la central puede anular cualquiera).
function agAnular(ref) {
  var a = agFind(ref) || DB.agendamientos.find(function (x) { return x.webId === ref; });
  if (!a) return _agAnularAjena(ref);
  if (!confirm("¿Anular el agendamiento " + a.oc + " (" + a.pat + ")?")) return;
  // Se MARCA, no se borra. Borrar la fila dejaba la reserva del servidor viva
  // como "agendada" para siempre y, al reconciliar, la cita volvía a aparecer.
  // Además, quién anuló y cuándo es exactamente lo que se pregunta después.
  a.estado = "anulado";
  a.anuladoEn = ahoraISO();
  a.anuladoPor = quienSoy();
  save();
  if (a.webId && typeof webActualizarEstado === "function") {
    webActualizarEstado(a.webId, "cancelada", {
      cancelado_en: a.anuladoEn, cancelado_por: a.anuladoPor
    }).catch(function () { /* offline: la marca local basta hasta el próximo sync */ });
  }
  renderCal(); renderSlots(); renderAgendaTable();
}

// Anulación de una cita que NO está en esta bandeja (otra sucursal). Se cancela
// en el servidor, que es la única verdad de la cita; la sucursal dueña la anula
// sola en su próxima reconciliación.
function _agAnularAjena(id) {
  var r = (WEBRES || []).find(function (x) { return x.id === id; });
  if (!r) return;
  if (!confirm("Esta cita es de " + (r.sucursal || "otra sucursal") + " (" + (r.patente || "") + ").\n\n" +
               "Se cancelará para esa sucursal también. ¿Continuar?")) return;
  var quien = quienSoy(), cuando = ahoraISO();
  webActualizarEstado(id, "cancelada", { cancelado_en: cuando, cancelado_por: quien })
    .then(function () {
      r.estado = "cancelada";
      renderCal(); renderSlots(); renderAgendaTable();
    })
    .catch(function () { alert("No se pudo anular: revisa la conexión y reintenta."); });
}

/* ---------------- modal agendar (selects encadenados) ---------------- */
// anioVehiculo: año REAL del vehículo, que deja el autocompletado por patente
// (autocompletar.js). Ojo con la distinción: el selector "Año" del modal no es
// el año del auto, es la variante de PAUTA (hay modelos cuya mantención cambia
// entre un año y otro). Por eso el año del vehículo se usa de dos formas: si
// coincide con una variante de la pauta se preselecciona, y si la pauta no
// distingue años igual se muestra y viaja al agendamiento.
var MSEL = { marca: null, modelo: null, versionId: null, pauta: null, anioVehiculo: null };

function llenarMarcasModal() {
  var sel = document.getElementById("agMarca");
  if (!INDICE) return;
  var marcas = INDICE.marcas.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, "es"); });
  sel.innerHTML = '<option value="">Elige la marca</option>' +
    marcas.map(function (m) { return '<option value="' + m.id + '">' + m.nombre + "</option>"; }).join("");
}
function llenarAsesores() {
  var sel = document.getElementById("agAsesor");
  if (!sel) return;
  // Se muestra y se guarda el nombre corto: la nómina viene como
  // "APELLIDO APELLIDO NOMBRE NOMBRE", que no es como se le llama a nadie y
  // termina impreso en el acta y en las tarjetas del JPCB.
  sel.innerHTML = '<option value="">— Seleccione —</option>' +
    ASESORES.map(function (a) {
      return '<option value="' + esc(a.corto) + '" title="' + esc(a.nombre) + '">' + esc(a.corto) + "</option>";
    }).join("");
  // Si la sesión es de un asesor de esta sucursal, queda preseleccionado: es
  // quien está operando la estación.
  var yo = quienSoy();
  if (yo) {
    var mio = ASESORES.find(function (a) { return (a.email || "").toLowerCase() === yo.toLowerCase(); });
    if (mio) sel.value = mio.corto;
  }
}

/* ---- carga de la nómina ---- */
function cargarPersonal() {
  if (!webCfgOk()) return Promise.resolve(false);
  return webSesion().then(function (s) {
    if (!s) return false;
    return fetch(AGW.url + "/rest/v1/personal?activo=eq.true&select=rut,nombre,nombre_corto,rol,sucursal,email",
                 { headers: { apikey: AGW.anonKey, Authorization: "Bearer " + s.access } })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(function (rows) {
        PERSONAL = (rows || []).map(function (p) {
          return { rut: p.rut, nombre: p.nombre, corto: p.nombre_corto || p.nombre,
                   rol: p.rol, sucursal: p.sucursal, email: p.email };
        });
        refrescarPersonalSucursal();
        return true;
      });
  }).catch(function () { return false; });
}

// Reparte la nómina en las listas de la sucursal que esta estación tiene abierta.
function refrescarPersonalSucursal() {
  var suc = sucursalEstacion();
  var deAca = PERSONAL.filter(function (p) { return !suc || p.sucursal === suc; });
  var porNombre = function (a, b) { return a.corto.localeCompare(b.corto, "es"); };
  TECNICOS = deAca.filter(function (p) { return p.rol === "tecnico"; }).sort(porNombre);
  ASESORES = deAca.filter(function (p) { return p.rol === "asesor"; }).sort(porNombre);
  llenarAsesores();
}

// Nombre de un técnico a partir de lo que guarda la orden. Acepta el RUT (lo
// que se guarda hoy) y también un índice numérico, que es como se guardaba
// cuando la lista era fija: sin esto, las órdenes viejas mostrarían al técnico
// equivocado al cambiar de sucursal.
function nombreTecnico(ref) {
  if (ref == null || ref === "") return null;
  var p = PERSONAL.find(function (x) { return x.rut === ref; });
  if (p) return p.corto;
  if (typeof ref === "number" && TECNICOS[ref]) return TECNICOS[ref].corto;
  return String(ref);
}
function onMarcaModal() {
  var id = document.getElementById("agMarca").value;
  MSEL.marca = INDICE ? INDICE.marcas.find(function (m) { return m.id === id; }) : null;
  MSEL.modelo = null; MSEL.versionId = null; MSEL.pauta = null; MSEL.anioVehiculo = null;
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
    var conocido = MSEL.anioVehiculo != null ? String(MSEL.anioVehiculo) : null;
    if (p && p.anios && p.anios.length) {
      selA.innerHTML = '<option value="">Elige el año</option>' + p.anios.map(function (a) { return "<option>" + a + "</option>"; }).join("");
      selA.disabled = false;
      // si el año del vehículo es una de las variantes de esta pauta, se deja elegido
      if (conocido && p.anios.some(function (a) { return String(a) === conocido; })) selA.value = conocido;
    } else if (conocido) {
      // La pauta no cambia según el año, pero sí sabemos el año del auto: se
      // muestra igual (deshabilitado, porque elegir otro no cambiaría nada) y
      // así viaja al agendamiento y de ahí a la recepción.
      selA.innerHTML = "<option>" + esc(conocido) + "</option>";
      selA.disabled = true;
    } else {
      selA.innerHTML = '<option value="">—</option>';
      selA.disabled = true;
    }
    llenarMantModal();
  });
}
// Muestra el año del vehículo apenas se conoce, sin esperar a que se elija la
// versión. El autocompletado por patente ya lo dejaba en MSEL.anioVehiculo,
// pero el campo solo se pintaba dentro de onVersionModal: el dato estaba
// cargado y el asesor veía el casillero vacío igual. Eso es lo que se reportaba
// como "no se rellena el año".
// Va deshabilitado a propósito: sin pauta cargada no hay variantes que elegir,
// y el valor igual viaja al agendamiento (agGuardar lee este select).
function pintarAnioVehiculo() {
  var selA = document.getElementById("agAnioSel");
  if (!selA) return;
  if (MSEL.pauta) return;          // con pauta manda onVersionModal, que sí tiene variantes
  var a = MSEL.anioVehiculo;
  if (a != null && String(a) !== "") {
    selA.innerHTML = "<option>" + esc(String(a)) + "</option>";
  } else {
    selA.innerHTML = '<option value="">—</option>';
  }
  selA.disabled = true;
}

function resetAnioMant() {
  pintarAnioVehiculo();
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

/* uid de la cita que se está corrigiendo, o null si se está agendando una
   nueva. El modal es el mismo; esto es lo que decide qué hace Guardar. */
var AG_EDITANDO = null;

function agAbrirModal(h) {
  // sin sucursal no se sabe en qué agenda guardar: se avisa antes de que el
  // asesor llene todo el formulario
  if (!sucursalEstacion()) {
    alert("Primero elige tu sucursal en el panel de la izquierda.\nAsí la cita queda en la agenda que corresponde.");
    var s = document.getElementById("fComercio");
    if (s) { s.focus(); s.scrollIntoView({ block: "center" }); }
    return;
  }
  AG_EDITANDO = null;
  _agModoModal(false);
  var ov = document.getElementById("agOv");
  ov.dataset.hora = h;
  document.getElementById("agHora").textContent = "· " + h + " · " + fmtFechaCorta(selFecha);
  // limpiar formulario
  ["agPatente", "agVin", "agCliente", "agRut", "agFono", "agEmail", "agComent"].forEach(function (id) { document.getElementById(id).value = ""; });
  document.getElementById("agServicio").value = "MANTENCIÓN POR KILOMETRAJE";
  document.getElementById("agMarca").value = "";
  onMarcaModal();
  // prellenado desde el cotizador
  if (PREFILL) aplicarPrefill();
  ov.classList.add("open");
}

function agCerrarModal() {
  document.getElementById("agOv").classList.remove("open");
  AG_EDITANDO = null;
}

/* Cambia el modal entre "agendar" y "corregir". Lo único que cambia es el
   título, el botón y el bloque para mover día y hora. */
function _agModoModal(editando) {
  document.getElementById("agTitulo").innerHTML = editando
    ? 'Corregir cita <span id="agHora" style="color:var(--ink-3);font-weight:400;font-size:14px"></span>'
    : 'Agendar hora <span id="agHora" style="color:var(--ink-3);font-weight:400;font-size:14px"></span>';
  document.getElementById("agBtnGuardar").textContent = editando ? "Guardar cambios" : "Guardar agendamiento";
  document.getElementById("agMover").hidden = !editando;
}

/* ---------------- corregir una cita ----------------
   Existe porque hasta ahora un error de tipeo obligaba a anular y agendar de
   nuevo: se perdía el número de la cita, el cliente recibía dos avisos y la
   hora quedaba libre unos segundos, tiempo suficiente para que otra estación
   se la llevara. */
function agEditarCita(oc) {
  var a = agFind(oc);
  if (!a) { avisoAgenda("No se encontró la cita " + oc + ".", "warn"); return; }

  // Una cita recibida ya quedó impresa en el acta que el cliente firmó.
  // Cambiarla dejaría el sistema diciendo una cosa y el papel firmado otra.
  if (a.estado === "en_taller") {
    avisoAgenda("La cita " + oc + " ya no se puede corregir: el vehículo entró al taller y sus datos " +
                "quedaron en el acta firmada por el cliente.", "warn");
    return;
  }
  if (a.estado === "anulado") {
    avisoAgenda("La cita " + oc + " está anulada. Si hay que rehacerla, agenda una nueva.", "warn");
    return;
  }

  AG_EDITANDO = a.uid;
  _agModoModal(true);

  var ov = document.getElementById("agOv");
  ov.dataset.hora = a.hora || "";
  document.getElementById("agHora").textContent = "· OC " + a.oc;

  // día y hora, para poder mover la cita
  var fEd = document.getElementById("agFechaEd");
  fEd.value = a.fecha || selFecha;
  fEd.onchange = function () { _agLlenarHorasEd(a); };
  _agLlenarHorasEd(a);

  // datos del formulario
  document.getElementById("agServicio").value = a.serv || "MANTENCIÓN POR KILOMETRAJE";
  document.getElementById("agPatente").value = a.pat || "";
  document.getElementById("agVin").value = a.vin || "";
  document.getElementById("agCliente").value = (a.cli && a.cli !== "Cliente") ? a.cli : "";
  document.getElementById("agRut").value = a.rut || "";
  document.getElementById("agFono").value = a.fono || "";
  document.getElementById("agEmail").value = a.email || "";
  document.getElementById("agComent").value = a.coment || "";
  var selAse = document.getElementById("agAsesor");
  if (selAse) selAse.value = a.asesor || "";

  _agPrecargarVehiculo(a);
  ov.classList.add("open");
}

/* Las horas del día elegido, marcando cuáles están tomadas. La propia hora de
   la cita NO cuenta como ocupada. */
function _agLlenarHorasEd(a) {
  var sel = document.getElementById("agHoraEd");
  var nota = document.getElementById("agMoverNota");
  var dia = document.getElementById("agFechaEd").value || a.fecha;
  var ocup = horasOcupadas(dia, a.uid);
  var horas = (typeof horasDelDia === "function") ? horasDelDia() : _agHorasFijas();
  sel.innerHTML = horas.map(function (h) {
    var tomada = !!ocup[h];
    return '<option value="' + h + '"' + (tomada ? " disabled" : "") +
           (h === a.hora && dia === a.fecha ? " selected" : "") + ">" +
           h + (tomada ? " · ocupada" : "") + "</option>";
  }).join("");
  if (dia !== a.fecha || sel.value !== a.hora) {
    // si la hora original ya no existe en el nuevo día, se elige la primera libre
    if (!sel.value || sel.selectedOptions[0].disabled) {
      var libre = horas.find(function (h) { return !ocup[h]; });
      if (libre) sel.value = libre;
    }
  }
  var libres = horas.filter(function (h) { return !ocup[h]; }).length;
  nota.textContent = libres
    ? "Quedan " + libres + " horas libres el " + fmtFechaCorta(dia) + "."
    : "Ese día no queda ninguna hora libre.";
}

/* Respaldo si la agenda no expone su lista de horas: las mismas franjas que
   usa el panel de cupos. */
function _agHorasFijas() {
  var out = [];
  for (var m = 8 * 60 + 30; m <= 17 * 60; m += 30) out.push(hhmm(m));
  return out;
}

/* Vuelve a armar marca → modelo → versión → año → mantención. Va encadenado
   porque cada selector depende del anterior, y la pauta se carga por red. */
function _agPrecargarVehiculo(a) {
  var selMarca = document.getElementById("agMarca");
  if (!INDICE || !a.marcaNombre) { selMarca.value = ""; onMarcaModal(); return; }
  var marca = INDICE.marcas.find(function (m) { return m.nombre === a.marcaNombre; });
  if (!marca) { selMarca.value = ""; onMarcaModal(); return; }
  selMarca.value = marca.id;
  onMarcaModal();

  var iMod = (MSEL._modelos || []).findIndex(function (m) { return m.nombre === a.modeloNombre; });
  if (iMod < 0) return;
  document.getElementById("agModeloSel").value = String(iMod);
  onModeloModal();

  if (!a.pautaId) return;
  document.getElementById("agVersionSel").value = a.pautaId;
  MSEL.anioVehiculo = a.anio != null ? a.anio : null;
  onVersionModal();

  // El año y la mantención dependen de la pauta, que se carga por red: se
  // esperan a que MSEL.pauta esté lista en vez de adivinar cuánto demora.
  var intentos = 0;
  var t = setInterval(function () {
    if (++intentos > 40) { clearInterval(t); return; }   // ~6 s y se rinde
    if (!MSEL.pauta) return;
    clearInterval(t);
    var selA = document.getElementById("agAnioSel");
    if (a.anio != null && selA && !selA.disabled) {
      var op = Array.prototype.find.call(selA.options, function (o) { return o.value === String(a.anio); });
      if (op) { selA.value = String(a.anio); onAnioModal(); }
    }
    llenarMantModal();
    if (a.revN != null) {
      var selM = document.getElementById("agMantSel");
      var opm = Array.prototype.find.call(selM.options, function (o) { return o.value === String(a.revN); });
      if (opm) { selM.value = String(a.revN); if (typeof onMantModal === "function") onMantModal(); }
    }
  }, 150);
}

/* ---------------- correlativos de OC y RO ----------------
   El número lo entrega la base (una sucursal, un contador, sin repetir), no el
   navegador. `minimoLocal` empuja el contador la primera vez, para que ninguna
   sucursal empiece por debajo de lo que su estación ya había usado.

   Si no hay sesión o no hay red devuelve null y el llamador sigue con su
   contador local: es preferible un número provisorio a no poder agendar. Ese
   caso lo cubre la fusión, que detecta el choque y renumera. */
function reservarCorrelativo(tipo, minimoLocal) {
  if (!webCfgOk()) return Promise.resolve(null);
  var pedido = webSesion().then(function (s) {
    if (!s) return null;
    return fetch(AGW.url + "/rest/v1/rpc/siguiente_correlativo", {
      method: "POST",
      headers: {
        apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        p_sucursal: sucursalEstacion(), p_tipo: tipo, p_minimo: minimoLocal || 0
      })
    }).then(function (r) { return r.ok ? r.json() : null; });
  }).then(function (n) { return typeof n === "number" ? n : null; })
    .catch(function () { return null; });

  // Con la red colgada, fetch se queda esperando sin límite y el asesor apretaría
  // Guardar sin que pasara nada. A los 6 s se sigue con el contador local.
  var corte = new Promise(function (ok) { setTimeout(function () { ok(null); }, 6000); });
  return Promise.race([pedido, corte]);
}

function agGuardar() {
  var esMant = document.getElementById("agServicio").value.indexOf("MANTEN") >= 0;
  var pat = document.getElementById("agPatente").value.trim().toUpperCase();
  if (!pat) { alert("Ingresa la patente del vehículo."); return; }

  /* Al CORREGIR, el vehículo puede no ser re-seleccionable: la cita pudo venir
     de una solicitud del cliente (que escribe libre) o su modelo pudo salir del
     catálogo. Exigir marca y modelo ahí dejaba al asesor sin poder arreglar ni
     un teléfono mal escrito. Si no se puede rearmar, el vehículo se conserva
     tal como estaba y se corrige lo demás. */
  var citaEditada = AG_EDITANDO
    ? DB.agendamientos.find(function (x) { return x.uid === AG_EDITANDO; })
    : null;
  var vehiculoIntacto = false;
  if (!MSEL.marca || !MSEL.modelo) {
    if (citaEditada && citaEditada.marcaNombre) {
      vehiculoIntacto = true;
    } else {
      alert("Selecciona la marca y el modelo del vehículo.");
      return;
    }
  }
  if (!vehiculoIntacto && esMant && (!MSEL.versionId || document.getElementById("agMantSel").value === "")) {
    alert("Para una mantención por kilometraje selecciona la versión y la mantención (km)."); return;
  }
  // el año del vehículo respalda al selector: si la pauta no distingue años,
  // el selector va deshabilitado y sin él la recepción quedaría sin ese dato.
  var revN = null, km = null, valorRef = null;
  var anio = document.getElementById("agAnioSel").value || MSEL.anioVehiculo || null;
  if (esMant && MSEL.pauta) {
    revN = document.getElementById("agMantSel").value;
    var plan = planDe(MSEL.pauta, anio);
    var itv = (plan && plan.intervalos || []).find(function (x) { return String(x.n) === String(revN); });
    if (itv) { km = itv.km || null; valorRef = valorItv(itv); }
  }
  // Se leen los campos ANTES de pedir el número: entre la petición y la
  // respuesta el formulario sigue en pantalla y podría cambiar.
  var verSel = document.getElementById("agVersionSel");
  // Con el vehículo intacto se copian los valores que ya tenía la cita, en vez
  // de leerlos de unos selectores que quedaron vacíos.
  var veh = vehiculoIntacto ? {
    marcaNombre: citaEditada.marcaNombre, modeloNombre: citaEditada.modeloNombre,
    versionNombre: citaEditada.versionNombre, pautaId: citaEditada.pautaId,
    anio: citaEditada.anio, km: citaEditada.km, revN: citaEditada.revN,
    valorRef: citaEditada.valorRef
  } : {
    marcaNombre: MSEL.marca.nombre, modeloNombre: MSEL.modelo.nombre,
    versionNombre: MSEL.versionId ? verSel.options[verSel.selectedIndex].text : null,
    pautaId: MSEL.versionId || null,
    anio: anio, km: km, revN: revN, valorRef: valorRef
  };
  var datos = {
    fecha: selFecha,
    hora: document.getElementById("agOv").dataset.hora,
    sucursal: document.getElementById("fComercio").value,
    serv: document.getElementById("agServicio").value,
    pat: pat,
    marcaNombre: veh.marcaNombre,
    modeloNombre: veh.modeloNombre,
    versionNombre: veh.versionNombre,
    pautaId: veh.pautaId,
    anio: veh.anio, km: veh.km, revN: veh.revN, valorRef: veh.valorRef,
    vin: document.getElementById("agVin").value.trim() || null,
    cli: document.getElementById("agCliente").value.trim() || "Cliente",
    rut: document.getElementById("agRut").value.trim() || null,
    fono: document.getElementById("agFono").value.trim() || null,
    email: document.getElementById("agEmail").value.trim() || null,
    asesor: document.getElementById("agAsesor").value || null,
    coment: document.getElementById("agComent").value.trim() || null,
    // id de la reserva web (Supabase) si este agendamiento vino de una solicitud
    // del cliente: permite cerrar el ciclo (estado) en el servidor al recibir.
    webId: (PREFILL && PREFILL.web && PREFILL.web.id) || null,
    estado: "agendado",
    creadoEn: ahoraISO(), creadoPor: quienSoy()
  };
  // Corregir NO pide correlativo: la cita conserva su número. Cambiárselo
  // dejaría al cliente con un comprobante que ya no existe.
  if (AG_EDITANDO) { _agGuardarEdicion(datos); return; }

  var desdeOc = Math.max(DB.ocSeq || 0, OC_MINIMO);
  reservarCorrelativo("oc", desdeOc).then(function (numero) {
    datos.oc = Math.max(numero != null ? numero : desdeOc, OC_MINIMO);
    DB.ocSeq = Math.max(desdeOc, datos.oc + 1);
    _agGuardarCon(datos);
  });
}

/* Guarda una corrección sobre la cita existente.

   Conserva lo que identifica a la cita (uid, número, origen, quién la creó) y
   reemplaza solo lo que el asesor puede cambiar. Deja anotado qué cambió: si
   mañana el cliente reclama que él pidió otra hora, ahí está la respuesta. */
function _agGuardarEdicion(datos) {
  var a = DB.agendamientos.find(function (x) { return x.uid === AG_EDITANDO; });
  if (!a) { avisoAgenda("La cita que estabas corrigiendo ya no está.", "warn"); agCerrarModal(); return; }

  var nuevaFecha = document.getElementById("agFechaEd").value || a.fecha;
  var nuevaHora = document.getElementById("agHoraEd").value || a.hora;

  // El cupo se revisa contra el estado de AHORA, no contra el de cuando se
  // abrió el modal: pudo estar abierto minutos y el sondeo trae citas de otras
  // estaciones cada 15 s.
  if ((nuevaFecha !== a.fecha || nuevaHora !== a.hora) &&
      horasOcupadas(nuevaFecha, a.uid)[nuevaHora]) {
    avisoAgenda("Las " + nuevaHora + " del " + fmtFechaCorta(nuevaFecha) +
                " ya están tomadas. La cita NO se movió: elige otra hora.", "warn");
    _agLlenarHorasEd(a);
    return;
  }

  var antes = {
    fecha: a.fecha, hora: a.hora, pat: a.pat, serv: a.serv,
    cli: a.cli, rut: a.rut, fono: a.fono, email: a.email,
    marcaNombre: a.marcaNombre, modeloNombre: a.modeloNombre,
    versionNombre: a.versionNombre, anio: a.anio, revN: a.revN, asesor: a.asesor,
    coment: a.coment
  };

  // Solo lo editable. uid/oc/webId/estado/creadoEn/creadoPor se conservan.
  ["serv", "pat", "marcaNombre", "modeloNombre", "versionNombre", "pautaId",
   "anio", "km", "revN", "valorRef", "vin", "cli", "rut", "fono", "email",
   "asesor", "sucursal", "coment"].forEach(function (k) { a[k] = datos[k]; });
  a.fecha = nuevaFecha;
  a.hora = nuevaHora;
  a.editadoEn = ahoraISO();
  a.editadoPor = quienSoy();

  var cambios = Object.keys(antes).filter(function (k) {
    return String(antes[k] == null ? "" : antes[k]) !== String(a[k] == null ? "" : a[k]);
  });
  anotar(a, "Cita corregida", cambios.length
    ? cambios.map(function (k) {
        return _ETIQ_CITA[k] + ": " + (antes[k] || "—") + " → " + (a[k] || "—");
      }).join(" · ")
    : "sin cambios");

  save();

  // La reserva del cliente vive en el servidor: si no se actualiza allá, el
  // sondeo la volvería a traer con los datos viejos y desharía la corrección.
  if (a.webId && typeof webActualizarEstado === "function") {
    webActualizarEstado(a.webId, null, {
      fecha: a.fecha, hora: a.hora, patente: a.pat,
      nombre: a.cli, fono: a.fono, email: a.email,
      servicio: a.serv, sucursal: a.sucursal || null,
      comentario: a.coment || null
    }).catch(function () {
      avisoAgenda("La cita se corrigió acá, pero no se pudo avisar al servidor. " +
                  "Revisa la conexión y vuelve a guardar.", "warn");
    });
  }

  agCerrarModal();
  // Si se movió de día, se salta al día nuevo: si no, el asesor la busca donde
  // ya no está y cree que se perdió.
  if (a.fecha !== antes.fecha) {
    selFecha = a.fecha;
    var p = a.fecha.split("-");
    calY = +p[0]; calM = +p[1] - 1;
  }
  renderAll();
  avisoAgenda(cambios.length
    ? "Cita " + a.oc + " corregida (" + cambios.length + " campo" + (cambios.length === 1 ? "" : "s") + ")."
    : "No hubo cambios que guardar.", cambios.length ? "ok" : null);
}

var _ETIQ_CITA = {
  fecha: "fecha", hora: "hora", pat: "patente", serv: "servicio", cli: "cliente",
  rut: "RUT", fono: "teléfono", email: "e-mail", marcaNombre: "marca",
  modeloNombre: "modelo", versionNombre: "versión", anio: "año",
  revN: "mantención", asesor: "asesor", coment: "comentario"
};

function _agGuardarCon(a) {
  // ÚLTIMO CHEQUEO DEL CUPO, acá y no en agGuardar: entre que el asesor aprieta
  // Guardar y llega este punto pasan hasta 6 s pidiendo el correlativo, y antes
  // el modal pudo estar abierto varios minutos. El sondeo corre cada 15 s y
  // puede haber adoptado una cita de otra estación en esa hora. Sin este
  // chequeo aparecían dos autos citados a la misma hora y nadie se enteraba
  // hasta que llegaban los dos.
  if (a.fecha === selFecha && a.hora && horasOcupadas()[a.hora]) {
    agCerrarModal();
    avisoAgenda("Otra estación acaba de tomar las " + a.hora + " del " + fmtFechaCorta(a.fecha) +
                ". La cita NO se guardó: elige otra hora.", "warn");
    renderCal(); renderSlots(); renderAgendaTable();
    return;
  }
  DB.agendamientos.push(a);
  // Agendamiento interno (no vino de solicitud web): TODA cita nace también en
  // reservas_web, que es la única verdad del agendamiento. Antes esto se
  // saltaba si el cliente no dejaba teléfono y esas citas quedaban invisibles
  // para el resto de las sucursales; la columna ya no exige fono (la exigencia
  // se movió a la policy del público, ver setup_supabase_acta_archivo.sql).
  // Fail-safe: sin sesión o sin red, queda solo local y se reconcilia después.
  if (!a.webId && typeof webCrearReserva === "function") {
    var fono = a.fono && String(a.fono).replace(/\s/g, "").length >= 8 ? a.fono : null;
    webCrearReserva({
      nombre: a.cli || "Cliente", fono: fono, email: a.email,
      patente: a.pat, fecha: a.fecha, hora: a.hora, oc: a.oc,
      marca: a.marcaNombre, modelo: a.modeloNombre, version: a.versionNombre,
      anio: a.anio, pauta_id: a.pautaId, rev_n: a.revN != null ? String(a.revN) : null,
      km: a.km, valor: a.valorRef, rut: a.rut, asesor: a.asesor || quienSoy(),
      sucursal: a.sucursal, vin: a.vin, origen: "taller", estado: "agendada"
    }).then(function (id) { if (id) { a.webId = id; save(); } })
      .catch(function () { /* queda solo local */ });
  } else if (a.webId && typeof webActualizarEstado === "function") {
    // Vino de una solicitud del cliente: se le pega el número de OC para que la
    // fila del servidor y la cita de la agenda queden amarradas.
    webActualizarEstado(a.webId, "agendada", {
      oc: a.oc, sucursal: a.sucursal || null, asesor: a.asesor || quienSoy()
    }).catch(function () { /* se reintenta al reconciliar */ });
  }
  save();
  // La cita ya existe: recién ahora el prellenado se descarta SIN devolver la
  // solicitud a la cola (eso lo hace descartarPrefill cuando se abandona).
  if (PREFILL) { localStorage.removeItem(PREKEY); PREFILL = null; renderPrefillBanner(); }
  agCerrarModal();
  renderCal(); renderSlots(); renderAgendaTable();
  avisoAgenda("Agendamiento " + a.oc + " creado para el " + fmtFechaCorta(a.fecha) + " a las " + a.hora +
              ". Cuando llegue el auto, usa “Ingresar” en su fila para abrir la recepción.", "ok");
  _agResaltarFila(a.oc);
}

// Resalta un momento la fila recién creada. Reemplaza al alert de éxito, que
// bloqueaba el hilo y tapaba justo la tabla donde está el botón siguiente.
function _agResaltarFila(oc) {
  setTimeout(function () {
    var t = document.getElementById("tblAgenda");
    if (!t) return;
    var fila = Array.prototype.find.call(t.rows, function (tr) {
      return tr.cells[0] && tr.cells[0].textContent.trim() === String(oc);
    });
    if (!fila) return;
    fila.classList.add("fila-nueva");
    fila.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(function () { fila.classList.remove("fila-nueva"); }, 4000);
  }, 60);
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
  // Los campos opcionales se omiten en vez de imprimirse: una reserva sin
  // versión o sin revisión mostraba "undefined" en pantalla.
  var partes = [PREFILL.marcaNombre, PREFILL.modelo].filter(Boolean).join(" ");
  if (PREFILL.version) partes += " · " + PREFILL.version;
  var auto = "<b>" + esc(partes || "Vehículo por confirmar") + "</b>" +
    (PREFILL.revN != null && PREFILL.revN !== "" ? " — Rev. " + esc(String(PREFILL.revN)) : "") +
    (PREFILL.km ? " · " + etiquetaKm(PREFILL.km) : "");
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
  // Si venía de una solicitud del cliente, descartarla la DEVUELVE a la cola.
  // Antes se borraba el prellenado y la reserva quedaba marcada como atendida
  // para siempre, con el cliente esperando una llamada que nadie iba a hacer.
  var w = PREFILL && PREFILL.web;
  localStorage.removeItem(PREKEY);
  PREFILL = null;
  renderPrefillBanner();
  if (w && w.id) {
    webSoltar(w.id).then(function (fila) {
      var r = (WEBRES || []).find(function (x) { return x.id === w.id; });
      if (fila && r) r.estado = "nueva";
      avisoAgenda("La solicitud de " + (w.cli || "el cliente") + " volvió a la cola de pendientes.", "info");
      renderCal(); renderSlots(); renderAgendaTable(); webBadge();
    }).catch(function () {
      avisoAgenda("No se pudo devolver la solicitud a la cola (sin conexión). Se libera sola en 30 minutos.", "warn");
    });
  }
}
function aplicarPrefill() {
  if (!PREFILL || !INDICE) return;

  /* Si el cliente pidió solo una parte de la mantención, eso tiene que quedar
     escrito donde lo lea quien prepara los repuestos y quien recibe el auto.
     Se deja en el comentario de la cita: es el campo que ya viaja a la
     recepción y al acta, así que no hay que inventar un camino nuevo. */
  if (PREFILL.excluidos && PREFILL.excluidos.length) {
    var ta = document.getElementById("agComent");
    if (ta) {
      var nota = "Mantención PARCIAL. El cliente NO quiere: " +
                 PREFILL.excluidos.join(", ") + ".";
      ta.value = ta.value ? nota + "\n" + ta.value : nota;
    }
  }

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
  /* Cliente escrito a mano en el cotizador: pasa cuando la patente no está en
     el padrón (auto nuevo, primera visita, cambio de dueño). Se rellena ANTES
     de disparar el autocompletado, que solo toca los campos vacíos: así lo que
     el asesor tipeó recién manda sobre lo que pueda encontrar la base. */
  var pc = PREFILL.cliente;
  if (pc) {
    [["agCliente", pc.nombre], ["agRut", pc.rut],
     ["agFono", pc.fono], ["agEmail", pc.email]].forEach(function (par) {
      var e = document.getElementById(par[0]);
      if (e && !e.value.trim() && par[1]) e.value = par[1];
    });
  }

  // La patente ya viene escrita desde el cotizador: se pone y se dispara el
  // autocompletado en modo "solo cliente", para traer nombre, RUT, teléfono,
  // e-mail y VIN sin tocar la versión, que el cotizador ya eligió con precisión.
  if (PREFILL.patente) {
    var inpPat = document.getElementById("agPatente");
    if (inpPat && !inpPat.value) inpPat.value = PREFILL.patente;
    if (typeof window.__autoPorPatente === "function") {
      window.__autoPorPatente(PREFILL.patente, true);
    }
  }
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

/* ---- UNA SOLA VERDAD PARA LA CITA ----
   Un agendamiento vivía a la vez en la bandeja y en reservas_web como dos
   registros distintos: la agenda leía uno y la recepción por patente leía el
   otro. Se copiaban entre sí, pero nada garantizaba que coincidieran. La regla
   ahora es explícita y va en UNA sola dirección por campo:

     · reservas_web manda en los datos de LA CITA (cliente, vehículo, fecha,
       hora, estado del ciclo, acta). Es la fila que ve cualquier estación.
     · la bandeja manda en el estado OPERATIVO del taller (etapa JPCB, técnico
       asignado, pre-picking). Eso no existe en el servidor.

   Así no hay forma de que las dos copias se peleen: ninguna pisa el terreno de
   la otra.                                                                    */
function reconciliarConReservas() {
  if (!WEBRES || !WEBRES.length) return false;
  var suc = sucursalEstacion();
  var cambios = 0;

  // Índice de lo que ya tengo: por id de reserva y, como respaldo, por
  // patente+fecha+hora (una cita creada acá antes de que existiera su fila).
  var porWeb = {}, porHueco = {}, porPatFecha = {};
  DB.agendamientos.forEach(function (a) {
    if (a.webId) porWeb[a.webId] = a;
    porHueco[[a.pat, a.fecha, a.hora].join("|")] = a;
    porPatFecha[[a.pat, a.fecha].join("|")] = a;
  });

  WEBRES.forEach(function (r) {
    if (!r || !r.fecha) return;
    // Solo lo de mi sucursal. Las solicitudes del cliente llegan sin sucursal
    // asignada y esas las ve todo el mundo hasta que alguien las toma.
    if (r.sucursal && suc && r.sucursal !== suc) return;

    var a = porWeb[r.id] || porHueco[[r.patente, r.fecha, r.hora].join("|")];
    if (a) {
      if (!a.webId) { a.webId = r.id; cambios++; }
      // El servidor manda en el ciclo: si allá se canceló, acá se anula.
      if ((r.estado === "cancelada" || r.estado === "rechazada") && a.estado !== "anulado") {
        a.estado = "anulado";
        a.anuladoEn = r.cancelado_en || ahoraISO();
        a.anuladoPor = r.cancelado_por || null;
        cambios++;
      }
      // Y completa lo que a mí me falte, sin pisar lo que ya tengo escrito.
      [["cli", "nombre"], ["fono", "fono"], ["email", "email"], ["rut", "rut"],
       ["vin", "vin"], ["anio", "anio"], ["asesor", "asesor"]].forEach(function (p) {
        var mio = a[p[0]];
        if ((mio == null || mio === "" || mio === "Cliente") && r[p[1]] != null && r[p[1]] !== "") {
          a[p[0]] = r[p[1]]; cambios++;
        }
      });
      // El acta que haya cargado otra estación (accesorios, combustible, km).
      if (r.km_real != null && a.kmReal == null) { a.kmReal = r.km_real; cambios++; }
      if (r.comentario && !a.coment) { a.coment = r.comentario; cambios++; }
      if (r.comb && !a.comb) { a.comb = r.comb; cambios++; }
      if (r.acc && !a.acc) { a.acc = r.acc; cambios++; }
      if (r.obs && !a.obs) { a.obs = r.obs; cambios++; }
      if (r.recibido_en && !a.recibidoEn) {
        a.recibidoEn = r.recibido_en; a.recibidoPor = r.recibido_por || null; cambios++;
      }
      return;
    }

    // No la tengo. Si el servidor dice que está agendada o más adelante, es una
    // cita real de esta sucursal hecha en otra estación (o que se perdió al
    // limpiar este navegador): se adopta, en vez de quedar invisible.
    if (["agendada", "recibida", "en_taller"].indexOf(r.estado) < 0) return;
    if (!r.sucursal || !suc || r.sucursal !== suc) return;
    // Guarda contra duplicados: una cita recién creada acá todavía puede no
    // tener su webId de vuelta (webCrearReserva es asíncrono), y su hora local
    // puede no calzar con la del servidor. Patente + fecha alcanza para no
    // adoptar dos veces el mismo auto el mismo día.
    var yaEsta = porPatFecha[[r.patente, r.fecha].join("|")];
    if (yaEsta) { if (!yaEsta.webId) { yaEsta.webId = r.id; cambios++; } return; }
    var adoptada = _agDesdeReserva(r, r.oc != null ? r.oc : DB.ocSeq++);
    porPatFecha[[adoptada.pat, adoptada.fecha].join("|")] = adoptada;
    DB.agendamientos.push(adoptada);
    DB.webImp[r.id] = 1;
    cambios++;
  });

  if (cambios) { save(); repintarTodo(); }
  return cambios > 0;
}

// Traduce una fila de reservas_web al shape que usa la agenda. El uid se deriva
// del id de la reserva para que dos estaciones que adopten la misma cita
// terminen con la MISMA entidad al fusionar, no con dos copias.
// `oc` se recibe de fuera a propósito: esta función también arma las filas de
// SOLO LECTURA de la agenda de la central, y ahí no puede consumir correlativos
// (se gastaría un número en cada repintado).
function _agDesdeReserva(r, oc) {
  return {
    uid: "srv-" + r.id, webId: r.id,
    oc: r.oc != null ? r.oc : (oc != null ? oc : null),
    fecha: r.fecha, hora: r.hora === "indiferente" ? "" : (r.hora || ""),
    sucursal: r.sucursal || null,
    serv: r.km ? "MANTENCIÓN POR KILOMETRAJE" : "RECEPCIÓN",
    pat: r.patente || "—",
    marcaNombre: r.marca || null, modeloNombre: r.modelo || null,
    versionNombre: r.version || null, pautaId: r.pauta_id || null,
    anio: r.anio || null, km: r.km || null, revN: r.rev_n != null ? r.rev_n : null,
    valorRef: r.valor != null ? r.valor : null,
    vin: r.vin || null, cli: r.nombre || "Cliente", rut: r.rut || null,
    fono: r.fono || null, email: r.email || null, asesor: r.asesor || null,
    kmReal: r.km_real != null ? r.km_real : null, comb: r.comb || null,
    acc: r.acc || null, obs: r.obs || null,
    // Lo que escribió el cliente al reservar por la web. Se guardaba en la base
    // desde el principio, pero la agenda nunca lo leía: llegaba el auto y nadie
    // sabía lo que el cliente había pedido.
    coment: r.comentario || null,
    recibidoEn: r.recibido_en || null, recibidoPor: r.recibido_por || null,
    creadoEn: r.creado_en || null, creadoPor: r.asesor || null,
    // El ciclo del servidor traducido al de la agenda. Sin esta tabla, todo lo
    // que no fuera 'en_taller' caía en "agendado": una cita ya ENTREGADA de otra
    // sucursal se veía como pendiente y con botón de anular.
    //
    // 'recibida' queda a propósito como "agendado": significa que se abrió el
    // acta, pero la orden de trabajo todavía no existe. Si se marcara "en
    // taller", la sucursal dueña perdería el botón "Ingresar" y no podría
    // terminar de recibir el vehículo.
    estado: ({ en_taller: "en_taller", cerrada: "entregado",
               cancelada: "anulado", rechazada: "anulado" })[r.estado] || "agendado"
  };
}

// Refresca la lista del servidor y reconcilia. Va en el mismo ciclo que la
// bandeja: sin esto, las citas hechas en otra estación solo aparecían al abrir
// el modal de reservas a mano.
var _resUltima = 0;
function refrescarReservas() {
  if (!webCfgOk() || Date.now() - _resUltima < 60000) return Promise.resolve(false);
  return webSesion().then(function (s) {
    if (!s) return false;
    return webFetchReservas(s).then(function (rows) {
      _resUltima = Date.now();
      WEBRES = rows || [];
      webBadge();
      reconciliarConReservas();
      renderCal(); renderSlots(); renderAgendaTable();
      return true;
    });
  }).catch(function () { return false; });
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
  return { nueva: "Nueva", en_gestion: "La está tomando alguien", agendada: "En agenda",
           recibida: "Recibida", en_taller: "En taller", cerrada: "Cerrada",
           rechazada: "Rechazada", cancelada: "Cancelada" }[e] || e || "Nueva";
}

/* ---- reclamo de una solicitud del cliente ----
   Antes, al pulsar "Confirmar" se marcaba la reserva como 'agendada' de
   inmediato, ANTES de que existiera la cita. Si el asesor abandonaba el modal
   —cerraba la pestaña, se distraía, o pulsaba "Descartar"— la solicitud
   quedaba gestionada para todas las estaciones y desaparecía de pendientes:
   ese cliente se quedaba sin respuesta y sin rastro de que faltaba atenderlo.

   Ahora hay un estado intermedio 'en_gestion'. Se reclama con un PATCH
   CONDICIONAL (?estado=eq.nueva): si vuelve vacío es que otra estación se
   adelantó, y se avisa en vez de abrir dos veces el mismo flujo. Recién al
   guardar la cita pasa a 'agendada'; si se descarta, vuelve a 'nueva'.

   Va con llamada propia y no con webActualizarEstado(): esa la usan la
   anulación, la recepción, el acta y la entrega desde estados distintos, y un
   filtro fijo ahí las rompería todas.                                        */
function _webPatchCondicional(id, desde, cambios) {
  return webSesion().then(function (s) {
    if (!s) return null;
    var u = AGW.url + "/rest/v1/" + webTabla() +
            "?id=eq." + encodeURIComponent(id) + "&estado=eq." + encodeURIComponent(desde);
    return fetch(u, {
      method: "PATCH",
      headers: {
        apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
        "Content-Type": "application/json", Prefer: "return=representation"
      },
      body: JSON.stringify(cambios)
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(function (filas) { return (filas && filas[0]) || null; });
  });
}

// Toma la solicitud. null = alguien se adelantó (o no hay sesión).
function webReclamar(id) {
  return _webPatchCondicional(id, "nueva", { estado: "en_gestion", asesor: quienSoy() });
}
// La suelta: vuelve a la cola de pendientes para que otro la atienda.
function webSoltar(id) {
  return _webPatchCondicional(id, "en_gestion", { estado: "nueva" });
}

/* Solicitudes que quedaron tomadas y nunca se agendaron (el asesor cerró la
   pestaña, se cortó la luz). Sin esto, 'en_gestion' sería una trampa peor que
   la anterior: la solicitud quedaría invisible para siempre. Se devuelven a la
   cola pasados 30 minutos, usando la columna `actualizado` que ya mantiene el
   trigger de la tabla. */
var EN_GESTION_MAX_MS = 30 * 60 * 1000;
function liberarGestionesViejas() {
  if (!webCfgOk() || !WEBRES || !WEBRES.length) return Promise.resolve(0);
  var corte = Date.now() - EN_GESTION_MAX_MS;
  var viejas = WEBRES.filter(function (r) {
    if (!r || r.estado !== "en_gestion") return false;
    var t = Date.parse(r.actualizado || r.creado_en || "");
    return !isNaN(t) && t < corte;
  });
  if (!viejas.length) return Promise.resolve(0);
  return Promise.all(viejas.map(function (r) {
    return webSoltar(r.id).then(function (fila) { if (fila) r.estado = "nueva"; }).catch(function () {});
  })).then(function () { renderCal(); renderSlots(); renderAgendaTable(); return viejas.length; });
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
      cargarPersonal().then(function (ok) { if (ok) renderPlan(); });
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
      _resUltima = Date.now();
      reconciliarConReservas();
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
    // el reclamo vive en el servidor: webImp ya no decide si está atendida
    var gestionada = !!(r.estado && r.estado !== "nueva");
    var vieja = r.fecha < hoyStr;
    var est = gestionada ? '<span class="ag-pill en">' + esc(webEtiquetaEstado(r.estado || "agendada")) + '</span>'
      : vieja ? '<span class="ag-pill ent">Vencida</span>'
      : '<span class="ag-pill por">Nueva</span>';
    var imp = gestionada;
    var auto = [r.marca, r.modelo, r.version].filter(Boolean).join(" ") + (r.anio ? " (" + r.anio + ")" : "");
    var mant = r.km ? "Mantención " + etiquetaKm(r.km) : (r.rev_n ? "Rev. " + r.rev_n : "Mantención");
    var hora = r.hora === "indiferente" ? "hora por definir" : (r.hora || "") + " h";
    // La sucursal a la vista. Sin esto, una reserva de OTRA sucursal aparecía
    // acá igual que las propias y daba a entender que la agenda la había
    // perdido, cuando en realidad estaba en la bandeja de la otra sucursal.
    var mia = webEsDeMiSucursal(r);
    var suc = r.sucursal
      ? '<span class="webres-suc' + (mia ? "" : " ajena") + '" title="' +
        (mia ? "Sucursal de esta reserva" : "Esta reserva es de otra sucursal: no aparece en tu agenda") +
        '">' + esc(r.sucursal) + "</span>"
      : '<span class="webres-suc libre" title="El cliente no eligió sucursal: la toma quien la confirme">sin sucursal</span>';
    return '<div class="webres-item' + (mia ? "" : " webres-item--ajena") + '">' +
      '<div class="webres-cab"><b>' + fmtFechaCorta(r.fecha) + "</b> · " + hora + " " + est + suc + "</div>" +
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
  if (!r) return;
  // Antes esto se iba en silencio y el asesor apretaba "Confirmar" sin que
  // pasara nada visible.
  if (!r.pauta_id) {
    alert("Esta solicitud no trae la pauta del vehículo (marca/modelo/versión),\n" +
          "así que no se puede prellenar el agendamiento.\n\n" +
          "Agéndala a mano con los datos del cliente: " + (r.nombre || "") +
          (r.fono ? " · " + r.fono : "") + ".");
    return;
  }
  // Confirmarla la mete en la bandeja de LA SUCURSAL QUE ESTA ESTACIÓN TIENE
  // ABIERTA, no en la que dice la reserva. Si no calzan hay que avisar: si no,
  // la cita "desaparece" de la sucursal donde el cliente la pidió.
  // Sin sucursal elegida no se sabe en qué agenda caería la cita. El guard va
  // acá y no solo en los slots: a webPasar se llega también desde el botón
  // "Confirmar" de la tabla y desde el modal de reservas web.
  var suc = sucursalEstacion();
  if (!suc) {
    avisoAgenda("Elige primero tu sucursal: la cita queda en la agenda de la sucursal que tengas abierta.", "warn");
    var selS = document.getElementById("fComercio");
    if (selS) { selS.focus(); selS.scrollIntoView({ block: "center" }); }
    return;
  }
  if (r.sucursal && r.sucursal !== suc &&
      !confirm("Esta reserva es de " + r.sucursal + " y tú estás en " + suc + ".\n\n" +
               "Si la confirmas acá, la cita queda en la agenda de " + suc + ".\n¿Continuar?")) return;

  // RECLAMO EN EL SERVIDOR ANTES DE ABRIR EL FLUJO. Es bloqueante a propósito:
  // sin esto, dos personas de la central podían confirmar la misma solicitud
  // dentro de la ventana de refresco y nacían dos citas para el mismo cliente.
  avisoAgenda("Tomando la solicitud…", "info");
  webReclamar(r.id).then(function (fila) {
    if (fila === null) {
      // 0 filas = ya no estaba 'nueva': alguien se adelantó
      r.estado = "en_gestion";
      avisoAgenda("Esta solicitud la acaba de tomar otra estación. Se actualizó la lista.", "warn");
      _resUltima = 0;
      refrescarReservas();
      return;
    }
    if (fila) r.estado = fila.estado || "en_gestion";
    _webAbrirFlujo(r);
  }).catch(function () {
    // Sin red o sin sesión no se puede reclamar. Se sigue igual —el taller no
    // puede quedar detenido— pero se dice, porque la solicitud queda sin
    // reservar y otra estación podría tomarla en paralelo.
    avisoAgenda("No se pudo reservar la solicitud en el servidor (sin conexión). Sigue, pero avisa si otra estación la toma también.", "warn");
    _webAbrirFlujo(r);
  });
}

// Prellena y salta al calendario. La reserva ya quedó tomada en el servidor;
// pasa a 'agendada' recién cuando la cita existe (ver _agGuardarCon).
function _webAbrirFlujo(r) {
  PREFILL = {
    pautaId: r.pauta_id, marcaNombre: r.marca, modelo: r.modelo, version: r.version,
    anio: r.anio || null, revN: r.rev_n != null ? r.rev_n : null, km: r.km || null,
    valor: null, ts: Date.now(),
    web: { id: r.id, cli: r.nombre, fono: r.fono, email: r.email, pat: r.patente,
           fecha: r.fecha, hora: r.hora, comentario: r.comentario }
  };
  try { localStorage.setItem(PREKEY, JSON.stringify(PREFILL)); } catch (e) { /* sin espacio */ }
  var p = String(r.fecha).split("-");
  calY = +p[0]; calM = +p[1] - 1; selFecha = r.fecha;
  webCerrarLista();
  agGoTab("agenda");
  avisoAgenda("Solicitud de " + (r.nombre || "cliente") + " tomada. Elige una hora libre para confirmarla; si la descartas vuelve a la cola.", "ok");
  renderPrefillBanner();
  renderCal(); renderSlots(); renderAgendaTable();
}

function webBadge() {
  var b = document.getElementById("webResBadge");
  if (!b) return;
  var hoyStr = hoyISO();
  var n = WEBRES.filter(function (r) {
    // el reclamo vive en el servidor: webImp ya no decide si está atendida
    var gestionada = !!(r.estado && r.estado !== "nueva");
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
  o.entregadoEn = ahoraISO();
  o.entregadoPor = quienSoy();
  anotar(o, "Vehículo entregado", o.pat);
  var a = o.oc ? agFind(o.oc) : null;
  if (a) { a.estado = "entregado"; a.entregadoEn = o.entregadoEn; a.entregadoPor = o.entregadoPor; }
  save();
  if (a && a.webId && typeof webActualizarEstado === "function") {
    webActualizarEstado(a.webId, "cerrada", {
      entregado_en: o.entregadoEn, entregado_por: o.entregadoPor
    }).catch(function () { /* offline: se refleja en el próximo sync */ });
  }
  closeM();
  renderAll();
  renderAgendaTable();
}

/* ============================================================
   2 · RECEPCIÓN
   ============================================================ */
var agRecSel = null;
function agAbrirRecepcion(oc) {
  // Desde el módulo Agenda, recibir el vehículo es trabajo del módulo
  // Recepción: se salta allá con la cita cargada, en vez de abrirla acá (la
  // pestaña de Recepción no existe en ese módulo). El &oc lo lee el script de
  // taller.html al terminar de cargar.
  if (window.__moduloVista === "agenda") {
    location.href = "taller.html?vista=recepcion&oc=" + encodeURIComponent(oc);
    return;
  }
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
  _recPintarComentario();
  var chkMk = document.getElementById("rcMarketing");
  if (chkMk) chkMk.checked = !!agRecSel.marketing;
  agMontarDanos();
  agPintarActa();
  agRenderFotos();
  agGoTab("recep");
  // después de agGoTab: el canvas necesita estar visible para medirse
  agRenderFirmas();
}

/* ============================================================
   ACTA DE RECEPCIÓN — accesorios, combustible, km real, observaciones
   ------------------------------------------------------------
   Nada de esto se guardaba. Los accesorios se regeneraban en blanco cada vez
   que se abría una recepción, los radios de combustible no tenían ni `value`,
   el kilometraje era un <span> de solo lectura con el ESTIMADO de la cita —
   justo el dato que define qué mantención corresponde— y no había dónde anotar
   un daño previo.

   El acta existe para respaldar al taller: si el cliente reclama que entregó
   el auto con el estanque lleno y con la gata, esto es lo único que responde.
   Todo lo que el asesor marca se persiste al instante en la bandeja y se
   refleja en la fila de reservas_web, que es la que ven las demás estaciones.
   ============================================================ */
/* El comentario del agendamiento, arriba de la recepción.

   No se mezcla con "Observaciones": eso son los daños que se constatan CON el
   auto delante. Esto es lo que se sabía antes de que llegara, y quien recibe
   necesita leerlo antes de decidir nada. */
function _recPintarComentario() {
  var el = document.getElementById("recComent");
  if (!el) return;
  var txt = (agRecSel && agRecSel.coment || "").trim();
  if (!txt) { el.hidden = true; el.textContent = ""; return; }
  el.hidden = false;
  el.innerHTML = '<span class="rec-coment__t">Comentario del agendamiento</span>' +
                 "<p>" + esc(txt) + "</p>";
}

function agPintarActa() {
  if (!agRecSel) return;
  var marcados = agRecSel.acc || {};
  document.getElementById("accGrid").innerHTML = AGACC.map(function (a) {
    return '<label class="acc"><input type="checkbox" value="' + esc(a) + '"' +
      (marcados[a] ? " checked" : "") + ' onchange="agAcc()"><span>' + esc(a) + "</span></label>";
  }).join("");
  agAccResumen();

  document.querySelectorAll("#combRow input[name=comb]").forEach(function (r) {
    r.checked = (agRecSel.comb != null && r.value === String(agRecSel.comb));
  });

  var km = document.getElementById("rcKmReal");
  km.value = agRecSel.kmReal != null ? Number(agRecSel.kmReal).toLocaleString("es-CL") : "";
  km.classList.toggle("falta", agRecSel.kmReal == null);

  document.getElementById("rcObs").value = agRecSel.obs || "";
  agSelloRecepcion();
}

// Marca de llegada. Se pone la PRIMERA vez que se abre el acta, porque en este
// flujo abrir la recepción es el momento en que el auto está en el taller
// frente al asesor. Si ya venía sellada (otra estación la abrió antes) se
// respeta: la llegada ocurre una sola vez.
function agSelloRecepcion() {
  var el = document.getElementById("recSello");
  if (!el || !agRecSel) return;
  if (!agRecSel.recibidoEn) {
    agRecSel.recibidoEn = ahoraISO();
    agRecSel.recibidoPor = quienSoy();
    save();
    _reflejarActa();
  }
  el.hidden = false;
  el.innerHTML = "🕐 Llegada registrada: <b>" + esc(fmtFechaHora(agRecSel.recibidoEn)) + "</b>" +
    (agRecSel.recibidoPor ? " · Recibe <b>" + esc(agRecSel.recibidoPor) + "</b>" : "") +
    (agRecSel.hora ? ' <span style="color:var(--ink-3)">(cita a las ' + esc(agRecSel.hora) + ")</span>" : "");
}

function agAccResumen() {
  var el = document.getElementById("accResumen");
  if (!el) return;
  var n = Object.keys((agRecSel && agRecSel.acc) || {}).length;
  el.textContent = n + " de " + AGACC.length + " marcados";
}

function agAcc() {
  if (!agRecSel) return;
  var out = {};
  document.querySelectorAll("#accGrid input[type=checkbox]").forEach(function (c) {
    if (c.checked) out[c.value] = true;
  });
  agRecSel.acc = out;
  agAccResumen();
  save();
  _reflejarActa();
}

function agAccNinguno() {
  document.querySelectorAll("#accGrid input[type=checkbox]").forEach(function (c) { c.checked = false; });
  agAcc();
}

/* Autorización comercial del cliente. Se guarda igual que el resto del acta y
   se imprime en el PDF. Lo que importa es que quede el registro de lo que el
   cliente dijo: si mañana reclama que le llegó publicidad sin pedirla, la
   respuesta está en el acta que firmó. */
function agMarketing() {
  if (!agRecSel) return;
  var c = document.getElementById("rcMarketing");
  agRecSel.marketing = !!(c && c.checked);
  // La versión del texto que se le mostró: si Legal cambia una cláusula, hay
  // que poder decir cuál firmó este cliente, no cuál está vigente hoy.
  if (window.ActaCondiciones) agRecSel.condVersion = window.ActaCondiciones.version;
  save();
}

function agComb() {
  if (!agRecSel) return;
  var m = document.querySelector("#combRow input[name=comb]:checked");
  agRecSel.comb = m ? m.value : null;
  save();
  _reflejarActa();
}

function agKmReal() {
  if (!agRecSel) return;
  var inp = document.getElementById("rcKmReal");
  if (!inp) return;
  var n = parseInt(String(inp.value).replace(/[^0-9]/g, ""), 10);
  agRecSel.kmReal = isNaN(n) ? null : n;
  inp.value = agRecSel.kmReal != null ? agRecSel.kmReal.toLocaleString("es-CL") : "";
  inp.classList.toggle("falta", agRecSel.kmReal == null);
  save();
  _reflejarActa();
}

/* Mapa de daños. Vive en agRecSel.danos y se guarda en cada marca, igual que
   los accesorios: el asesor marca con el cliente al lado y no vuelve a pasar
   por acá, así que no hay un momento posterior en que guardar. */
var _danoUI = null;
function agMontarDanos() {
  var caja = document.getElementById("danoMapa");
  if (!caja || !window.DanoMapa || !agRecSel) return;
  if (!Array.isArray(agRecSel.danos)) agRecSel.danos = [];
  _danoUI = window.DanoMapa.montar(caja, {
    danos: agRecSel.danos,
    onCambio: function (ds) {
      agRecSel.danos = ds;
      save();
      _reflejarActa();
    }
  });
}

var _obsTimer = null;
function agObs() {
  if (!agRecSel) return;
  agRecSel.obs = document.getElementById("rcObs").value || null;
  clearTimeout(_obsTimer);   // no se guarda en cada tecla
  _obsTimer = setTimeout(function () { save(); _reflejarActa(); }, 800);
}

// Refleja el acta en la fila de reservas_web. Con freno: escribir en cada
// cambio mandaría una petición por casilla marcada.
var _actaTimer = null;
function _reflejarActa() {
  if (!agRecSel || !agRecSel.webId || typeof webActualizarEstado !== "function") return;
  var id = agRecSel.webId;
  var cuerpo = {
    acc: agRecSel.acc || {},
    comb: agRecSel.comb || null,
    km_real: agRecSel.kmReal != null ? agRecSel.kmReal : null,
    obs: agRecSel.obs || null,
    recibido_en: agRecSel.recibidoEn || null,
    recibido_por: agRecSel.recibidoPor || null
  };
  clearTimeout(_actaTimer);
  _actaTimer = setTimeout(function () {
    webActualizarEstado(id, null, cuerpo).catch(function () { /* queda local */ });
  }, 900);
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
        // Si esta cita YA está en la bandeja, se trabaja sobre ella. Antes se
        // armaba siempre un objeto suelto: todo lo que el asesor cargara ahí
        // (acta, fotos, firmas) no se persistía en ninguna parte, porque save()
        // guarda DB y ese objeto no estaba dentro de DB.
        var local = r.id ? DB.agendamientos.find(function (a) { return a.webId === r.id; }) : null;
        if (!local) {
          local = DB.agendamientos.find(function (a) {
            return a.pat === pat && a.estado !== "anulado" && a.estado !== "entregado";
          });
        }
        if (local) {
          if (r.id && !local.webId) { local.webId = r.id; save(); }
          agRecSel = local;
          _recepListo(msg);
          return;
        }

        var nueva = {
          pat: pat, webId: r.id || null,
          marcaNombre: r.marca || (veh && veh.marca) || null,
          modeloNombre: r.modelo || (veh && veh.modelo) || null,
          versionNombre: r.version || null, pautaId: r.pauta_id || null,
          anio: r.anio || (veh && veh.anio) || null,
          km: r.km || (veh && veh.km) || null, revN: r.rev_n || null,
          valorRef: (r.valor != null ? r.valor : null),
          serv: r.km ? "MANTENCIÓN POR KILOMETRAJE" : "RECEPCIÓN",
          cli: (cli && cli.nombre) || r.nombre || "Cliente",
          rut: rut, fono: (cli && (cli.cel || cli.fono)) || r.fono || null,
          email: (cli && cli.mail) || r.email || null,
          vin: r.vin || (veh && veh.vin) || null, asesor: r.asesor || quienSoy(),
          fecha: r.fecha || hoyISO(), hora: r.hora && r.hora !== "indiferente" ? r.hora : "",
          sucursal: r.sucursal || sucursalEstacion() || null,
          estado: "agendado", fotos: {},
          creadoEn: ahoraISO(), creadoPor: quienSoy()
        };
        // Número propio: sin OC la recepción no se puede referenciar en el resto
        // del taller (JPCB, bodega, reportes).
        var desdeOc2 = Math.max(DB.ocSeq || 0, OC_MINIMO);
        return reservarCorrelativo("oc", desdeOc2).then(function (numero) {
          nueva.oc = Math.max(numero != null ? numero : desdeOc2, OC_MINIMO);
          DB.ocSeq = Math.max(desdeOc2, nueva.oc + 1);
          DB.agendamientos.push(nueva);
          if (r.id) DB.webImp[r.id] = 1;
          agRecSel = nueva;
          save();
          // Sin reserva previa (llegó sin cita): se le crea su fila, para que
          // esta recepción también tenga una sola verdad en el servidor.
          if (!nueva.webId && typeof webCrearReserva === "function") {
            webCrearReserva({
              nombre: nueva.cli, fono: nueva.fono, email: nueva.email,
              patente: nueva.pat, fecha: nueva.fecha,
              hora: nueva.hora || fmtHora(nueva.creadoEn) || "indiferente",
              oc: nueva.oc, marca: nueva.marcaNombre, modelo: nueva.modeloNombre,
              version: nueva.versionNombre, anio: nueva.anio, pauta_id: nueva.pautaId,
              rev_n: nueva.revN != null ? String(nueva.revN) : null, km: nueva.km,
              rut: nueva.rut, vin: nueva.vin, asesor: nueva.asesor,
              sucursal: nueva.sucursal, origen: "taller", estado: "recibida"
            }).then(function (id) { if (id) { nueva.webId = id; save(); _reflejarActa(); } })
              .catch(function () { /* queda local */ });
          }
          _recepListo(msg);
        });
      });
    });
  }).catch(function () { if (msg) msg.textContent = "No se pudo buscar (¿sesión de asesor iniciada?)."; });
}

function _recepListo(msg) {
  if (msg) msg.textContent = "";
  var inp = document.getElementById("recBuscarPat");
  if (inp) inp.value = "";
  agPintarRecepcion();
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
    var obligatoria = AGFOTOS_OBLIGATORIAS.indexOf(fo) >= 0;
    return '<label class="photo-slot' + (sub ? " has-photo" : "") +
        (!sub && obligatoria ? " photo-req" : "") + '" id="slot_' + i + '"' +
        (sub ? ' style="background-image:url(' + esc(sub.preview || "") + ')"' : "") + '>' +
      '<input type="file" accept="image/*" capture="environment" ' +
        'onchange="agSubirFoto(this,' + i + ')">' +
      '<span class="photo-cam">📷</span>' +
      '<span class="photo-lbl">' + esc(fo) +
        (obligatoria ? '' : ' <i class="photo-opc">opcional</i>') + '</span>' +
      '<span class="photo-st" id="fst_' + i + '">' + (sub ? "✓" : "") + '</span>' +
    '</label>';
  }).join("");
  _agResumenFotos();
}

/* Cuántas faltan, arriba del todo. Sin esto el asesor cuenta recuadros a ojo
   y recién se entera de que le falta una cuando aprieta Ingresar. */
function _agResumenFotos() {
  var el = document.getElementById("fotoResumen");
  if (!el) return;
  var fotos = (agRecSel && agRecSel.fotos) || {};
  var listas = AGFOTOS_OBLIGATORIAS.filter(function (v) { return fotos[v]; }).length;
  var total = AGFOTOS_OBLIGATORIAS.length;
  var faltan = total - listas;
  el.className = "foto-resumen" + (faltan ? " falta" : " ok");
  el.textContent = faltan
    ? listas + " de " + total + " fotos · faltan " + faltan + " para poder ingresar el vehículo"
    : "Las " + total + " fotos obligatorias están listas.";
}

/* Prepara la foto ANTES de subirla: la reduce y la convierte a JPEG.

   El bucket acepta hasta 10 MB y solo jpeg/png/webp. Una foto de celular
   moderno pasa los 10 MB, y un iPhone entrega HEIC, que no está en la lista:
   las dos cosas hacían fallar la subida sin explicar por qué. Convirtiendo acá
   entra cualquier formato que el navegador sepa abrir, pesa una fracción y
   sube mucho más rápido en el wifi del taller.

   Si el navegador no pudiera procesarla, se sube el archivo original: es mejor
   intentarlo que negarse. */
function agPrepararFoto(file) {
  var LADO_MAX = 1600, CALIDAD = 0.82;
  return new Promise(function (listo) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      try {
        var w = img.naturalWidth, h = img.naturalHeight;
        var esc = Math.min(1, LADO_MAX / Math.max(w, h));
        var cv = document.createElement("canvas");
        cv.width = Math.max(1, Math.round(w * esc));
        cv.height = Math.max(1, Math.round(h * esc));
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob) { listo({ blob: file, tipo: file.type || "image/jpeg", ext: "jpg", url: URL.createObjectURL(file) }); return; }
          listo({ blob: blob, tipo: "image/jpeg", ext: "jpg", url: URL.createObjectURL(blob) });
        }, "image/jpeg", CALIDAD);
      } catch (e) {
        listo({ blob: file, tipo: file.type || "image/jpeg", ext: "jpg", url: url });
      }
    };
    img.onerror = function () {
      // formato que este navegador no abre (HEIC en un PC, por ejemplo)
      URL.revokeObjectURL(url);
      listo(null);
    };
    img.src = url;
  });
}

// Sube una foto a Supabase Storage (bucket recepciones) y la asocia a la reserva.
function agSubirFoto(input, i) {
  var file = input.files && input.files[0];
  if (!file || !agRecSel) return;
  var vista = AGFOTOS[i];
  var slot = document.getElementById("slot_" + i);
  var st = document.getElementById("fst_" + i);
  if (st) st.textContent = "Preparando…";

  agPrepararFoto(file).then(function (prep) {
    if (!prep) {
      return Promise.reject(new Error(
        "este navegador no puede abrir ese archivo (¿es HEIC?). Cámbialo a JPG o sácala con la cámara."));
    }

    /* Revisión ANTES de subir. Rechazar acá y no después es lo que hace que
       el asesor repita la foto con el auto todavía delante; descubrirlo al
       día siguiente no sirve de nada. */
    if (!window.FotoControl) return { prep: prep, rev: { ok: true } };
    var otras = Object.keys(agRecSel.fotos || {})
      .filter(function (v) { return v !== vista && agRecSel.fotos[v].huella; })
      .map(function (v) { return { vista: v, huella: agRecSel.fotos[v].huella }; });
    if (st) st.textContent = "Revisando…";
    return window.FotoControl.revisar(prep.url, otras).then(function (rev) {
      return { prep: prep, rev: rev };
    });
  }).then(function (r) {
    var prep = r.prep, rev = r.rev;
    if (!rev.ok) {
      // Se descarta el archivo: dejarlo puesto haría creer que quedó guardado.
      if (slot) { slot.style.backgroundImage = ""; slot.classList.remove("has-photo"); }
      if (input) input.value = "";
      return Promise.reject(new Error(rev.motivo));
    }
    prep.huella = rev.huella || null;

    if (slot) {
      slot.style.backgroundImage = "url(" + prep.url + ")";
      slot.classList.add("has-photo");
      slot.classList.remove("photo-err");
    }
    if (st) st.textContent = "Subiendo…";

    var carpeta = agFotoCarpeta();
    var slug = vista.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    var path = carpeta + "/" + slug + "_" + Date.now() + "." + prep.ext;

    return webSesion().then(function (s) {
      if (!s) throw new Error("no hay sesión iniciada; vuelve a entrar con tu correo @curifor.com");
      return fetch(AGW.url + "/storage/v1/object/recepciones/" + encodeURI(path), {
        method: "POST",
        headers: {
          apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
          "Content-Type": prep.tipo, "x-upsert": "true"
        },
        body: prep.blob
      }).then(function (r) {
        if (r.ok) return { path: path, url: prep.url, huella: prep.huella };
        // El motivo importa: antes todo terminaba en "reintentar" y nadie sabía
        // si era la sesión, el tamaño o el formato.
        return r.text().then(function (t) {
          var motivo = r.status === 401 || r.status === 403
              ? "tu sesión no tiene permiso (vuelve a entrar)"
            : r.status === 413 ? "la foto pesa demasiado"
            : r.status === 415 ? "ese formato de imagen no se acepta"
            : "el servidor respondió " + r.status + (t ? " · " + t.slice(0, 90) : "");
          throw new Error(motivo);
        });
      });
    });
  }).then(function (ok) {
    if (st) st.textContent = "✓";
    agRecSel.fotos = agRecSel.fotos || {};
    // La huella se guarda con la foto: es lo que permite pillar la repetida
    // aunque el asesor cierre la recepción y la retome más tarde.
    agRecSel.fotos[vista] = { path: ok.path, preview: ok.url, huella: ok.huella || null,
                              en: ahoraISO(), por: quienSoy() };
    save();
    agRenderFotos();
    // refleja las fotos en Supabase si la reserva existe allá
    if (agRecSel.webId && typeof webActualizarEstado === "function") {
      var paths = Object.keys(agRecSel.fotos).map(function (k) { return agRecSel.fotos[k].path; });
      webActualizarEstado(agRecSel.webId, null, { fotos: paths }).catch(function () {});
    }
  }).catch(function (e) {
    if (st) st.textContent = "✕ reintentar";
    if (slot) slot.classList.add("photo-err");
    var motivo = String((e && e.message) || "error desconocido").replace(/\.\s*$/, "");
    avisoRecepcion("No se pudo guardar la foto de " + vista + ": " + motivo + ".", "warn");
  });
}

/* Aviso de la recepción. Va a su propio elemento y no al de la agenda: en el
   módulo Recepción la vista de agenda está oculta, así que un mensaje puesto
   allá no lo ve nadie — que es justo lo que pasaba cuando fallaba una foto. */
var _avisoRecTimer = null;
function avisoRecepcion(texto, tipo) {
  var el = document.getElementById("recAviso");
  if (!el) { avisoAgenda(texto, tipo); return; }
  el.textContent = texto;
  el.className = "ag-aviso" + (tipo ? " ag-aviso--" + tipo : "");
  el.hidden = false;
  clearTimeout(_avisoRecTimer);
  _avisoRecTimer = setTimeout(function () { el.hidden = true; }, 12000);
}
/* ============================================================
   FIRMAS DIGITALES (acta de recepción)
   ------------------------------------------------------------
   Canvas propio en vez de una librería: el sitio no carga nada de terceros y
   son ~60 líneas. Se firma con dedo, lápiz o mouse (pointer events cubren los
   tres) y se guarda sola al levantar el trazo, igual que las fotos: PNG al
   bucket privado `recepciones` de Storage, y la ruta se refleja en la reserva.

   No se guarda la imagen dentro de la bandeja de la sucursal a propósito: la
   bandeja es un solo documento JSON que viaja entero en cada sincronización, y
   meterle un PNG por firma la haría crecer sin control. Queda la ruta; al
   reabrir una recepción ya firmada se muestra el estado, no el trazo.
   ============================================================ */
var FIRMAS = { cliente: "firmaCliente", asesor: "firmaAsesor" };
var _firmas = {};
var _firmasResize = null;

function agRenderFirmas() {
  Object.keys(FIRMAS).forEach(_prepararFirma);
}

// Al cambiar el ancho (girar la tablet, abrir el teclado) el canvas queda con
// una caja distinta a su resolución interna y el trazo se dibujaría corrido.
function agFirmasAlRedimensionar() {
  clearTimeout(_firmasResize);
  _firmasResize = setTimeout(function () {
    var f = document.getElementById("recForm");
    if (agRecSel && f && !f.hidden) agRenderFirmas();
  }, 250);
}

function _prepararFirma(quien) {
  var cv = document.getElementById(FIRMAS[quien]);
  if (!cv) return;
  var caja = cv.getBoundingClientRect();
  if (!caja.width) return;                      // aún oculto: se prepara al mostrarse
  var previo = _firmas[quien];
  // Cambiar el tamaño del canvas lo deja en blanco. Si había un trazo a medio
  // hacer (girar la tablet durante la firma) se rescata y se vuelve a pintar
  // escalado, en vez de perderlo.
  var rescate = (previo && previo.trazos && cv.width) ? cv.toDataURL("image/png") : null;
  // El canvas se dimensiona en píxeles reales del dispositivo para que el trazo
  // no salga pixelado en pantallas HiDPI (tablets, sobre todo).
  var dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(caja.width * dpr);
  cv.height = Math.round(caja.height * dpr);
  var ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#12233f";
  _firmas[quien] = { cv: cv, ctx: ctx, trazos: (previo && previo.trazos) || 0, timer: null };
  if (rescate) {
    var img = new Image();
    img.onload = function () { ctx.drawImage(img, 0, 0, caja.width, caja.height); };
    img.src = rescate;
  }

  var ya = agRecSel && agRecSel.firmas && agRecSel.firmas[quien];
  cv.classList.toggle("firmada", !!ya);
  _firmaEstado(quien, ya ? "✓ firmada" + (ya.en ? " " + fmtHora(ya.en) : "") : "", false);

  if (cv._enganchada) return;                   // los listeners van una sola vez
  cv._enganchada = 1;
  var pintando = false, ultimo = null;
  var punto = function (e) {
    var b = cv.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  cv.addEventListener("pointerdown", function (e) {
    e.preventDefault();
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* navegador antiguo */ }
    pintando = true; ultimo = punto(e);
  });
  cv.addEventListener("pointermove", function (e) {
    if (!pintando) return;
    var f = _firmas[quien], p = punto(e);
    f.ctx.beginPath(); f.ctx.moveTo(ultimo.x, ultimo.y); f.ctx.lineTo(p.x, p.y); f.ctx.stroke();
    ultimo = p; f.trazos++;
  });
  var soltar = function () {
    if (!pintando) return;
    pintando = false;
    cv.classList.add("firmada");
    agGuardarFirma(quien);
  };
  cv.addEventListener("pointerup", soltar);
  cv.addEventListener("pointercancel", soltar);
  cv.addEventListener("pointerleave", soltar);
}

function _firmaEstado(quien, texto, esError) {
  var st = document.getElementById("fst-" + quien);
  if (!st) return;
  st.textContent = texto;
  st.classList.toggle("err", !!esError);
}

// Espera a que el trazo termine de verdad antes de subir (una firma son varios
// trazos seguidos; sin esto se subiría una versión por cada uno).
function agGuardarFirma(quien) {
  var f = _firmas[quien];
  if (!f || !f.trazos || !agRecSel) return;
  clearTimeout(f.timer);
  f.timer = setTimeout(function () { _subirFirma(quien); }, 700);
}

function _subirFirma(quien) {
  var f = _firmas[quien];
  if (!f || !agRecSel) return;
  var path = agFotoCarpeta() + "/firma-" + quien + ".png";
  _firmaEstado(quien, "Guardando…", false);
  f.cv.toBlob(function (blob) {
    if (!blob) { _firmaEstado(quien, "✕ no se pudo generar", true); return; }
    webSesion().then(function (s) {
      if (!s) throw new Error("sin sesión");
      return fetch(AGW.url + "/storage/v1/object/recepciones/" + encodeURI(path), {
        method: "POST",
        headers: {
          apikey: AGW.anonKey, Authorization: "Bearer " + s.access,
          "Content-Type": "image/png", "x-upsert": "true"
        },
        body: blob
      });
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      agRecSel.firmas = agRecSel.firmas || {};
      agRecSel.firmas[quien] = { path: path, en: ahoraISO(), por: quienSoy() };
      _firmaEstado(quien, "✓ firmada " + fmtHora(agRecSel.firmas[quien].en), false);
      save();
      _reflejarFirmas();
    }).catch(function () {
      _firmaEstado(quien, "✕ sin guardar, reintenta", true);
    });
  }, "image/png");
}

function agLimpiarFirma(quien) {
  var f = _firmas[quien];
  if (!f) return;
  clearTimeout(f.timer);
  var b = f.cv.getBoundingClientRect();
  f.ctx.clearRect(0, 0, b.width, b.height);
  f.trazos = 0;
  f.cv.classList.remove("firmada");
  _firmaEstado(quien, "", false);
  if (agRecSel && agRecSel.firmas && agRecSel.firmas[quien]) {
    delete agRecSel.firmas[quien];
    save();
    _reflejarFirmas();
  }
}

// Deja las rutas de las firmas en la reserva, para que otra estación (y el
// futuro acta impresa) sepan que existen y dónde están.
function _reflejarFirmas() {
  if (!agRecSel || !agRecSel.webId || typeof webActualizarEstado !== "function") return;
  var f = {};
  Object.keys(agRecSel.firmas || {}).forEach(function (k) { f[k] = agRecSel.firmas[k].path; });
  webActualizarEstado(agRecSel.webId, null, { firmas: f }).catch(function () { });
}

function agCancelarRecepcion() {
  agRecSel = null;
  document.getElementById("recForm").hidden = true;
  document.getElementById("recVacia").hidden = false;
  // mismo motivo que arriba: en el módulo Recepción no hay pestañas a las que
  // volver, así que se queda en su propia pantalla
  if (window.__moduloVista !== "recepcion") agGoTab("agenda");
}
function agIngresarTaller() {
  if (!agRecSel) return;
  // Un acta incompleta no sirve como respaldo frente a un reclamo. Se avisa
  // enumerando QUÉ falta, pero no se bloquea: el taller no puede quedar
  // detenido porque el asesor no alcanzó a llenar un campo.
  /* Las fotos NO son negociables (decisión de Ignacio, 13-08-2026): son la
     única prueba del estado en que llegó el auto. Sin ellas, un rayón que ya
     venía se vuelve palabra contra palabra, y esa discusión la pierde siempre
     el taller. Se bloquea el ingreso y se dice exactamente cuáles faltan. */
  var sinFoto = AGFOTOS_OBLIGATORIAS.filter(function (v) {
    return !(agRecSel.fotos && agRecSel.fotos[v]);
  });
  if (sinFoto.length) {
    avisoRecepcion("Faltan " + sinFoto.length + " foto" + (sinFoto.length === 1 ? "" : "s") +
                   " de la inspección: " + sinFoto.join(", ") +
                   ". Sin ellas no se puede ingresar el vehículo.", "warn");
    var pw = document.getElementById("photoWrap");
    if (pw) pw.scrollIntoView({ behavior: "smooth", block: "center" });
    // Se marcan los recuadros que faltan, para no tener que buscarlos.
    AGFOTOS.forEach(function (v, i) {
      var slot = document.getElementById("slot_" + i);
      if (slot) slot.classList.toggle("photo-falta", sinFoto.indexOf(v) >= 0);
    });
    return;
  }

  // El resto sí se puede saltar avisando: el taller no puede quedar detenido
  // porque el asesor no alcanzó a anotar un dato que se completa después.
  var faltan = [];
  if (agRecSel.kmReal == null) faltan.push("el kilometraje real");
  if (!agRecSel.comb) faltan.push("el nivel de combustible");
  Object.keys(FIRMAS).forEach(function (q) {
    if (!(agRecSel.firmas && agRecSel.firmas[q])) faltan.push("la firma del " + q);
  });
  if (faltan.length && !confirm(
        "El acta queda sin " + _enumerar(faltan) + ".\n\n" +
        "Eso es lo que respalda al taller si el cliente reclama después.\n¿Ingresar igual?")) return;
  var a = agRecSel;
  var itv = null;
  if (a.pautaId && pautaCargada(a.pautaId)) {
    var plan = planDe(pautaCargada(a.pautaId), a.anio);
    if (plan && plan.intervalos) itv = plan.intervalos.find(function (x) { return String(x.n) === String(a.revN); }) || null;
  }
  var tipo = mapTipo(a.serv);
  var dur = (itv && horasAMin(itv.horas)) || (tipo === "mant" ? 60 : tipo === "rep" ? 90 : 60);
  // Se pide desde el PISO, no desde el contador guardado: las bandejas que ya
  // existían iban en 61 y habrían seguido entregando números de dos cifras.
  var desdeRo = Math.max(DB.roSeq || 0, RO_MINIMO);
  reservarCorrelativo("ro", desdeRo).then(function (numero) {
    var ro = Math.max(numero != null ? numero : desdeRo, RO_MINIMO);
    DB.roSeq = Math.max(desdeRo, ro + 1);
    _agIngresarTallerCon(a, tipo, dur, formatearRO(ro));
  });
}

// Une los elementos con comas y un "ni" final: "el km real, el combustible ni
// la firma del cliente".
function _enumerar(xs) {
  if (xs.length <= 1) return xs[0] || "";
  return xs.slice(0, -1).join(", ") + " ni " + xs[xs.length - 1];
}

/* ============================================================
   Material para el acta en PDF

   Se toma de la pantalla, en el instante de ingresar: las firmas están en sus
   canvas y las fotos tienen una vista previa local (blob del mismo origen, así
   que se puede leer sin ensuciar el canvas). Pedirlas de vuelta al
   almacenamiento obligaría a generar enlaces firmados y a esperar la red justo
   cuando el asesor tiene al cliente esperando.
   ============================================================ */
function _actaFirmas() {
  var out = {};
  Object.keys(FIRMAS).forEach(function (q) {
    var f = _firmas[q];
    if (f && f.cv && f.trazos) {
      try { out[q] = f.cv.toDataURL("image/png"); } catch (e) { /* sin firma en el PDF */ }
    }
  });
  return out;
}

/* Reduce una imagen a lo que se ve en el acta. Sin esto, ocho fotos de cámara
   de celular dejan un PDF de decenas de MB que nadie puede mandar por correo.

   `formato` permite PNG para las firmas: un trazo negro sobre blanco en JPEG
   sale con halos alrededor. `crossOrigin` es necesario para las imágenes que
   vienen del bucket por enlace firmado: sin eso el canvas queda "manchado" y
   leerlo lanza excepción. */
function _reducirImagen(url, anchoMax, formato) {
  return new Promise(function (listo) {
    var img = new Image();
    // Solo para las que no son del mismo origen; en un blob: local estorba.
    if (/^https?:/i.test(url)) img.crossOrigin = "anonymous";
    img.onload = function () {
      try {
        var esc = Math.min(1, anchoMax / (img.naturalWidth || anchoMax));
        var cv = document.createElement("canvas");
        cv.width = Math.round((img.naturalWidth || anchoMax) * esc);
        cv.height = Math.round((img.naturalHeight || anchoMax) * esc);
        var ctx = cv.getContext("2d");
        if (formato === "image/png") {   // fondo blanco: las firmas son transparentes
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
        }
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        listo(formato === "image/png" ? cv.toDataURL("image/png")
                                      : cv.toDataURL("image/jpeg", 0.72));
      } catch (e) { listo(null); }
    };
    img.onerror = function () { listo(null); };
    img.src = url;
  });
}

function _actaFotos(a) {
  var fotos = (a && a.fotos) || {};
  var tareas = AGFOTOS.filter(function (v) {
    return fotos[v] && fotos[v].preview;
  }).map(function (v) {
    return _reducirImagen(fotos[v].preview, 620).then(function (img) {
      return img ? { t: v, img: img } : null;
    });
  });
  return Promise.all(tareas).then(function (xs) {
    return xs.filter(Boolean);
  });
}

/* Datos de una persona de la nómina, a partir de lo que guarda la cita.

   La cita guarda el nombre corto del asesor ("Matías Figueroa") y la recepción
   guarda el correo de quien la hizo. Los dos apuntan a la misma nómina, así
   que se busca por cualquiera de los dos y se devuelve la ficha completa para
   el acta. Si no se encuentra, se devuelve lo que había: mejor el correo solo
   que un campo vacío. */
function _personaDe(ref) {
  if (!ref) return null;
  var r = String(ref).trim().toLowerCase();
  var p = (PERSONAL || []).find(function (x) {
    return (x.email || "").toLowerCase() === r ||
           (x.corto || "").toLowerCase() === r ||
           (x.nombre || "").toLowerCase() === r;
  });
  if (!p) return { nombre: ref, email: /@/.test(ref) ? ref : null };
  return {
    nombre: p.corto || p.nombre,
    email: p.email || null,
    rol: p.rol === "asesor" ? "Asesor de servicio"
       : p.rol === "tecnico" ? "Técnico" : (p.rol || null),
    sucursal: p.sucursal || null
  };
}

var _logoActa = null;
function _actaLogo() {
  if (_logoActa !== null) return Promise.resolve(_logoActa);
  return _reducirImagen("img/curifor-logo.png", 420).then(function (img) {
    _logoActa = img || "";
    return _logoActa;
  });
}

/* El mapa de daños como imagen, más su leyenda. Sin marcas devuelve null y el
   acta simplemente no trae la sección. */
function _actaDanos(a) {
  if (!window.DanoMapa || !a || !a.danos || !a.danos.length) return Promise.resolve(null);
  return window.DanoMapa.imagen(a.danos, 1400).then(function (r) {
    if (!r) return null;
    return { img: r.img, prop: r.prop, lista: window.DanoMapa.resumen(a.danos) };
  });
}

/* Genera y descarga el acta. Nunca lanza: el PDF es un respaldo, y una
   recepción ya guardada no puede quedar en rojo porque falló un dibujo. */
function agDescargarActa(a, ro) {
  if (!window.ActaPDF || !window.ActaPDF.disponible()) {
    avisoAgenda("La recepción quedó guardada, pero no se pudo generar el PDF del acta.", "warn");
    return Promise.resolve(false);
  }
  var firmas = _actaFirmas();
  return Promise.all([_actaFotos(a), _actaLogo(), _actaDanos(a)]).then(function (r) {
    var doc = window.ActaPDF.generar(a, ro, {
      fotos: r[0], firmas: firmas, logo: r[1] || null, danos: r[2] || null,
      asesor: _personaDe(a.asesor),
      recibio: _personaDe(a.recibidoPor || quienSoy())
    });
    if (!doc) return false;
    doc.save(window.ActaPDF.nombreArchivo(a, ro));
    return true;
  }).catch(function () {
    avisoAgenda("La recepción quedó guardada, pero no se pudo generar el PDF del acta.", "warn");
    return false;
  });
}

function _agIngresarTallerCon(a, tipo, dur, ro) {
  var o = {
    ro: ro,
    oc: a.oc,
    fecha: a.fecha,
    pat: a.pat, marca: a.marcaNombre, modelo: a.modeloNombre, version: a.versionNombre,
    anio: a.anio, km: a.km, revN: a.revN, pautaId: a.pautaId, valorRef: a.valorRef,
    vin: a.vin || "—", color: "—", cliente: a.cli, asesor: a.asesor,
    tipo: tipo, dur: dur, rec: a.hora, del: "—",
    tec: null, ini: null, etapa: "citas_hoy", stop: null,
    // El pre-picking lo HEREDA de la cita: si Preparación ya marcó el kit como
    // recibido, bodega lo ve listo. Antes toda orden nacía con prep:"rec", o
    // sea afirmando una recepción de repuestos que nunca ocurrió.
    picking: kitDe(a) === "recibido" ? "listo" : "pendiente",
    // el acta viaja con la orden: bodega y JPCB necesitan el km REAL, no el
    // estimado de la cita, y el resto es el respaldo ante un reclamo
    kmReal: a.kmReal != null ? a.kmReal : null,
    comb: a.comb || null, acc: a.acc || null, obs: a.obs || null,
    // viaja con la orden: el técnico que la reciba necesita saber lo que pidió
    // el cliente, no solo lo que se constató en el mesón
    coment: a.coment || null,
    recibidoEn: a.recibidoEn || ahoraISO(), recibidoPor: a.recibidoPor || quienSoy()
  };
  anotar(o, "Recepción registrada", a.pat);
  anotar(o, "Etapa", "Citas de hoy");
  DB.orders.push(o);
  a.estado = "en_taller";
  // Cierra el ciclo en Supabase: marca en_taller con su RO y deja el acta
  // completa en la fila, para que toda estación la vea (fail-safe).
  if (a.webId && typeof webActualizarEstado === "function") {
    webActualizarEstado(a.webId, "en_taller", {
      ro: o.ro, oc: typeof a.oc === "number" ? a.oc : null,
      sucursal: a.sucursal || null,
      acc: a.acc || {}, comb: a.comb || null,
      km_real: a.kmReal != null ? a.kmReal : null, obs: a.obs || null,
      recibido_en: o.recibidoEn, recibido_por: o.recibidoPor
    }).catch(function () { /* offline: no bloquea la recepción local */ });
  }
  save();

  // El acta en PDF se arma ANTES de soltar la recepción: necesita las firmas
  // que están en los canvas y las vistas previas de las fotos, y ambas se
  // pierden al limpiar el formulario. No se espera a que termine para avisar:
  // la recepción ya está guardada y el auto puede entrar.
  agDescargarActa(a, o.ro);

  agRecSel = null;
  document.getElementById("recForm").hidden = true;
  document.getElementById("recVacia").hidden = false;
  alert("Recepción " + a.oc + " registrada.\n• Acta firmada descargada en PDF\n• Fotos guardadas\n• Orden de trabajo RO " + o.ro + " creada en el registro");
  renderAll();
  // Los tableros ya no están en esta plataforma (decisión 10-08-2026): después
  // del acta se vuelve a la agenda, lista para recibir el auto siguiente. En el
  // módulo Recepción las pestañas van ocultas y se queda donde está.
  if (window.__moduloVista !== "recepcion") agGoTab("agenda");
}

/* ============================================================
   Tarjetas + tableros (Prep / JPCB / Planificador)
   ============================================================ */
function cardHTML(o) {
  var corner = "";
  if (o.stop) {
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
/* Mover una orden. Son funciones con nombre y no closures dentro de wireDnD
   porque el arrastre NO es el único camino: el drag & drop de HTML5 no dispara
   eventos en pantalla táctil, así que en la tablet del taller los tableros eran
   de solo lectura. Los mismos cambios se hacen desde el detalle de la orden.
   Cada movimiento queda anotado: sin eso no hay forma de saber cuánto estuvo
   una orden detenida ni quién la movió. */
function _nombreDe(lista, id) {
  var x = lista.find(function (e) { return e.id === id; });
  return x ? x.t : id;
}
function moverEtapa(o, etapa) {
  if (!o || o.etapa === etapa) return false;
  o.etapa = etapa;
  o.stop = null;              // avanzar de etapa levanta la detención
  anotar(o, "Etapa", _nombreDe(ETAPAS, etapa));
  return true;
}
function marcarStop(o, stop) {
  if (!o || o.stop === stop) return false;
  o.stop = stop || null;
  anotar(o, "Detención", stop ? _nombreDe(STOPS, stop) : "levantada");
  return true;
}
// Desde el detalle: aplica, guarda y repinta. El drag ya hace eso por su lado.
function otAplicar(ro, campo, valor) {
  var o = byRo(ro);
  if (!o) return;
  var cambio = campo === "etapa" ? moverEtapa(o, valor) : marcarStop(o, valor);
  if (!cambio) return;
  save();
  renderAll();
  detalle(ro);                // refresca el modal con el estado nuevo
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
  bind(".drop[data-etapa]", function (o, z) { moverEtapa(o, z.dataset.etapa); });
  bind(".drop[data-stop]",  function (o, z) { marcarStop(o, z.dataset.stop); });
  // Ya no hay drop[data-prep]: el tablero de preparación dejó de ser kanban de
  // arrastre. Su eje temporal lo calcula la fecha de la cita y el estado del
  // kit se cambia con botones en la tarjeta, que además funcionan en tablet.
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
/* ============================================================
   3 · PREPARACIÓN DE REPUESTOS
   ------------------------------------------------------------
   Se alimenta de las CITAS FUTURAS, no de las órdenes de trabajo. La versión
   anterior leía DB.orders, y una orden nace recién al apretar "Ingresar a
   Taller", o sea cuando el auto YA llegó: preparar repuestos "3 días antes"
   era estructuralmente imposible y el cliente terminaba esperando en el mesón
   mientras bodega recolectaba.

   El estado del kit vive en el propio agendamiento (a.kit) y NO en un mapa
   aparte indexado por OC. Dos razones concretas: reconciliarCorrelativos()
   renumera a.oc cuando dos estaciones chocan, y fusionar() reconstruye el
   documento solo con agendamientos/orders/ocSeq/roSeq/webImp — cualquier clave
   nueva del DB se perdería en silencio en la primera fusión. Como campo de la
   cita viaja gratis por uid en _fusionarLista.
   ============================================================ */
var _prepDia = null;      // día del último render, para detectar el cambio de fecha

function kitInfo(id) {
  return KIT.find(function (x) { return x.id === id; }) || KIT[0];
}
function kitDe(a) {
  var k = a && a.kit;
  return KIT.some(function (x) { return x.id === k; }) ? k : "por_revisar";
}

// Avanza o retrocede el estado del kit. Que se pueda RETROCEDER es
// imprescindible: un ciclo de una sola dirección convierte un clic equivocado
// en un estado falso sin salida, que es exactamente el defecto del tablero
// anterior (toda orden nacía en "Repuestos recibidos" sin que nadie recibiera
// nada).
function agCambiarKit(oc, dir) {
  var a = agFind(oc);
  if (!a) return;
  var i = KIT.findIndex(function (x) { return x.id === kitDe(a); });
  var j = Math.min(Math.max(i + (dir < 0 ? -1 : 1), 0), KIT.length - 1);
  if (j === i) return;
  a.kit = KIT[j].id;
  a.kitEn = ahoraISO();
  a.kitPor = quienSoy();
  save();
  renderPrep();
}

// Semáforo agregado del kit: responde "¿esta cita va a tener problema?" sin
// abrir nada. Parte en GRIS si el inventario todavía no cargó — nunca en
// verde: un verde falso es peor que no decir nada, porque nadie va a revisar.
function semaforoKit(a) {
  var R = getRepuestos(a);
  if (!R.length) {
    return { cls: "sd", ico: "○", txt: "sin kit automático",
             tit: "Esta cita no genera kit desde la pauta (no es mantención por kilometraje, o falta la pauta)." };
  }
  if (!STOCK) {
    return { cls: "sd", ico: "○", txt: "inventario sin cargar",
             tit: "Todavía no se carga el inventario; el semáforo aparece cuando llegue." };
  }
  var faltan = 0, giro = 0;
  R.forEach(function (r) {
    var s = stockDe(r.codigo);
    if (!s || (!(s.c > 0) && !(s.f > 0))) faltan++;
    else if (!(s.c > 0)) giro++;
  });
  // El stock es una foto del inventario, no disponibilidad en vivo: verde hoy
  // no garantiza que la pieza siga ahí el día de la cita. Se dice en el tooltip.
  var foto = STOCK.actualizado ? " · inventario al " + STOCK.actualizado + ", es una foto y no disponibilidad en vivo" : "";
  if (faltan) return { cls: "no", ico: "✕", txt: "faltan " + faltan + " de " + R.length,
                       tit: faltan + " código(s) sin stock en ninguna bodega: hay que pedirlos." + foto };
  if (giro) return { cls: "fro", ico: "!", txt: giro + " en giro Frontera",
                     tit: giro + " código(s) disponibles solo en giro Frontera: requieren traslado." + foto };
  return { cls: "ok", ico: "✓", txt: "kit completo",
           tit: "Los " + R.length + " códigos tienen stock Curifor." + foto };
}

// Columnas por fecha de la cita, CALCULADAS en cada render. Nadie arrastra
// nada para que el tiempo avance.
// "Vencidas" existe a propósito: una cita que pasó sin recibirse es justo la
// que hay que mirar, y filtrarla con `fecha >= hoy` la haría desaparecer en
// silencio.
function _prepColumnas() {
  var hoy = hoyISO();
  var d = new Date(); d.setDate(d.getDate() + 1);
  var manana = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  var cols = [
    { id: "venc",   t: "Vencidas",      cls: "prep-col--venc" },
    { id: "hoy",    t: "Hoy",           cls: "prep-col--hoy" },
    { id: "manana", t: "Mañana",        cls: "prep-col--man" },
    { id: "luego",  t: "Próximos días", cls: "" }
  ];
  cols.forEach(function (c) { c.citas = []; });
  DB.agendamientos.forEach(function (a) {
    if (a.estado !== "agendado" || !a.fecha) return;
    cols[a.fecha < hoy ? 0 : a.fecha === hoy ? 1 : a.fecha === manana ? 2 : 3].citas.push(a);
  });
  cols.forEach(function (c) {
    c.citas.sort(function (x, y) {
      return (x.fecha + (x.hora || "")) < (y.fecha + (y.hora || "")) ? -1 : 1;
    });
  });
  return cols;
}

// Tarjeta propia, no cardHTML(): esa es draggable, se identifica por data-ro y
// su onclick llama detalle(ro), que resuelve con byRo(). Una cita no tiene RO,
// así que el clic moriría en silencio y el arrastre movería un ro undefined.
function prepCardHTML(a) {
  var s = semaforoKit(a);
  var k = kitDe(a);
  var i = KIT.findIndex(function (x) { return x.id === k; });
  var ref = "'" + esc(String(a.oc)).replace(/'/g, "") + "'";
  var auto = [a.marcaNombre, a.modeloNombre].filter(Boolean).join(" ");
  var R = getRepuestos(a);
  var selloKit = a.kitEn ? kitInfo(k).t + " el " + fmtFechaHora(a.kitEn) + (a.kitPor ? " por " + a.kitPor : "") : "Sin registrar todavía";
  return '<div class="prep-card">' +
    '<div class="prep-card__cab"><b>' + esc(a.pat || "—") + "</b>" +
      '<span class="prep-card__cuando">' + esc(fmtFechaCorta(a.fecha)) + (a.hora ? " · " + esc(a.hora) : "") + "</span></div>" +
    '<div class="prep-card__det">' + esc(auto || "Vehículo por confirmar") +
      (a.km ? " · " + esc(etiquetaKm(a.km)) : "") + (R.length ? " · " + R.length + " piezas" : "") + "</div>" +
    '<div class="prep-card__pie">' +
      '<span class="prep-sem prep-sem--' + s.cls + '" title="' + esc(s.tit) + '">' + s.ico + " " + esc(s.txt) + "</span>" +
      '<span class="prep-kit" title="' + esc(selloKit) + '">' +
        (i > 0 ? '<button type="button" class="prep-kit__nav" aria-label="Volver a ' + esc(KIT[i - 1].t) +
                 '" title="Volver a ' + esc(KIT[i - 1].t) + '" onclick="agCambiarKit(' + ref + ',-1)">‹</button>' : "") +
        '<span class="prep-kit__st ' + kitInfo(k).cls + '">' + esc(kitInfo(k).t) + "</span>" +
        (i < KIT.length - 1 ? '<button type="button" class="prep-kit__nav prep-kit__nav--go" aria-label="Marcar ' + esc(KIT[i + 1].t) +
                 '" title="Marcar ' + esc(KIT[i + 1].t) + '" onclick="agCambiarKit(' + ref + ',1)">›</button>' : "") +
      "</span>" +
    "</div>" +
    (R.length ? '<button type="button" class="prep-card__ver" onclick="prepVerKit(' + ref + ')">Ver las ' + R.length + " piezas</button>" : "") +
    "</div>";
}

function renderPrep() {
  var board = document.getElementById("prepBoard");
  if (!board) return;
  _prepDia = hoyISO();
  var nota = document.getElementById("prepNota");
  var cols = _prepColumnas();

  // Las citas sin kit (diagnóstico, reparación, sin pauta) no se pintan —no hay
  // repuestos que preparar— pero se CUENTAN y se dicen abajo, para que nadie
  // crea que se perdieron.
  var sinKit = 0;
  cols.forEach(function (c) {
    c.conKit = c.citas.filter(function (a) {
      if (getRepuestos(a).length) return true;
      sinKit++; return false;
    });
  });

  var total = cols.reduce(function (n, c) { return n + c.conKit.length; }, 0);
  if (!total) {
    board.innerHTML = '<p class="prep-vacio-todo">' +
      (sucursalEstacion()
        ? "No hay citas con kit de repuestos por preparar en <b>" + esc(sucCorta(sucursalEstacion())) + "</b>."
        : "Elige tu sucursal en Agendamiento para ver sus citas.") + "</p>";
  } else {
    board.innerHTML = cols.map(function (c) {
      // la columna de vencidas solo aparece cuando de verdad hay algo atrasado
      if (c.id === "venc" && !c.conKit.length) return "";
      return '<div class="col ' + c.cls + '"><h3>' + c.t +
        ' <span class="count">(' + c.conKit.length + ")</span></h3>" +
        '<div class="prep-lista">' +
        (c.conKit.length ? c.conKit.map(prepCardHTML).join("")
                         : '<p class="prep-vacio">Nada por preparar</p>') +
        "</div></div>";
    }).join("");
  }
  if (nota) {
    nota.hidden = !sinKit;
    nota.textContent = sinKit + " cita" + (sinKit > 1 ? "s" : "") + " de estas fechas no genera" +
      (sinKit > 1 ? "n" : "") + " kit automático (diagnóstico, reparación, o sin pauta cargada).";
  }
}

// Detalle del kit de una cita, con la misma tabla código/repuesto/stock que ya
// usa Bodega.
function prepVerKit(oc) {
  var a = agFind(oc);
  if (!a) return;
  var R = getRepuestos(a);
  var s = semaforoKit(a);
  document.getElementById("m-title").textContent = "Kit de la cita " + a.oc + (a.pat ? " · " + a.pat : "");
  document.getElementById("m-body").innerHTML =
    '<div><span class="lbl">Cita:</span> ' + esc(fmtFechaCorta(a.fecha)) + (a.hora ? " · " + esc(a.hora) : "") + "</div>" +
    '<div><span class="lbl">Vehículo:</span> ' + esc([a.marcaNombre, a.modeloNombre, a.versionNombre].filter(Boolean).join(" ") || "—") + "</div>" +
    '<div><span class="lbl">Servicio:</span> ' + esc(a.serv || "—") + (a.km ? " · " + esc(etiquetaKm(a.km)) : "") + "</div>" +
    '<div><span class="lbl">Cliente:</span> ' + esc(a.cli || "—") + "</div>" +
    '<div style="margin-top:8px"><span class="lbl">Estado del kit:</span> ' + esc(kitInfo(kitDe(a)).t) +
      (a.kitEn ? ' <span style="color:var(--ink-3)">· ' + esc(fmtFechaHora(a.kitEn)) + (a.kitPor ? " · " + esc(a.kitPor) : "") + "</span>" : "") + "</div>" +
    '<div><span class="lbl">Disponibilidad:</span> ' + esc(s.txt) + "</div>" +
    (R.length
      ? "<table><thead><tr><th>Código</th><th>Repuesto</th><th>Cant.</th><th>Stock</th></tr></thead><tbody>" +
        R.map(function (r) {
          return "<tr><td>" + esc(r.codigo) + "</td><td>" + esc(r.desc) +
                 '</td><td style="text-align:center">' + r.cant + "</td><td>" + stkHTML(r.codigo) + "</td></tr>";
        }).join("") + "</tbody></table>"
      : '<div style="margin-top:8px;color:var(--ink-3)">Esta cita no genera kit automático.</div>') +
    '<p class="prox" style="margin-top:10px">El stock es una foto del inventario' +
      (STOCK && STOCK.actualizado ? " al " + esc(STOCK.actualizado) : "") + ", no disponibilidad en vivo.</p>";
  document.getElementById("m-actions").innerHTML = '<button class="agbtn agbtn-navy" onclick="closeM()">Cerrar</button>';
  document.getElementById("ov").classList.add("open");
}
function renderPlan() {
  document.getElementById("legendPlan").innerHTML = "<b>Tipo de trabajo:</b>" +
    Object.keys(TIPOS).map(function (k) { var t = TIPOS[k]; return '<div class="it"><span class="sw" style="background:' + t.color + '"></span>' + t.label + "</div>"; }).join("");
  var act = ordersActivas();
  var bl = document.getElementById("backlogDrop");
  var pend = act.filter(function (o) { return !o.tec && o.etapa !== null; });
  bl.innerHTML = pend.map(function (o) { return cardHTML(o); }).join("") ||
    '<p style="color:var(--ink-3);font-size:12px;margin:4px">Sin órdenes por asignar.</p>';
  var g = document.getElementById("grid");
  if (!TECNICOS.length) {
    // Mejor decirlo que mostrar una grilla vacía sin explicación.
    g.innerHTML = '<tbody><tr><td style="padding:16px;color:var(--ink-3)">' +
      (sucursalEstacion()
        ? "No hay técnicos cargados para <b>" + esc(sucCorta(sucursalEstacion())) + "</b>."
        : "Elige tu sucursal en Agendamiento para ver a sus técnicos.") +
      "</td></tr></tbody>";
    return;
  }
  var gh = '<thead><tr><th class="corner"></th>';
  for (var m = START; m < END; m += STEP) gh += '<th class="time">' + hhmm(m) + "</th>";
  gh += "</tr></thead><tbody>";
  // data-tec lleva el RUT, no la posición en la lista: la lista cambia con la
  // sucursal y con cada alta o baja, así que un índice apuntaría a otra persona.
  TECNICOS.forEach(function (t) {
    gh += '<tr><th class="tech" title="' + esc(t.nombre) + '">' + esc(t.corto) + "</th>";
    for (var mm = START; mm < END; mm += STEP) {
      gh += '<td class="slot" data-tec="' + esc(t.rut) + '" data-min="' + mm + '"></td>';
    }
    gh += "</tr>";
  });
  g.innerHTML = gh + "</tbody>";
  act.filter(function (o) { return o.tec && o.ini; }).forEach(function (o) {
    // si el técnico no es de esta sucursal, su fila no existe y la tarjeta
    // simplemente no se dibuja acá (querySelector devuelve null)
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
    if (o) {
      if (o.tec) anotar(o, "Técnico", "sin asignar");
      o.tec = null; o.ini = null; save(); renderAll();
    }
  });
  g.querySelectorAll("td.slot").forEach(function (td) {
    td.addEventListener("dragover", function (e) { e.preventDefault(); td.classList.add("over"); });
    td.addEventListener("dragleave", function () { td.classList.remove("over"); });
    td.addEventListener("drop", function (e) {
      e.preventDefault(); td.classList.remove("over");
      var o = byRo(e.dataTransfer.getData("ro"));
      if (o) {
        o.tec = td.dataset.tec; o.ini = hhmm(+td.dataset.min);
        if (!o.etapa) o.etapa = "citas_hoy";
        anotar(o, "Técnico", (nombreTecnico(o.tec) || "?") + " · " + o.ini);
        save(); renderAll();
      }
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
  // Un solo estado de kit para las dos vistas. Antes bodega forzaba o.prep pero
  // preparación nunca tocaba o.picking, así que una tarjeta podía estar en
  // "Repuestos recibidos" y en Bodega salir PENDIENTE al mismo tiempo.
  var a = o.oc != null ? agFind(o.oc) : null;
  if (a) {
    a.kit = estado === "listo" ? "recibido" : "pedido";
    a.kitEn = ahoraISO();
    a.kitPor = quienSoy();
  }
  anotar(o, "Pre-picking", estado === "listo" ? "preparado" : "reabierto");
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

  // Acta de recepción: lo que se registró cuando llegó el auto. Es el respaldo
  // del taller frente a un reclamo, así que se muestra completo — incluidos los
  // accesorios que el cliente NO traía, que es lo que se discute después.
  var acta = "";
  if (o.recibidoEn || o.kmReal != null || o.comb || o.acc || o.obs) {
    var nAcc = o.acc ? Object.keys(o.acc).length : 0;
    var faltantes = o.acc ? AGACC.filter(function (x) { return !o.acc[x]; }) : [];
    acta = '<div class="lbl" style="margin-top:10px">Acta de recepción:</div>' +
      '<div><span class="lbl">Llegada:</span> ' + esc(fmtFechaHora(o.recibidoEn)) +
        (o.recibidoPor ? " · recibió " + esc(o.recibidoPor) : "") + "</div>" +
      '<div><span class="lbl">Km real:</span> ' +
        (o.kmReal != null ? o.kmReal.toLocaleString("es-CL") + " km" : '<i style="color:#b42318">sin registrar</i>') +
        ' &nbsp; <span class="lbl">Combustible:</span> ' +
        (o.comb ? esc(o.comb) : '<i style="color:#b42318">sin registrar</i>') + "</div>" +
      '<div><span class="lbl">Accesorios:</span> ' +
        (o.acc ? nAcc + " de " + AGACC.length : '<i style="color:#b42318">sin registrar</i>') +
        (faltantes.length ? ' <span style="color:#b42318">— no trae: ' + esc(faltantes.join(", ")) + "</span>" : "") + "</div>" +
      (o.obs ? '<div><span class="lbl">Observaciones:</span> ' + esc(o.obs) + "</div>" : "") +
      (o.entregadoEn ? '<div><span class="lbl">Entrega:</span> ' + esc(fmtFechaHora(o.entregadoEn)) +
        (o.entregadoPor ? " · entregó " + esc(o.entregadoPor) : "") + "</div>" : "");
  }

  // Trazabilidad: quién movió la orden y cuándo. Lo más nuevo arriba.
  var traza = "";
  if (o.hist && o.hist.length) {
    traza = '<div class="lbl" style="margin-top:10px">Trazabilidad:</div><ul class="traza">' +
      o.hist.slice().reverse().map(function (h) {
        return "<li><b>" + esc(fmtFechaHora(h.en)) + "</b> — " + esc(h.q) +
          (h.d ? ": " + esc(h.d) : "") +
          (h.por ? ' <span class="traza-quien">· ' + esc(h.por) + "</span>" : "") + "</li>";
      }).join("") + "</ul>";
  }

  // Mover la orden SIN arrastrar. El drag & drop de HTML5 no funciona en
  // pantalla táctil, así que en la tablet del taller los tableros eran de solo
  // lectura: se veía el avance pero no se podía registrar.
  var mover = "";
  if (o.etapa !== "entregado") {
    var iEt = ETAPAS.findIndex(function (e) { return e.id === o.etapa; });
    mover = '<div class="ot-mover">' +
      '<div class="ot-mover__tit">Mover esta orden</div>' +
      '<div class="ot-mover__fila">' +
        (iEt > 0 ? '<button class="agbtn agbtn-ghost agbtn-sm" onclick="otAplicar(\'' + esc(o.ro) + "','etapa','" + ETAPAS[iEt - 1].id + '\')">‹ ' + esc(ETAPAS[iEt - 1].t) + "</button>" : "") +
        (iEt >= 0 && iEt < ETAPAS.length - 1 ? '<button class="agbtn agbtn-navy agbtn-sm" onclick="otAplicar(\'' + esc(o.ro) + "','etapa','" + ETAPAS[iEt + 1].id + '\')">' + esc(ETAPAS[iEt + 1].t) + " ›</button>" : "") +
      "</div>" +
      '<div class="ot-mover__fila">' +
        '<label class="ot-mover__lbl">Detención</label>' +
        '<select onchange="otAplicar(\'' + esc(o.ro) + "','stop',this.value)\">" +
          '<option value=""' + (o.stop ? "" : " selected") + ">Ninguna</option>" +
          STOPS.map(function (s) {
            return '<option value="' + s.id + '"' + (o.stop === s.id ? " selected" : "") + ">" + esc(s.t) + "</option>";
          }).join("") +
        "</select>" +
      "</div></div>";
  }

  document.getElementById("m-title").textContent = "Orden de trabajo RO " + o.ro;
  document.getElementById("m-body").innerHTML =
    '<div><span class="lbl">Cliente:</span> ' + o.cliente + "</div>" +
    '<div><span class="lbl">Vehículo:</span> ' + o.marca + " " + o.modelo + (o.version ? " · " + o.version : "") + (o.anio ? " " + o.anio : "") + " · " + o.pat + "</div>" +
    '<div><span class="lbl">VIN:</span> ' + (o.vin || "—") + ' &nbsp; <span class="lbl">Km:</span> ' + (o.km ? o.km.toLocaleString("es-CL") : "—") + "</div>" +
    '<div><span class="lbl">Servicio:</span> ' + servicioDesc(o) + " (" + TIPOS[o.tipo].label + ", " + o.dur + " min)</div>" +
    (val != null ? '<div><span class="lbl">Valor referencial:</span> ' + money(val) + " neto s/IVA</div>" : "") +
    '<div><span class="lbl">Asesor:</span> ' + esc(o.asesor || "—") + ' &nbsp; <span class="lbl">Técnico:</span> ' + esc(nombreTecnico(o.tec) || "(sin asignar)") + "</div>" +
    '<div><span class="lbl">Cita:</span> ' + (o.rec || "—") + ' &nbsp; <span class="lbl">Inicio en taller:</span> ' + (o.ini || "—") + "</div>" +
    '<div><span class="lbl">Etapa:</span> ' + etTxt + ' &nbsp; <span class="lbl">Detención:</span> ' + (o.stop ? STOPS.find(function (s) { return s.id === o.stop; }).t : "Ninguna") + "</div>" +
    '<div><span class="lbl">Kit en bodega:</span> ' + (o.picking === "listo" ? "Preparado" : "Pendiente") + "</div>" +
    mover +
    acta +
    rep +
    traza +
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
  var agHoy = DB.agendamientos.filter(function (a) { return a.fecha === hoyStr; }).length;
  var d2 = new Date(); d2.setDate(d2.getDate() + 1);
  var manIso = d2.getFullYear() + "-" + String(d2.getMonth() + 1).padStart(2, "0") + "-" + String(d2.getDate()).padStart(2, "0");
  var agMan = DB.agendamientos.filter(function (a) { return a.fecha === manIso; }).length;
  // Solo indicadores de agenda: los tableros del taller salieron de esta
  // plataforma el 10-08-2026 (duplicaban el planificador de post venta).
  var kpis = [
    ["Agendamientos hoy", String(agHoy)],
    ["Agendamientos mañana", String(agMan)]
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
  // `dias` = días desde hoy. Las citas futuras son las que alimentan el tablero
  // de preparación, así que la demo trae algunas para que se vea funcionando.
  var specs = [
    { pautaId: "ford__ranger--limited-4x2-2-5l-ivct-l4", marca: "Ford", modelo: "Ranger", anio: "2022", pat: "VFLP46", cli: "Pedro Soto", hora: "08:40", revIdx: 1, modo: "orden", etapa: "citas_hoy" },
    { pautaId: "ford__escape--titanium-2-0l-ecoboost", marca: "Ford", modelo: "Escape", anio: null, pat: "LTCP46", cli: "Ana Reyes", hora: "09:20", revIdx: 0, modo: "orden", etapa: "bajo_serv", tec: 3, ini: "09:40" },
    { pautaId: "hyundai__tucson-nx4-fl-2-0-mpi-costo", marca: "Hyundai", modelo: "Tucson", anio: null, pat: "TZKG17", cli: "Luis Peña", hora: "10:20", revIdx: 2, modo: "orden", etapa: "esp_serv", stop: "repuestos" },
    { pautaId: "gac__emzoom-1-5t-at-gl", marca: "GAC", modelo: "EMZOOM", anio: null, pat: "RRDD71", cli: "María Díaz", hora: "11:00", revIdx: 1, modo: "agenda", kit: "recibido" },
    { pautaId: "ford__territory--trend-1-5l-gtdi", marca: "Ford", modelo: "Territory", anio: null, pat: "KXPL09", cli: "Sofía Rojas", hora: "15:00", revIdx: 0, modo: "agenda" },
    { pautaId: "ford__ranger--limited-4x4-puma-3-2l-tdci", marca: "Ford", modelo: "Ranger", anio: "2022", pat: "JXTB27", cli: "Los Nobles", hora: "09:40", revIdx: 3, modo: "agenda", dias: 1, kit: "pedido" },
    { pautaId: "hyundai__tucson-nx4-fl-2-0-mpi-costo", marca: "Hyundai", modelo: "Tucson", anio: null, pat: "BBFK52", cli: "Carla Muñoz", hora: "14:20", revIdx: 1, modo: "agenda", dias: 3 }
  ];
  function fechaMas(n) {
    var d = new Date(); d.setDate(d.getDate() + (n || 0));
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
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
        oc: DB.ocSeq++, fecha: fechaMas(s.dias), hora: s.hora, sucursal: "CURIFOR TALCA",
        serv: "MANTENCIÓN POR KILOMETRAJE", pat: s.pat,
        marcaNombre: s.marca, modeloNombre: s.modelo, versionNombre: versionN,
        pautaId: s.pautaId, anio: s.anio, km: itv ? itv.km : null, revN: itv ? itv.n : null,
        valorRef: itv ? valorItv(itv) : null,
        vin: null, cli: s.cli + " (demo)", rut: "11.111.111-1", fono: "9 0000 0000", email: "demo@curifor.cl",
        asesor: ASESORES.length ? ASESORES[i % ASESORES.length].corto : "Asesor de prueba",
        estado: s.modo === "agenda" ? "agendado" : "en_taller"
      };
      base.creadoEn = ahoraISO(); base.creadoPor = quienSoy();
      if (s.kit) { base.kit = s.kit; base.kitEn = ahoraISO(); base.kitPor = quienSoy(); }
      if (s.modo === "orden") {
        // llegada simulada unos minutos después de la hora de la cita
        var lleg = new Date(base.fecha + "T" + s.hora + ":00");
        lleg.setMinutes(lleg.getMinutes() + 4 + i * 3);
        base.recibidoEn = lleg.toISOString(); base.recibidoPor = quienSoy();
        base.kmReal = base.km ? base.km + 300 + i * 120 : null;
        base.comb = ["1", "3/4", "1/2", "1/4"][i % 4];
        base.acc = {}; AGACC.slice(0, 14).forEach(function (x) { base.acc[x] = true; });
      }
      DB.agendamientos.push(base);
      if (s.modo === "orden") {
        var od = {
          ro: formatearRO(DB.roSeq++), oc: base.oc, fecha: base.fecha,
          pat: s.pat, marca: s.marca, modelo: s.modelo, version: versionN,
          anio: s.anio, km: base.km, revN: base.revN, pautaId: s.pautaId, valorRef: base.valorRef,
          vin: "—", color: "—", cliente: base.cli, asesor: base.asesor,
          tipo: "mant", dur: (itv && horasAMin(itv.horas)) || 60, rec: s.hora, del: "—",
          // el técnico de demostración sale de los reales de la sucursal
          tec: (s.tec != null && TECNICOS[s.tec % Math.max(TECNICOS.length, 1)])
                 ? TECNICOS[s.tec % TECNICOS.length].rut : null,
          ini: s.ini || null,
          etapa: s.etapa, stop: s.stop || null, picking: kitDe(base) === "recibido" ? "listo" : "pendiente",
          kmReal: base.kmReal, comb: base.comb, acc: base.acc, obs: null,
          recibidoEn: base.recibidoEn, recibidoPor: base.recibidoPor
        };
        anotar(od, "Recepción registrada", s.pat);
        anotar(od, "Etapa", (ETAPAS.find(function (e) { return e.id === s.etapa; }) || {}).t || s.etapa);
        if (s.stop) anotar(od, "Detención", (STOPS.find(function (x) { return x.id === s.stop; }) || {}).t);
        DB.orders.push(od);
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
  DB = { agendamientos: [], orders: [], ocSeq: OC_MINIMO, roSeq: RO_MINIMO, webImp: {} };
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
  if (vistaAgenda === "mes") renderMes();
  // Las pautas se precargaban SOLO en init(). Una cita adoptada o fusionada
  // después (reconciliarConReservas, refrescarRemoto) no tenía su pauta en
  // caché, así que getRepuestos() devolvía [] y el tablero la mostraba "sin
  // kit" siendo una mantención: justo la mentira silenciosa que este rediseño
  // viene a eliminar. Se precarga y se repinta lo que depende del kit.
  precargarPautas().then(function () { renderPrep(); renderBodega(); });
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
  // vista día / mes
  document.querySelectorAll(".ag-vista-btn").forEach(function (b) {
    b.addEventListener("click", function () { agCambiarVista(b.dataset.vista); });
  });
  document.getElementById("mesPrev").addEventListener("click", function () {
    calM--; if (calM < 0) { calM = 11; calY--; } renderMes(); renderCal();
  });
  document.getElementById("mesNext").addEventListener("click", function () {
    calM++; if (calM > 11) { calM = 0; calY++; } renderMes(); renderCal();
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
      return webFetchReservas(s).then(function (rows) {
        WEBRES = rows || [];
        _resUltima = Date.now();
        webBadge();
        // reservas_web manda en los datos de la cita: se reconcilia antes de
        // pintar, así la agenda ya muestra lo que hicieron las otras estaciones
        reconciliarConReservas();
        renderCal(); renderSlots(); renderAgendaTable();
      });
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

  window.addEventListener("resize", agFirmasAlRedimensionar);
  window.addEventListener("orientationchange", agFirmasAlRedimensionar);

  renderCal(); renderSlots(); renderAgendaTable();
  renderPrefillBanner();
  renderAll();

  // estado compartido con las demás estaciones de la sucursal (si hay sesión)
  iniciarSincronizacion();

  // catálogo + stock del cotizador
  var pIdx = fetch("data/indice.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  var pStk = fetch("data/stock.json").then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  // nómina de la sucursal (técnicos del planificador y asesores del modal)
  cargarPersonal().then(function (ok) { if (ok) renderPlan(); });

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
