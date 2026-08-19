/* ============================================================
   Mapa de daños del vehículo (Recepción).

   El asesor marca en un diagrama dónde viene golpeado el auto, en vez de
   describirlo en prosa. "Rayón en la puerta trasera derecha" depende de si
   quien lo escribió contaba las puertas desde adelante y de si "derecha" es
   mirando el auto o sentado en él; un punto en un dibujo no depende de nada.

   El texto de Observaciones NO se reemplaza: sigue estando para lo que un
   punto no puede decir (profundidad del rayón, quién lo declara, si el cliente
   ya lo sabía). El mapa dice DÓNDE, el texto dice QUÉ.

   Cinco vistas, porque los golpes que se discuten después son casi siempre de
   esquina, y en una sola vista lateral una esquina no existe.

   El dibujo es genérico a propósito: la flota va de un Accent a un camión, y un
   contorno reconocible sirve para todos. Uno calcado de un modelo puntual
   obligaría a mantener un dibujo por marca y a explicarle al cliente por qué
   el auto del acta no es el suyo.
   ============================================================ */
(function () {
  "use strict";

  var TRAZO = "#20344f";

  /* Tipos de daño. La LETRA y el número son lo que manda: el acta se imprime,
     muchas veces en blanco y negro, y ahí el color no distingue nada. El color
     es la ayuda en pantalla, no la información. */
  var TIPOS = [
    { id: "R", nombre: "Rayón",       color: "#c9800a" },
    { id: "A", nombre: "Abolladura",  color: "#1f5fb4" },
    { id: "Q", nombre: "Quebrado",    color: "#a8202a" },
    { id: "F", nombre: "Falta pieza", color: "#6c3fa0" },
    { id: "P", nombre: "Pintura",     color: "#0a7d43" }
  ];

  /* Las vistas. El viewBox de cada una es su propio sistema de coordenadas;
     las marcas se guardan en 0..1 para que no dependan del tamaño en pantalla
     ni de que mañana el dibujo cambie de escala. */
  var VISTAS = [
    { id: "sup", nombre: "Vista superior",    w: 240, h: 120 },
    { id: "izq", nombre: "Lateral izquierdo", w: 240, h: 110 },
    { id: "der", nombre: "Lateral derecho",   w: 240, h: 110 },
    { id: "fre", nombre: "Frontal",           w: 160, h: 120 },
    { id: "pos", nombre: "Posterior",         w: 160, h: 120 }
  ];

  /* ---------- los dibujos ----------
     Contornos simples y cerrados. No es un plano: es un mapa donde apoyar el
     dedo, y el detalle de más solo compite con las marcas. */
  /* Vista superior, morro a la IZQUIERDA igual que los laterales: las cinco
     vistas apuntando para el mismo lado se leen de corrido.

     Rectángulos redondeados y no curvas a pulso: dibujada a mano, la
     carrocería desde arriba salía como una cápsula sin adelante ni atrás. Acá
     el morro se reconoce porque el capó es más largo que el maletero, que es
     justo lo que uno mira en un auto real visto desde arriba.

     Tres paños y nada más: capó, habitáculo y maletero. Un intento anterior
     dibujaba parabrisas y luneta en diagonal, y esas diagonales sobre el techo
     se leían como aletas en vez de vidrios. */
  function dibujoSup() {
    return [
      '<rect x="32" y="26" width="186" height="68" rx="18"/>',   // carroceria
      '<path d="M92,26 L92,94"/>',                               // capot / habitaculo
      '<path d="M186,26 L186,94"/>',                             // habitaculo / maletero
      '<rect x="96" y="36" width="86" height="48" rx="10"/>',    // habitaculo
      '<path d="M110,36 L110,84"/>',                             // parabrisas
      '<path d="M168,36 L168,84"/>',                             // luneta
      '<rect x="54" y="20" width="28" height="10" rx="3" fill="#fff"/>',   // ruedas
      '<rect x="54" y="90" width="28" height="10" rx="3" fill="#fff"/>',
      '<rect x="156" y="20" width="28" height="10" rx="3" fill="#fff"/>',
      '<rect x="156" y="90" width="28" height="10" rx="3" fill="#fff"/>'
    ].join("");
  }

  function dibujoLateral(espejo) {
    var d = [
      '<path d="M16,80 L16,58 C16,52 20,48 28,46 L68,40 L94,20',
      'C98,16 104,14 112,14 L158,14 C166,14 172,16 176,21 L196,43',
      'L218,48 C226,50 230,54 230,60 L230,80 Z"/>',
      '<path d="M100,24 L120,24 L120,42 L84,42 Z"/>',
      '<path d="M128,24 L156,24 C162,24 166,26 169,30 L179,42 L128,42 Z"/>',
      '<path d="M124,24 L124,80"/>',
      '<path d="M108,52 L118,52"/><path d="M136,52 L146,52"/>',
      '<path d="M16,68 L28,68" stroke-dasharray="3 3"/>',
      '<path d="M218,68 L230,68" stroke-dasharray="3 3"/>',
      '<circle cx="62" cy="82" r="17" fill="#fff"/><circle cx="62" cy="82" r="7"/>',
      '<circle cx="186" cy="82" r="17" fill="#fff"/><circle cx="186" cy="82" r="7"/>'
    ].join("");
    /* El lateral derecho es el mismo dibujo dado vuelta: un auto es simétrico,
       y tener dos dibujos casi iguales solo significa dos dibujos que corregir
       cada vez que se ajusta uno. */
    return espejo ? '<g transform="translate(240,0) scale(-1,1)">' + d + "</g>" : d;
  }

  function dibujoFre() {
    return [
      '<path d="M22,98 L22,54 C22,46 27,40 35,38 L47,24',
      'C51,19 58,16 66,16 L94,16 C102,16 109,19 113,24 L125,38',
      'C133,40 138,46 138,54 L138,98 Z"/>',
      '<path d="M50,38 L60,24 L100,24 L110,38 Z"/>',
      '<path d="M35,38 L125,38"/>',
      '<path d="M22,74 L138,74"/>',
      '<rect x="30" y="48" width="24" height="11" rx="4"/>',
      '<rect x="106" y="48" width="24" height="11" rx="4"/>',
      '<rect x="62" y="80" width="36" height="12" rx="3"/>',
      '<path d="M60,64 L100,64"/>',
      '<path d="M22,52 L12,52"/><path d="M138,52 L148,52"/>'
    ].join("");
  }

  function dibujoPos() {
    return [
      '<path d="M22,98 L22,54 C22,46 27,40 35,38 L45,22',
      'C49,18 56,16 64,16 L96,16 C104,16 111,18 115,22 L125,38',
      'C133,40 138,46 138,54 L138,98 Z"/>',
      '<path d="M48,38 L56,24 L104,24 L112,38 Z"/>',
      '<path d="M35,38 L125,38"/>',
      '<path d="M22,76 L138,76"/>',
      '<rect x="28" y="48" width="26" height="13" rx="3"/>',
      '<rect x="106" y="48" width="26" height="13" rx="3"/>',
      '<rect x="66" y="64" width="28" height="8" rx="2"/>',
      '<path d="M112,86 L124,86"/>'
    ].join("");
  }

  function dibujoDe(id) {
    if (id === "sup") return dibujoSup();
    if (id === "izq") return dibujoLateral(false);
    if (id === "der") return dibujoLateral(true);
    if (id === "fre") return dibujoFre();
    return dibujoPos();
  }

  function vistaDe(id) {
    for (var i = 0; i < VISTAS.length; i++) if (VISTAS[i].id === id) return VISTAS[i];
    return null;
  }
  function tipoDe(id) {
    for (var i = 0; i < TIPOS.length; i++) if (TIPOS[i].id === id) return TIPOS[i];
    return TIPOS[0];
  }

  /* Las marcas de una vista, con el número que les toca en la lista COMPLETA:
     el número tiene que ser el mismo en el dibujo y en la leyenda, o el acta no
     se puede leer. */
  function marcasDe(danos, vistaId) {
    var out = [];
    (danos || []).forEach(function (d, i) {
      if (d.v === vistaId) out.push({ d: d, n: i + 1 });
    });
    return out;
  }

  function svgMarcas(danos, vistaId, r) {
    var v = vistaDe(vistaId);
    return marcasDe(danos, vistaId).map(function (m) {
      var x = m.d.x * v.w, y = m.d.y * v.h;
      var t = tipoDe(m.d.t);
      return '<g class="dm-marca" data-i="' + (m.n - 1) + '">' +
        '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + t.color + '" ' +
        'stroke="#fff" stroke-width="1.5"/>' +
        '<text x="' + x + '" y="' + (y + r * 0.36) + '" text-anchor="middle" ' +
        'font-size="' + (r * 1.15) + '" font-family="Helvetica,Arial,sans-serif" ' +
        'font-weight="bold" fill="#fff" stroke="none">' + m.n + "</text></g>";
    }).join("");
  }

  function svgVista(vistaId, danos, radio) {
    var v = vistaDe(vistaId);
    return '<svg class="dm-svg" viewBox="0 0 ' + v.w + " " + v.h + '" ' +
      'xmlns="http://www.w3.org/2000/svg" data-v="' + vistaId + '">' +
      '<g fill="none" stroke="' + TRAZO + '" stroke-width="1.6" ' +
      'stroke-linejoin="round" stroke-linecap="round">' + dibujoDe(vistaId) + "</g>" +
      svgMarcas(danos, vistaId, radio || 9) + "</svg>";
  }

  /* Un punto sin explicación no sirve de respaldo: hay que poder leer
     "3 · Abolladura · Lateral derecho" sin tener el dibujo delante. */
  function resumen(danos) {
    return (danos || []).map(function (d, i) {
      return (i + 1) + " · " + tipoDe(d.t).nombre + " · " + ((vistaDe(d.v) || {}).nombre || "");
    });
  }

  /* ---------- montaje en la pantalla ---------- */
  function montar(caja, cfg) {
    cfg = cfg || {};
    var danos = cfg.danos || [];
    var sel = TIPOS[0].id;

    function avisar() { if (cfg.onCambio) cfg.onCambio(danos); }

    function pintar() {
      caja.innerHTML =
        '<div class="dm-tipos">' +
          TIPOS.map(function (t) {
            return '<button type="button" class="dm-tipo' + (t.id === sel ? " is-on" : "") +
              '" data-t="' + t.id + '"><i style="background:' + t.color + '"></i>' +
              t.nombre + "</button>";
          }).join("") +
          '<span class="dm-ayuda">Toca el diagrama donde viene el daño. ' +
          "Toca una marca para borrarla.</span>" +
        "</div>" +
        '<div class="dm-vistas">' +
          VISTAS.map(function (v) {
            return '<figure class="dm-vista"><figcaption>' + v.nombre + "</figcaption>" +
              svgVista(v.id, danos) + "</figure>";
          }).join("") +
        "</div>" +
        (danos.length
          ? '<ol class="dm-lista">' + danos.map(function (d, i) {
              var t = tipoDe(d.t);
              return '<li><span class="dm-n" style="background:' + t.color + '">' + (i + 1) +
                "</span>" + t.nombre + " · " + ((vistaDe(d.v) || {}).nombre || "") +
                '<button type="button" class="dm-quitar" data-i="' + i + '" ' +
                'aria-label="Quitar marca ' + (i + 1) + '">&#10005;</button></li>';
            }).join("") + "</ol>"
          : '<p class="dm-vacio">Sin daños marcados. El acta dirá que el vehículo ' +
            "se recibe sin daños declarados.</p>");
      enlazar();
    }

    function enlazar() {
      caja.querySelectorAll(".dm-tipo").forEach(function (b) {
        b.addEventListener("click", function () { sel = b.dataset.t; pintar(); });
      });
      caja.querySelectorAll(".dm-quitar").forEach(function (b) {
        b.addEventListener("click", function () {
          danos.splice(+b.dataset.i, 1); avisar(); pintar();
        });
      });
      caja.querySelectorAll(".dm-svg").forEach(function (svg) {
        svg.addEventListener("click", function (ev) {
          // clic sobre una marca existente = borrarla
          var g = ev.target.closest(".dm-marca");
          if (g) { danos.splice(+g.dataset.i, 1); avisar(); pintar(); return; }
          /* Coordenadas relativas al SVG, no de la pantalla: el dibujo se
             escala con el ancho disponible y en un tablet no mide lo mismo que
             en el monitor del mesón. */
          var v = vistaDe(svg.dataset.v);
          var r = svg.getBoundingClientRect();
          var x = (ev.clientX - r.left) / r.width;
          var y = (ev.clientY - r.top) / r.height;
          if (x < 0 || x > 1 || y < 0 || y > 1) return;
          danos.push({ v: v.id, x: +x.toFixed(4), y: +y.toFixed(4), t: sel });
          avisar(); pintar();
        });
      });
    }

    pintar();
    return { pintar: pintar, danos: function () { return danos; } };
  }

  /* ---------- imagen para el acta en PDF ----------
     En DOS filas, no en una. Las cinco vistas en fila caben en los 182 mm de
     ancho útil del acta, pero cada una queda de 21 mm de alto y los números de
     las marcas salen de milímetro y medio en papel: el acta se imprime y se
     archiva, y un mapa que no se puede leer no respalda nada.

     Los dos laterales arriba y solos, porque son los que más se marcan y los
     que más se discuten después. */
  var FILAS = [["izq", "der"], ["sup", "fre", "pos"]];

  function imagen(danos, anchoPx) {
    if (!danos || !danos.length) return Promise.resolve(null);
    var ancho = anchoPx || 1400;
    var sep = 12, etiqueta = 13;
    var W = 1000;                       // ancho de referencia del lienzo

    var filas = FILAS.map(function (ids) {
      var vs = ids.map(vistaDe);
      var razon = vs.reduce(function (t, v) { return t + v.w / v.h; }, 0);
      // alto que hace que la fila ocupe exactamente el ancho disponible
      var h = (W - sep * (vs.length - 1)) / razon;
      return { vs: vs, h: h };
    });
    var totalH = filas.reduce(function (t, f) { return t + f.h + etiqueta; }, 0) +
                 sep * (filas.length - 1);

    var partes = [], y = 0;
    filas.forEach(function (f) {
      var x = 0;
      f.vs.forEach(function (v) {
        var w = v.w / v.h * f.h;
        partes.push('<g transform="translate(' + x + "," + y + ')">' +
          '<text x="' + (w / 2) + '" y="9" text-anchor="middle" font-size="9" ' +
          'font-family="Helvetica,Arial,sans-serif" fill="#6e7d91">' + v.nombre + "</text>" +
          '<g transform="translate(0,' + etiqueta + ") scale(" + (f.h / v.h) + ')">' +
            '<g fill="none" stroke="' + TRAZO + '" stroke-width="1.6" ' +
            'stroke-linejoin="round" stroke-linecap="round">' + dibujoDe(v.id) + "</g>" +
            svgMarcas(danos, v.id, 9) +
          "</g></g>");
        x += w + sep;
      });
      y += f.h + etiqueta + sep;
    });

    var totalW = W;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW +
      '" height="' + totalH + '" viewBox="0 0 ' + totalW + " " + totalH + '">' +
      '<rect width="100%" height="100%" fill="#fff"/>' + partes.join("") + "</svg>";

    return new Promise(function (listo) {
      var img = new Image();
      var esc = ancho / totalW;
      img.onload = function () {
        try {
          var cv = document.createElement("canvas");
          cv.width = Math.round(totalW * esc);
          cv.height = Math.round(totalH * esc);
          var cx = cv.getContext("2d");
          cx.fillStyle = "#fff";
          cx.fillRect(0, 0, cv.width, cv.height);
          cx.drawImage(img, 0, 0, cv.width, cv.height);
          listo({ img: cv.toDataURL("image/png"), prop: totalH / totalW });
        } catch (e) { listo(null); }
      };
      img.onerror = function () { listo(null); };
      img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
    });
  }

  window.DanoMapa = {
    TIPOS: TIPOS,
    VISTAS: VISTAS,
    montar: montar,
    imagen: imagen,
    resumen: resumen
  };
})();
