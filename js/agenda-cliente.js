/* ============================================================
   Agendamiento del cliente · tres pasos.

   Orden: primero la persona, después el auto y el servicio, al final el día y
   la hora. Es el orden de Bruno Fritsch, que el equipo revisó y aprobó.

   Dos cosas que este flujo NO hace, a propósito:

   · No autocompleta el nombre, el teléfono ni el correo a partir del RUT. La
     página es pública y corre con la llave anónima; un autocompletado así
     sería un buscador de datos personales abierto a internet: cualquiera
     escribe un RUT ajeno y obtiene a la persona. La patente sí se consulta,
     pero solo devuelve marca y modelo —lo que se ve mirando el auto—, nunca
     al dueño.

   · No deja elegir asesor. Cuando hay varios, el cliente marca siempre el
     primero de la lista y la carga queda desbalanceada. Se asigna solo, por
     carga, y su nombre aparece recién en la confirmación.

   Las consultas a la base van por funciones acotadas (agenda_vehiculo,
   agenda_km_valido) que pueden no estar creadas todavía. Si faltan, el flujo
   sigue: se pierde el autocompletado y la validación de kilometraje, no la
   posibilidad de agendar. Perder una hora agendada es peor que perder una
   comodidad.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.CURIFOR_AGENDA || {};
  var SRV = window.AgendaServicios;
  var WSP = "56956887752";        // el mismo de la vista cliente

  var $ = function (id) { return document.getElementById(id); };

  var F = {
    paso: 1,
    rut: "", nombre: "", correo: "", fono: "",
    terminos: false, marketing: false,
    patente: null, marca: null, modelo: null, anio: null,
    km: null, servicio: null,
    sucursal: null, fecha: null, hora: null,
    asesor: null
  };

  var INDICE = null;   // catálogo, para elegir marca/modelo a mano

  /* ---------- utilidades ---------- */
  function api(ruta, opciones) {
    if (!CFG.url || !CFG.anonKey) return Promise.reject(new Error("sin backend"));
    var o = opciones || {};
    var h = Object.assign({ apikey: CFG.anonKey, Authorization: "Bearer " + CFG.anonKey }, o.headers || {});
    return fetch(CFG.url + "/rest/v1/" + ruta, Object.assign({}, o, { headers: h }));
  }
  function rpc(fn, args) {
    return api("rpc/" + fn, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args || {})
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function normPat(s) { return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
  function soloNum(s) { return String(s || "").replace(/[^0-9]/g, ""); }
  function miles(n) { return Number(n).toLocaleString("es-CL"); }

  function error(cual, msg) {
    var e = $(cual);
    if (!msg) { e.hidden = true; return; }
    e.textContent = msg; e.hidden = false;
    e.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function irAPaso(n) {
    F.paso = n;
    [1, 2, 3].forEach(function (i) { $("p" + i).hidden = (i !== n); });
    $("pOk").hidden = true;
    [].forEach.call(document.querySelectorAll(".pasos__i"), function (li) {
      var p = +li.dataset.p;
      li.classList.toggle("is-on", p === n);
      li.classList.toggle("is-listo", p < n);
    });
    $("pasos").hidden = false;
    window.scrollTo({ top: $("agenda").offsetTop - 12, behavior: "smooth" });
  }

  /* ============================================================
     PASO 1 · datos y consentimientos
     ============================================================ */
  function pintarRut() {
    var v = $("fRut").value.trim();
    var est = $("rutEstado");
    if (!v) { est.textContent = ""; est.className = "campo__ayuda"; return; }
    if (window.Rut && window.Rut.valido(v)) {
      $("fRut").value = window.Rut.formatear(v);
      est.textContent = "RUT válido";
      est.className = "campo__ayuda ok";
    } else {
      est.textContent = "Revisa el RUT: el dígito verificador no calza.";
      est.className = "campo__ayuda mal";
    }
    revisar1();
  }

  function datos1() {
    return {
      rut: $("fRut").value.trim(),
      nombre: $("fNombre").value.trim(),
      correo: $("fCorreo").value.trim(),
      fono: soloNum($("fFono").value),
      terminos: $("fTerminos").checked,
      marketing: $("fMarketing").checked
    };
  }

  function valida1(d) {
    if (d.nombre.length < 3) return "Escribe tu nombre y apellido.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.correo)) return "Ese correo no tiene un formato válido.";
    if (d.fono.length < 8) return "El celular debe tener al menos 8 dígitos.";
    if (d.rut && window.Rut && !window.Rut.valido(d.rut)) return "Revisa el RUT: el dígito verificador no calza.";
    if (!d.terminos) return "Para continuar necesitamos que aceptes los términos y el tratamiento de datos.";
    return null;
  }

  function revisar1() {
    $("btn1").disabled = !!valida1(datos1());
  }

  function seguir1() {
    var d = datos1();
    var mal = valida1(d);
    if (mal) { error("err1", mal); return; }
    error("err1", null);
    Object.assign(F, d);
    if (window.ActaCondiciones) F.condVersion = window.ActaCondiciones.version;
    irAPaso(2);
  }

  /* ============================================================
     PASO 2 · auto, kilometraje y servicio
     ============================================================ */
  function pintarServicios() {
    $("servicios").innerHTML = SRV.SERVICIOS.map(function (s) {
      return '<button type="button" class="servicio" data-s="' + s.id + '">' +
        '<span class="servicio__ico" aria-hidden="true">' + s.icono + "</span>" +
        '<span class="servicio__n">' + esc(s.nombre) + "</span>" +
        '<span class="servicio__d">' + esc(s.detalle) + "</span></button>";
    }).join("");
    [].forEach.call(document.querySelectorAll(".servicio"), function (b) {
      b.addEventListener("click", function () {
        F.servicio = b.dataset.s;
        [].forEach.call(document.querySelectorAll(".servicio"), function (x) {
          x.classList.toggle("is-on", x === b);
        });
        error("err2", null);
      });
    });
  }

  function buscarPatente() {
    var pat = normPat($("fPatente").value);
    $("fPatente").value = pat;
    var est = $("patenteEstado");
    if (pat.length < 5) { est.textContent = "Escribe la patente completa."; est.className = "campo__ayuda mal"; return; }

    F.patente = pat;
    est.textContent = "Buscando…"; est.className = "campo__ayuda";
    rpc("agenda_vehiculo", { p_patente: pat })
      .then(function (filas) {
        var v = filas && filas[0];
        if (!v || !v.modelo) {
          est.textContent = "No encontramos esa patente. Elige la marca y el modelo a mano.";
          est.className = "campo__ayuda";
          mostrarManual(true);
          return;
        }
        /* La base guarda el vehículo como un texto único ("FORD RANGER"), pero
           la cita lleva marca y modelo en columnas separadas. Se parte por la
           primera palabra, que es como quedó cargado el padrón. */
        var partes = String(v.modelo || "").trim().split(/\s+/);
        F.marca = partes.shift() || null;
        F.modelo = partes.join(" ") || v.modelo;
        F.anio = v.anio || null;
        est.textContent = "Es tu " + v.modelo + (v.anio ? " " + v.anio : "") + ".";
        est.className = "campo__ayuda ok";
      })
      .catch(function () {
        /* La función puede no estar creada todavía. No se bloquea: se le pide
           el auto a mano, que es lo que el cliente sabe igual. */
        est.textContent = "No pudimos cargar tu auto. Elígelo a mano y seguimos.";
        est.className = "campo__ayuda";
        mostrarManual(true);
      });
  }

  function mostrarManual(si) {
    $("manual").hidden = !si;
    $("porPatente").hidden = si;
    if (si && INDICE && !$("fMarca").dataset.listo) llenarMarcas();
  }

  function llenarMarcas() {
    var marcas = INDICE.marcas.slice().sort(function (a, b) {
      return a.nombre.localeCompare(b.nombre, "es");
    });
    $("fMarca").innerHTML = '<option value="">Elige la marca</option>' +
      marcas.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.nombre) + "</option>"; }).join("");
    $("fMarca").dataset.listo = "1";
    $("fMarca").addEventListener("change", function () {
      var m = INDICE.marcas.find(function (x) { return x.id === $("fMarca").value; });
      F.marca = m ? m.nombre : null;
      F.modelo = null;
      var sel = $("fModelo");
      if (!m) { sel.innerHTML = '<option value="">Elige el modelo</option>'; sel.disabled = true; return; }
      var mods = m.modelos.slice().sort(function (a, b) { return a.nombre.localeCompare(b.nombre, "es"); });
      sel.innerHTML = '<option value="">Elige el modelo</option>' +
        mods.map(function (x) { return "<option>" + esc(x.nombre) + "</option>"; }).join("");
      sel.disabled = false;
    });
    /* Solo el modelo: la marca viaja en su propia columna y concatenarlas dejaba
       "Hyundai Hyundai Accent" al armar la cita en el taller. */
    $("fModelo").addEventListener("change", function () {
      F.modelo = $("fModelo").value || null;
    });
  }

  /* El kilometraje se valida contra el último que registramos. La comprobación
     la hace la base y responde sí o no: nunca nos entrega el kilometraje
     guardado, para no exponer información del negocio en una página pública. */
  function revisarKm() {
    var km = parseInt(soloNum($("fKm").value), 10);
    var est = $("kmEstado");
    if (isNaN(km)) { est.textContent = ""; return Promise.resolve(true); }
    $("fKm").value = miles(km);
    F.km = km;
    if (!F.patente) { est.textContent = ""; return Promise.resolve(true); }
    return rpc("agenda_km_valido", { p_patente: F.patente, p_km: km })
      .then(function (ok) {
        if (ok === false) {
          est.textContent = "Ese kilometraje es menor al que tenemos registrado para tu auto. Revísalo en el tablero.";
          est.className = "campo__ayuda mal";
          return false;
        }
        est.textContent = ""; est.className = "campo__ayuda";
        return true;
      })
      .catch(function () { est.textContent = ""; return true; });
  }

  function seguir2() {
    if (!F.modelo && !F.patente) { error("err2", "Dinos cuál es tu auto: escribe la patente o elígelo a mano."); return; }
    var km = parseInt(soloNum($("fKm").value), 10);
    if (isNaN(km) || km <= 0) { error("err2", "El kilometraje es obligatorio. Míralo en el tablero."); return; }
    if (km > 2000000) { error("err2", "Ese kilometraje no parece correcto."); return; }
    if (!F.servicio) { error("err2", "Elige qué necesitas."); return; }
    error("err2", null);
    F.km = km;
    revisarKm().then(function (ok) {
      if (!ok) { error("err2", "Revisa el kilometraje antes de continuar."); return; }
      pintarSucursales();
      irAPaso(3);
    });
  }

  /* ============================================================
     PASO 3 · sucursal, día y hora
     ============================================================ */
  function pintarSucursales() {
    var s = SRV.servicio(F.servicio);
    var lista = SRV.sucursalesPara(F.servicio, F.marca);
    $("sucSub").textContent = lista.length
      ? "Estos son los talleres que atienden " + s.nombre.toLowerCase() + "."
      : "Por ahora no tenemos talleres con ese servicio disponibles en línea.";
    $("sucursales").innerHTML = lista.map(function (x) {
      return '<button type="button" class="suc" data-s="' + esc(x.id) + '">' +
        '<span class="suc__n">' + esc(x.nombre) + "</span>" +
        (x.direccion ? '<span class="suc__d">' + esc(x.direccion) + "</span>" : "") +
        "</button>";
    }).join("");
    [].forEach.call(document.querySelectorAll(".suc"), function (b) {
      b.addEventListener("click", function () {
        F.sucursal = b.dataset.s;
        F.hora = null;
        [].forEach.call(document.querySelectorAll(".suc"), function (x) { x.classList.toggle("is-on", x === b); });
        $("cuando").hidden = false;
        $("horas").hidden = true;
        pintarResumen();
      });
    });
  }

  function pintarHoras() {
    var h = SRV.horasPara(F.servicio, F.sucursal);
    function bloques(lista) {
      return lista.map(function (x) {
        return '<button type="button" class="bloque" data-h="' + x + '">' + x + "</button>";
      }).join("") || '<p class="vacio">Sin cupos en esta jornada.</p>';
    }
    $("horasAM").innerHTML = bloques(h.manana);
    $("horasPM").innerHTML = bloques(h.tarde);
    $("horas").hidden = false;
    [].forEach.call(document.querySelectorAll(".bloque"), function (b) {
      b.addEventListener("click", function () {
        F.hora = b.dataset.h;
        [].forEach.call(document.querySelectorAll(".bloque"), function (x) { x.classList.toggle("is-on", x === b); });
        pintarResumen();
      });
    });
  }

  function fechaLarga(iso) {
    var d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
  }

  function pintarResumen() {
    var listo = F.sucursal && F.fecha && F.hora;
    $("btn3").disabled = !listo;
    if (!listo) { $("resumen").hidden = true; return; }
    var suc = SRV.SUCURSALES.find(function (x) { return x.id === F.sucursal; }) || {};
    var srv = SRV.servicio(F.servicio) || {};
    F.asesor = SRV.asignarAsesor(F.servicio, F.sucursal, {});
    $("resumen").hidden = false;
    $("resumen").innerHTML = texto(suc, srv);
    return texto(suc, srv);
  }

  function texto(suc, srv) {
    var quien = F.asesor ? esc(F.asesor.nombre || F.asesor.correo) : null;
    return '<p class="resumen__t">' +
      "Agendas <b>" + esc(srv.nombre) + "</b> en <b>" + esc(suc.nombre) + "</b>" +
      (quien ? " con <b>" + quien + "</b>" : "") +
      " el <b>" + esc(fechaLarga(F.fecha)) + "</b> a las <b>" + esc(F.hora) + "</b>." +
      "</p>" +
      '<ul class="resumen__l">' +
        "<li><span>Vehículo</span>" + esc([F.modelo, F.anio].filter(Boolean).join(" ") || F.patente || "—") + "</li>" +
        (F.patente ? "<li><span>Patente</span>" + esc(F.patente) + "</li>" : "") +
        "<li><span>Kilometraje</span>" + miles(F.km) + " km</li>" +
        "<li><span>A nombre de</span>" + esc(F.nombre) + "</li>" +
      "</ul>";
  }

  function confirmar() {
    if (!F.sucursal || !F.fecha || !F.hora) return;
    var btn = $("btn3");
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = "Agendando…";

    var cuerpo = {
      nombre: F.nombre, fono: "+56 " + F.fono, email: F.correo || null,
      rut: F.rut || null,
      patente: F.patente || null,
      fecha: F.fecha, hora: F.hora,
      marca: F.marca || null, modelo: F.modelo || null, anio: F.anio || null,
      servicio: F.servicio,
      km_declarado: F.km,
      sucursal: F.sucursal,
      asesor: F.asesor ? (F.asesor.correo || null) : null,
      marketing: !!F.marketing,
      cond_version: F.condVersion || null,
      origen: "cliente_web"
    };

    api(CFG.tabla || "reservas_web", {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(cuerpo)
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      listo();
    }).catch(function () {
      btn.disabled = false; btn.textContent = original;
      error("err3", "No pudimos enviar tu solicitud. Inténtalo de nuevo en un momento.");
    });
  }

  function listo() {
    var suc = SRV.SUCURSALES.find(function (x) { return x.id === F.sucursal; }) || {};
    var srv = SRV.servicio(F.servicio) || {};
    $("pasos").hidden = true;
    [1, 2, 3].forEach(function (i) { $("p" + i).hidden = true; });
    $("pOk").hidden = false;
    $("resumenOk").innerHTML = texto(suc, srv);
    var msg = "Hola, acabo de agendar " + srv.nombre.toLowerCase() + " en " + suc.nombre +
              " para el " + fechaLarga(F.fecha) + " a las " + F.hora + ".";
    $("okWsp").href = "https://wa.me/" + WSP + "?text=" + encodeURIComponent(msg);
    window.scrollTo({ top: $("agenda").offsetTop - 12, behavior: "smooth" });
  }

  /* ============================================================
     arranque
     ============================================================ */
  function enlazar() {
    $("fRut").addEventListener("blur", pintarRut);
    ["fNombre", "fCorreo", "fFono", "fRut"].forEach(function (id) {
      $(id).addEventListener("input", revisar1);
    });
    $("fTerminos").addEventListener("change", revisar1);
    $("btn1").addEventListener("click", seguir1);

    $("btnPatente").addEventListener("click", buscarPatente);
    $("fPatente").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); buscarPatente(); }
    });
    $("sinPatente").addEventListener("click", function () { mostrarManual(true); });
    $("conPatente").addEventListener("click", function () { mostrarManual(false); });
    $("fKm").addEventListener("blur", revisarKm);
    $("atras2").addEventListener("click", function () { irAPaso(1); });
    $("btn2").addEventListener("click", seguir2);

    var hoy = new Date(); hoy.setDate(hoy.getDate() + 1);
    var tope = new Date(); tope.setDate(tope.getDate() + 60);
    var iso = function (d) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
             "-" + String(d.getDate()).padStart(2, "0");
    };
    $("fFecha").min = iso(hoy);
    $("fFecha").max = iso(tope);
    $("fFecha").addEventListener("change", function () {
      F.fecha = $("fFecha").value || null;
      F.hora = null;
      if (F.fecha) pintarHoras();
      pintarResumen();
    });
    $("atras3").addEventListener("click", function () { irAPaso(2); });
    $("btn3").addEventListener("click", confirmar);

    $("verTerminos").addEventListener("click", function (e) {
      e.preventDefault();
      var C = window.ActaCondiciones;
      if (!C) return;
      alert(C.datosTitulo + "\n\n" + C.datos.join("\n\n"));
    });

    var globo = $("globoAyuda");
    globo.hidden = false;
    globo.addEventListener("click", function () {
      window.open("https://wa.me/" + WSP + "?text=" +
        encodeURIComponent("Hola, tengo una duda para agendar una hora en el taller."), "_blank");
    });
  }

  function arrancar() {
    pintarServicios();
    enlazar();
    fetch("data/indice.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { INDICE = j; })
      .catch(function () { INDICE = null; });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arrancar);
  else arrancar();
})();
