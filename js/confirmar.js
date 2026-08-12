/* ============================================================
   Confirmar o cancelar una hora, desde el correo.

   La abre el cliente sin cuenta ni sesión: la credencial es el token del
   enlace. Por eso la base solo devuelve lo justo para reconocer la cita —un
   enlace reenviado no puede convertirse en una filtración de datos— y las tres
   funciones que se usan acá exigen ese token.

   Si el correo trae `&a=si` o `&a=no`, la acción se ejecuta al abrir: el
   cliente ya decidió al apretar el botón del correo y pedirle que vuelva a
   elegir en la página es hacerlo trabajar dos veces.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.CURIFOR_AGENDA || {};
  var cuerpo = document.getElementById("confCuerpo");
  var params = new URLSearchParams(location.search);
  var TOKEN = params.get("t") || "";
  var ACCION = params.get("a") || "";

  var MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
               "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function rpc(fn, args) {
    return fetch(CFG.url + "/rest/v1/rpc/" + fn, {
      method: "POST",
      headers: { apikey: CFG.anonKey, Authorization: "Bearer " + CFG.anonKey,
                 "Content-Type": "application/json" },
      body: JSON.stringify(args)
    }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  /* "2026-08-20" -> "jueves 20 de agosto". Se arma a mano y no con toLocale
     porque el navegador del cliente puede estar en otro idioma. */
  function fechaLarga(iso) {
    if (!iso) return "—";
    var p = String(iso).split("-");
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    var dias = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
    return dias[d.getDay()] + " " + (+p[2]) + " de " + MESES[+p[1] - 1] + " de " + p[0];
  }

  function sucursalCorta(s) {
    if (!s) return null;
    var t = String(s).replace(/^CURIFOR\s+/i, "");
    return t.charAt(0) + t.slice(1).toLowerCase();
  }

  function datosCita(c) {
    return '<dl class="conf-datos">' +
      "<dt>Fecha</dt><dd>" + esc(fechaLarga(c.fecha)) + "</dd>" +
      "<dt>Hora</dt><dd>" + esc(c.hora || "por confirmar") + "</dd>" +
      "<dt>Sucursal</dt><dd>" + esc(sucursalCorta(c.sucursal) || "por confirmar") + "</dd>" +
      (c.patente ? "<dt>Vehículo</dt><dd>" + esc(c.patente) +
        (c.vehiculo ? " · " + esc(c.vehiculo) : "") + "</dd>" : "") +
      "</dl>";
  }

  function mensaje(tipo, titulo, texto, extra) {
    cuerpo.innerHTML =
      '<div class="conf-msg conf-msg--' + tipo + '">' +
        '<div class="conf-icono">' + (tipo === "ok" ? "✓" : tipo === "cancel" ? "✕" : "!") + "</div>" +
        "<h1>" + esc(titulo) + "</h1>" +
        "<p>" + texto + "</p>" +
      "</div>" + (extra || "");
  }

  function pedirDecision(c) {
    cuerpo.innerHTML =
      "<h1 class=\"conf-titulo\">Hola" + (c.nombre ? " " + esc(c.nombre) : "") + "</h1>" +
      '<p class="conf-sub">Esta es tu hora en Curifor. ¿La confirmas?</p>' +
      datosCita(c) +
      '<div class="conf-acciones">' +
        '<button type="button" class="conf-btn conf-btn--ok" id="bSi">Sí, confirmo mi hora</button>' +
        '<button type="button" class="conf-btn conf-btn--no" id="bNo">No voy a poder ir</button>' +
      "</div>";
    document.getElementById("bSi").onclick = function () { ejecutar("si", c); };
    document.getElementById("bNo").onclick = function () { confirmarCancelacion(c); };
  }

  /* Cancelar libera la hora para otro cliente y no se puede deshacer solo: se
     pregunta una vez más antes, en la misma página. */
  function confirmarCancelacion(c) {
    cuerpo.innerHTML =
      '<h1 class="conf-titulo">¿Cancelamos tu hora?</h1>' +
      '<p class="conf-sub">La hora queda libre para otro cliente. Si después quieres venir, ' +
      "tendrás que pedir una nueva.</p>" +
      datosCita(c) +
      '<div class="conf-acciones">' +
        '<button type="button" class="conf-btn conf-btn--no" id="bSiCancel">Sí, cancelar mi hora</button>' +
        '<button type="button" class="conf-btn conf-btn--vol" id="bVolver">Volver</button>' +
      "</div>";
    document.getElementById("bSiCancel").onclick = function () { ejecutar("no", c); };
    document.getElementById("bVolver").onclick = function () { pedirDecision(c); };
  }

  function ejecutar(accion, c) {
    cuerpo.innerHTML = '<div class="conf-cargando"><span class="conf-spin"></span> Guardando…</div>';
    var fn = accion === "no" ? "cita_cancelar" : "cita_confirmar";
    rpc(fn, { p_token: TOKEN }).then(function (r) {
      if (!r || r.ok !== true) {
        if (r && r.motivo === "no_confirmable") {
          mensaje("aviso", "Esta hora ya no está activa",
            "Puede que ya la hayamos recibido o que se haya cancelado antes. " +
            "Si crees que es un error, llámanos y lo vemos.");
          return;
        }
        mensaje("aviso", "No pudimos registrar tu respuesta",
          "Vuelve a intentarlo desde el enlace del correo. Si sigue igual, escríbenos.");
        return;
      }
      if (accion === "no") {
        mensaje("cancel", "Tu hora quedó cancelada",
          "Gracias por avisarnos: liberamos el cupo para otro cliente.<br>" +
          "Cuando quieras, puedes pedir una hora nueva en " +
          '<a href="cliente.html">nuestra agenda</a>.');
      } else {
        mensaje("ok", "¡Listo, te esperamos!",
          "Tu hora quedó confirmada. Te recomendamos llegar unos minutos antes.",
          datosCita(c));
      }
    }).catch(function () {
      mensaje("aviso", "No pudimos conectarnos",
        "Revisa tu conexión y vuelve a abrir el enlace del correo.");
    });
  }

  /* ---------- arranque ---------- */
  if (!CFG.url || !CFG.anonKey) {
    mensaje("aviso", "Página no disponible",
      "Falta la configuración del sistema. Avísanos y lo revisamos.");
    return;
  }
  if (!TOKEN) {
    mensaje("aviso", "Enlace incompleto",
      "Abre el enlace directamente desde el correo que te enviamos.");
    return;
  }

  rpc("cita_por_token", { p_token: TOKEN }).then(function (c) {
    if (!c || c.ok !== true) {
      mensaje("aviso", "No encontramos esta hora",
        "El enlace puede haber caducado o estar incompleto. " +
        "Abre el más reciente que te enviamos, o llámanos.");
      return;
    }
    if (c.pasada) {
      mensaje("aviso", "Esta hora ya pasó",
        "Si necesitas una nueva, pídela en <a href=\"cliente.html\">nuestra agenda</a>.");
      return;
    }
    if (c.estado === "cancelada") {
      mensaje("cancel", "Esta hora está cancelada",
        "Si quieres venir igual, pide una nueva en <a href=\"cliente.html\">nuestra agenda</a>.");
      return;
    }
    if (c.confirmada && ACCION !== "no") {
      mensaje("ok", "Tu hora ya estaba confirmada",
        "No tienes que hacer nada más. Te esperamos.", datosCita(c));
      return;
    }
    // El cliente ya apretó un botón en el correo: se respeta esa decisión.
    if (ACCION === "si") { ejecutar("si", c); return; }
    if (ACCION === "no") { confirmarCancelacion(c); return; }
    pedirDecision(c);
  }).catch(function () {
    mensaje("aviso", "No pudimos conectarnos",
      "Revisa tu conexión y vuelve a abrir el enlace del correo.");
  });
})();
