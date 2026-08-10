/* ============================================================
   Post Venta — acceso a los datos desde el navegador.

   Todas las pantallas de post venta (OT, Cuenta Ficha, Informes, Loaners,
   Indicadores, Campañas, Planificador) leen y escriben con esto. La app de
   Streamlit escribe en los MISMOS documentos, así que las dos versiones
   pueden convivir mientras dure la migración: lo que se guarda en una lo ve
   la otra.

   Reglas que impone la base, no este archivo (ver
   herramientas/setup_supabase_postventa.sql):
     · Hay que tener sesión con correo @curifor.com.
     · `usuarios_curifor.json` no sale nunca al navegador.
     · Solo se pueden escribir los documentos que de verdad se editan; los
       que fabrica el consolidador diario son de solo lectura.
     · Guardar exige el sello con el que se leyó: si otro guardó primero, se
       rechaza en vez de pisarlo.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.CURIFOR_AGENDA || {};
  var SESKEY = "curiforTallerWebSes_v1";     // la misma sesión que auth.js

  /* ---------- sesión ---------- */
  function ses() {
    try { return JSON.parse(localStorage.getItem(SESKEY) || "null"); }
    catch (e) { return null; }
  }
  function token() {
    var s = ses();
    return (s && s.access) || "";
  }
  function quienSoy() {
    var s = ses();
    return (s && s.email) || "";
  }

  /* ---------- llamada a la base ---------- */
  function rpc(fn, args) {
    var t = token();
    if (!CFG.url || !t) return Promise.reject(new Error("sin sesión"));
    return fetch(CFG.url + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: {
        apikey: CFG.anonKey,
        Authorization: "Bearer " + t,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(args)
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  /* ---------- caché por documento ----------
     Varias pantallas piden el mismo documento (las OTs las usan el tablero de
     control, los comentarios y las notificaciones). Sin caché, cada una se
     bajaría los 4 MB otra vez. Se guarda la promesa, no el resultado: si dos
     pantallas piden a la vez, se hace UNA sola llamada. */
  var cache = {};

  function leer(nombre, opciones) {
    opciones = opciones || {};
    if (!opciones.fresco && cache[nombre]) return cache[nombre];
    var p = rpc("documento_leer", { p_nombre: nombre }).then(function (r) {
      if (!r || r.ok !== true) {
        delete cache[nombre];
        throw new Error((r && r.motivo) || "no se pudo leer " + nombre);
      }
      return { data: r.data, sello: r.sello };
    }, function (e) {
      delete cache[nombre];
      throw e;
    });
    cache[nombre] = p;
    return p;
  }

  function olvidar(nombre) {
    if (nombre) delete cache[nombre]; else cache = {};
  }

  /* ---------- guardar ----------
     `cambiar` recibe el documento y devuelve el documento modificado. Si otro
     guardó primero, se relee y se vuelve a aplicar el cambio sobre lo último,
     en vez de pisarlo o de hacer perder el trabajo a quien está escribiendo. */
  function guardar(nombre, cambiar, mensaje, _intento) {
    _intento = _intento || 0;
    return leer(nombre, { fresco: _intento > 0 }).then(function (doc) {
      var nuevo = cambiar(doc.data);
      if (nuevo === undefined) nuevo = doc.data;
      return rpc("documento_guardar", {
        p_nombre: nombre, p_data: nuevo, p_sello: doc.sello,
        p_mensaje: mensaje || "plataforma"
      }).then(function (r) {
        if (r && r.ok === true) {
          cache[nombre] = Promise.resolve({ data: nuevo, sello: r.sello });
          return nuevo;
        }
        if (r && r.motivo === "conflicto" && _intento < 3) {
          olvidar(nombre);
          return guardar(nombre, cambiar, mensaje, _intento + 1);
        }
        throw new Error((r && r.motivo) || "no se pudo guardar");
      });
    });
  }

  /* ---------- documentos comprimidos ----------
     Cuenta Ficha, Informes y los bundles guardan su contenido en un campo `gz`
     (gzip + base64) porque de otro modo pesaban demasiado para GitHub. Se
     descomprime con lo que trae el navegador, sin librerías. */
  function descomprimir(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (typeof DecompressionStream === "undefined") {
      return Promise.reject(new Error("este navegador no descomprime gzip"));
    }
    var ds = new DecompressionStream("gzip");
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).json();
  }

  /* Lee un documento que puede venir comprimido y devuelve su contenido real. */
  function leerContenido(nombre) {
    return leer(nombre).then(function (doc) {
      var d = doc.data || {};
      if (d.gz) return descomprimir(d.gz).then(function (x) { return { data: x, meta: d, sello: doc.sello }; });
      return { data: d, meta: d, sello: doc.sello };
    });
  }

  /* ---------- bitácora ----------
     Toda acción que cambia algo deja rastro, igual que en la app antigua. No
     se hace esperar a quien guardó: si la auditoría falla, el trabajo ya está
     guardado y no tiene sentido mostrarle un error por eso. */
  function auditar(accion, detalle, folio) {
    return guardar("audit_log.json", function (d) {
      var regs = (d && d.registros) || [];
      regs.push({
        fecha: fechaHoraChile(), usuario: quienSoy(),
        accion: accion, detalle: detalle || "", folio_ot: folio || ""
      });
      if (regs.length > 2000) regs = regs.slice(regs.length - 2000);
      return { registros: regs };
    }, "auditoría").catch(function () { /* nunca frena al usuario */ });
  }

  /* ---------- fecha y hora de Chile ----------
     La app antigua guarda "dd/mm/aaaa hh:mm" en hora de Chile. Se respeta el
     formato exacto: hay pantallas que ordenan y comparan por ese texto. */
  function fechaHoraChile(d) {
    d = d || new Date();
    var f = new Intl.DateTimeFormat("es-CL", {
      timeZone: "America/Santiago", day: "2-digit", month: "2-digit",
      year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false
    }).formatToParts(d);
    var p = {};
    f.forEach(function (x) { p[x.type] = x.value; });
    return p.day + "/" + p.month + "/" + p.year + " " + p.hour + ":" + p.minute;
  }

  window.PV = {
    leer: leer,
    leerContenido: leerContenido,
    guardar: guardar,
    olvidar: olvidar,
    auditar: auditar,
    quienSoy: quienSoy,
    fechaHoraChile: fechaHoraChile,
    descomprimir: descomprimir
  };
})();
