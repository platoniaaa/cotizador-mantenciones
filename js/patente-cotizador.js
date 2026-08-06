/* ============================================================
   Consulta por patente del Cotizador · base propia de Curifor
   ------------------------------------------------------------
   El cotizador nació consultando la API externa de patentes (boostr). Esa
   consulta se descartó: sin API key mostraba "no está configurada en esta
   instalación" y el asesor tenía que elegir el vehículo del catálogo a mano.

   Acá se reemplaza por la tabla `vehiculos` de Supabase, que es la misma
   fuente que ya usa la agenda (ver js/autocompletar.js). app.js expone el
   gancho `window.__cotizConsultarPatente` justo para esto, así que no hay que
   tocarlo: si esta función existe, la usa en vez de la API externa.

   Requiere la sesión del personal (@curifor.com): la RLS no entrega datos de
   vehículos a nadie más. cotizador.html ya exige login, así que siempre la hay.

   Devuelve el mismo shape que devolvía la API ({make, model, year}) para que
   app.js siga resolviendo marca/modelo/versión exactamente igual.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.CURIFOR_AGENDA || {};
  var SESKEY = "curiforTallerWebSes_v1";   // misma sesión que auth.js y taller.js

  function token() {
    try {
      var s = JSON.parse(localStorage.getItem(SESKEY) || "null");
      return s && s.access;
    } catch (e) { return null; }
  }

  // La tabla guarda el vehículo como un solo texto ("FORD RANGER"), pero app.js
  // necesita la marca por separado. Se parte usando el catálogo real, no el
  // primer espacio: hay marcas de dos palabras (Land Rover, Great Wall).
  var pMarcas = fetch("data/indice.json")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      return ((j && j.marcas) || [])
        .map(function (m) { return m.nombre; })
        .sort(function (a, b) { return b.length - a.length; });   // la más larga gana
    })
    .catch(function () { return []; });

  function partir(texto, marcas) {
    var T = (texto || "").toUpperCase().trim();
    for (var i = 0; i < marcas.length; i++) {
      var M = marcas[i].toUpperCase();
      if (T === M || T.indexOf(M + " ") === 0) {
        return { make: marcas[i], model: T.slice(M.length).trim() || marcas[i] };
      }
    }
    // marca desconocida: se manda el texto entero y que app.js decida
    return { make: T.split(" ")[0] || T, model: T };
  }

  function error(codigo, msg) {
    var e = new Error(msg || codigo);
    e.codigo = codigo;
    return e;
  }

  window.__cotizConsultarPatente = function (placa) {
    var pat = String(placa || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!CFG.url || !CFG.anonKey) return Promise.reject(error("SIN_KEY"));

    var t = token();
    if (!t) return Promise.reject(error("SIN_SESION", "sin sesión del personal"));

    var url = CFG.url + "/rest/v1/vehiculos?patente=eq." + encodeURIComponent(pat) +
              "&select=modelo,anio,km,vin&limit=1";

    return fetch(url, { headers: { apikey: CFG.anonKey, Authorization: "Bearer " + t } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw error("SIN_SESION", "sesión vencida");
        if (!r.ok) throw error("ERROR", "HTTP " + r.status);
        return r.json();
      })
      .then(function (rows) {
        var v = rows && rows[0];
        if (!v || !v.modelo) throw error("NOT_FOUND");
        return pMarcas.then(function (marcas) {
          var p = partir(v.modelo, marcas);
          return {
            make: p.make,
            model: p.model,
            year: v.anio || null,
            // el resto no lo usa app.js, pero queda disponible para quien lo
            // necesite sin repetir la consulta
            km: v.km || null,
            vin: v.vin || null
          };
        });
      });
  };
})();
