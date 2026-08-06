/* ============================================================
   Autocompletado de cliente/vehículo · Agenda y Recepción
   Reemplaza la consulta a la API de patente (boostr) por la base
   propia de Curifor: cuando el asesor escribe la PATENTE o el RUT
   en el modal de agendar, rellena los campos faltantes (nombre,
   teléfono, e-mail, marca/modelo, VIN) con el último registro
   conocido.

   Fuente: tablas `vehiculos` y `clientes` en Supabase (subidas
   desde el reporte de agendamientos, ver herramientas/generar_clientes.py).
   Solo lee con el login del asesor (@curifor.com, RLS) → los datos
   personales nunca quedan expuestos públicamente.

   No modifica taller.js: se engancha por fuera a los campos del modal
   y reutiliza sus funciones globales (onMarcaModal/onModeloModal).
   ============================================================ */
(function () {
  "use strict";
  var CFG = window.CURIFOR_AGENDA || {};
  var SESKEY = "curiforTallerWebSes_v1";

  function token() {
    try { var s = JSON.parse(localStorage.getItem(SESKEY) || "null"); return s && s.access; }
    catch (e) { return null; }
  }
  var normPat = function (s) { return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); };
  var normRut = function (s) { return (s || "").toUpperCase().replace(/[^0-9K]/g, ""); };

  function api(path) {
    if (!CFG.url || !CFG.anonKey) return Promise.resolve([]);
    var h = { apikey: CFG.anonKey };
    var t = token(); if (t) h.Authorization = "Bearer " + t;
    return fetch(CFG.url + "/rest/v1/" + path, { headers: h })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
  }

  function set(id, v) {
    var e = document.getElementById(id);
    if (e && v != null && String(v).trim() !== "") { e.value = v; return true; }
    return false;
  }
  function vacio(id) { var e = document.getElementById(id); return e && !e.value.trim(); }

  function estado(msg, ok) {
    var box = document.getElementById("autoMsg");
    if (!box) {
      var ref = document.getElementById("agPatente");
      if (!ref) return;
      box = document.createElement("div"); box.id = "autoMsg";
      box.style.cssText = "grid-column:1/-1;font-size:12.5px;padding:6px 10px;border-radius:8px;margin:2px 0";
      ref.closest("label").parentNode.insertBefore(box, ref.closest("label").nextSibling);
    }
    box.textContent = msg;
    box.style.background = ok ? "#e6f4ec" : "#fff6e2";
    box.style.color = ok ? "#0a7d43" : "#b7791f";
    box.hidden = !msg;
  }

  function rellenarCliente(c) {
    if (!c) return false;
    if (vacio("agCliente")) set("agCliente", c.nombre);
    if (vacio("agFono")) set("agFono", c.cel || c.fono);
    if (vacio("agEmail")) set("agEmail", c.mail);
    if (vacio("agRut") && c.rut) set("agRut", c.rut);
    return true;
  }

  // "FORD RANGER" -> selecciona marca Ford y modelo Ranger en el modal,
  // reutilizando las funciones de taller.js (que son globales)
  function matchVehiculo(txt) {
    if (!txt || !window.INDICE || !window.INDICE.marcas) return;
    var T = txt.toUpperCase();
    var marca = null, mejor = 0;
    window.INDICE.marcas.forEach(function (m) {
      var n = (m.nombre || "").toUpperCase();
      if (n && T.indexOf(n) >= 0 && n.length > mejor) { marca = m; mejor = n.length; }
    });
    if (!marca) return;
    var am = document.getElementById("agMarca"); if (!am) return;
    am.value = marca.id;
    if (typeof window.onMarcaModal === "function") window.onMarcaModal();
    var resto = T.replace((marca.nombre || "").toUpperCase(), "").trim();
    var mods = (window.MSEL && window.MSEL._modelos) || [];
    var idx = -1, mmax = 0;
    mods.forEach(function (mo, i) {
      var n = (mo.nombre || "").toUpperCase();
      if (n && (resto.indexOf(n) >= 0 || (resto.split(" ")[0] && n.indexOf(resto.split(" ")[0]) === 0)) && n.length > mmax) {
        idx = i; mmax = n.length;
      }
    });
    if (idx >= 0) {
      var sm = document.getElementById("agModeloSel");
      sm.value = String(idx);
      if (typeof window.onModeloModal === "function") window.onModeloModal();
    }
  }

  // soloCliente: rellena persona y VIN pero NO toca marca/modelo/versión. Se usa
  // cuando la cita viene del cotizador: ahí ya se eligió la VERSIÓN exacta, y
  // matchVehiculo() solo sabe deducir el modelo — al llamar a onMarcaModal()
  // borraría esa versión y con ella la mantención elegida.
  function porPatente(patRaw, soloCliente) {
    var pat = normPat(patRaw);
    if (pat.length < 5) return;
    estado("Buscando " + pat + "…", true);
    api("vehiculos?patente=eq." + encodeURIComponent(pat) + "&select=modelo,anio,km,vin,rut&limit=1")
      .then(function (rows) {
        var v = rows[0];
        if (!v) { estado("Sin registro previo de esa patente — complétalo a mano.", false); return; }
        if (vacio("agVin")) set("agVin", v.vin);
        if (!soloCliente) matchVehiculo(v.modelo);
        // Se guarda DESPUÉS de matchVehiculo, porque ese llama a onMarcaModal()
        // y ahí se limpia. taller.js lo usa al elegir la versión.
        if (v.anio && window.MSEL) {
          // con soloCliente la pauta ya está cargada y su selector de año lo
          // maneja taller.js; acá el dato se guarda igual porque viaja a la cita
          window.MSEL.anioVehiculo = v.anio;
          // …y se pinta de inmediato. Guardarlo solo en memoria no basta: el
          // campo "Año" se llenaba recién al elegir la versión y hasta entonces
          // se veía vacío, aunque el dato ya estuviera cargado.
          if (typeof window.pintarAnioVehiculo === "function") window.pintarAnioVehiculo();
        }
        var conAnio = v.anio ? " (" + v.anio + ")" : "";
        if (v.rut) {
          return api("clientes?rut=eq." + encodeURIComponent(v.rut) + "&select=nombre,cel,fono,mail,rut&limit=1")
            .then(function (cs) {
              rellenarCliente(cs[0] || { rut: v.rut });
              estado("Datos cargados de " + (v.modelo || "vehículo") + conAnio + (cs[0] ? " · " + cs[0].nombre : ""), true);
            });
        }
        estado("Vehículo cargado (" + (v.modelo || "") + conAnio + "). Sin cliente asociado.", true);
      });
  }

  function porRut(rutRaw) {
    var rut = normRut(rutRaw);
    if (rut.length < 7) return;
    estado("Buscando cliente…", true);
    api("clientes?rut=eq." + encodeURIComponent(rut) + "&select=nombre,cel,fono,mail,rut&limit=1")
      .then(function (cs) {
        if (cs[0]) { rellenarCliente(cs[0]); estado("Cliente: " + cs[0].nombre, true); }
        else estado("Sin registro previo de ese RUT — complétalo a mano.", false);
      });
  }

  function enganchar() {
    var p = document.getElementById("agPatente"), r = document.getElementById("agRut");
    if (p && !p._auto) {
      p._auto = 1;
      p.addEventListener("blur", function () { porPatente(p.value); });
      p.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); porPatente(p.value); } });
    }
    if (r && !r._auto) {
      r._auto = 1;
      r.addEventListener("blur", function () { porRut(r.value); });
    }
  }

  // taller.js la llama al aplicar un prellenado del cotizador, que ya trae la
  // patente escrita: así el asesor no tiene que volver a tipearla para que
  // aparezcan el cliente, el RUT, el teléfono y el VIN.
  window.__autoPorPatente = porPatente;

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", enganchar);
  else enganchar();
  // el modal puede re-renderizarse; reintenta el enganche cada vez que se abre
  document.addEventListener("click", function () { setTimeout(enganchar, 200); });
})();
