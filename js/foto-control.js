/* ============================================================
   Control de las fotos de la inspección.

   El problema real: fotos que no sirven como respaldo. En un mesón, con el
   cliente esperando, lo que pasa es siempre lo mismo — la misma foto subida
   varias veces, la foto del piso, del techo, o el dedo tapando el lente.

   Esto se revisa AQUÍ, en el navegador, y no con un servicio externo:
     · Es instantáneo. Nadie espera una respuesta de red con el cliente al lado.
     · Funciona con la señal del taller caída.
     · No cuesta por foto.
     · Y sobre todo: sirve para RECHAZAR antes de subir, no para descubrir
       después que la foto no servía.

   Lo que esto NO puede saber es si la foto es de OTRO auto. Para eso hace
   falta un modelo que entienda la imagen; se puede sumar después sin tocar
   nada de acá (ver `revisarConIA` al final).
   ============================================================ */
(function () {
  "use strict";

  /* Umbrales. Están calibrados para rechazar solo lo evidente: un taller mal
     iluminado, un auto negro o una foto contra el sol NO pueden quedar fuera.
     Ante la duda, pasa: un falso rechazo obliga al asesor a pelear con el
     sistema delante del cliente, y eso termina en que dejen de sacar fotos. */
  var MIN_LADO      = 480;   // píxeles del lado menor
  var MIN_VARIACION = 12;    // desviación del brillo: bajo esto es una superficie plana
  var MIN_DETALLE   = 55;    // varianza del enfoque: bajo esto está desenfocada
  var DIST_IGUAL    = 6;     // huellas a menos de esta distancia = la misma foto

  /* ---------- lectura de la imagen ---------- */
  function cargar(url) {
    return new Promise(function (listo, falla) {
      var img = new Image();
      if (/^https?:/i.test(url)) img.crossOrigin = "anonymous";
      img.onload = function () { listo(img); };
      img.onerror = function () { falla(new Error("no se pudo leer la imagen")); };
      img.src = url;
    });
  }

  function aGris(img, lado) {
    var cv = document.createElement("canvas");
    cv.width = lado; cv.height = lado;
    var ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, lado, lado);
    var d = ctx.getImageData(0, 0, lado, lado).data;
    var g = new Float32Array(lado * lado);
    for (var i = 0, p = 0; i < d.length; i += 4, p++) {
      // luminancia percibida: el verde pesa más que el rojo y el azul
      g[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    return g;
  }

  /* ---------- huella para detectar repetidas ----------
     Promedio de 8x8: dos fotos de la misma escena dan huellas casi iguales
     aunque cambien de tamaño, de compresión o de brillo. Es justo lo que se
     necesita para pillar la misma foto subida en varios recuadros. */
  function huella(img) {
    var g = aGris(img, 8);
    var suma = 0;
    for (var i = 0; i < g.length; i++) suma += g[i];
    var media = suma / g.length;
    var bits = "";
    for (var j = 0; j < g.length; j++) bits += (g[j] > media ? "1" : "0");
    return bits;
  }

  function distancia(a, b) {
    if (!a || !b || a.length !== b.length) return 99;
    var d = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return d;
  }

  /* ---------- ¿tiene contenido? ----------
     Una pared, el piso o el lente tapado dan una imagen casi plana: todos los
     píxeles con el mismo brillo. */
  function variacion(g) {
    var suma = 0, i;
    for (i = 0; i < g.length; i++) suma += g[i];
    var media = suma / g.length, acc = 0;
    for (i = 0; i < g.length; i++) acc += (g[i] - media) * (g[i] - media);
    return Math.sqrt(acc / g.length);
  }

  /* ---------- ¿está enfocada? ----------
     Se mide cuánto cambia el brillo entre píxeles vecinos. Una foto nítida
     tiene bordes marcados; una movida o desenfocada, casi ninguno. */
  function detalle(g, lado) {
    var acc = 0, n = 0;
    for (var y = 1; y < lado - 1; y++) {
      for (var x = 1; x < lado - 1; x++) {
        var i = y * lado + x;
        var lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - lado] - g[i + lado];
        acc += lap * lap; n++;
      }
    }
    return n ? acc / n : 0;
  }

  /* ---------- revisión ----------
     `otras` son las huellas de las demás fotos de ESTA recepción, para pillar
     la repetida. Devuelve {ok, motivo, huella}. */
  function revisar(url, otras) {
    return cargar(url).then(function (img) {
      var w = img.naturalWidth || 0, h = img.naturalHeight || 0;
      if (Math.min(w, h) < MIN_LADO) {
        return { ok: false, motivo: "La imagen es muy chica (" + w + "×" + h +
                 "). Sácala con la cámara en vez de reenviarla o recortarla." };
      }

      var hu = huella(img);
      var repetida = (otras || []).find(function (o) {
        return o && o.huella && distancia(hu, o.huella) <= DIST_IGUAL;
      });
      if (repetida) {
        return { ok: false, huella: hu,
                 motivo: "Esta foto es la misma que subiste en “" + repetida.vista +
                         "”. Cada recuadro necesita su propia foto." };
      }

      var g = aGris(img, 96);
      var v = variacion(g);
      if (v < MIN_VARIACION) {
        return { ok: false, huella: hu,
                 motivo: "La foto salió casi toda de un color. Puede ser el piso, " +
                         "una pared o el dedo sobre el lente." };
      }

      var d = detalle(g, 96);
      if (d < MIN_DETALLE) {
        return { ok: false, huella: hu,
                 motivo: "La foto está movida o desenfocada. Apóyate un momento y repítela." };
      }

      return { ok: true, huella: hu, medidas: { w: w, h: h, variacion: Math.round(v), detalle: Math.round(d) } };
    }).catch(function (e) {
      // Si no se pudo ni abrir, que decida quien llama: negarse a subir por un
      // fallo del propio control sería peor que subir la foto.
      return { ok: true, huella: null, aviso: (e && e.message) || "no se pudo revisar" };
    });
  }

  /* ---------- revisión con IA (opcional, todavía no conectada) ----------
     Queda el enganche listo: si algún día se configura un modelo de visión,
     esto le pasa la foto y la vista esperada ("Frente Izq") y responde si
     corresponde. Mientras no haya configuración, dice que sí y no estorba.

     Va DESPUÉS de las revisiones de acá a propósito: no tiene sentido gastar
     una llamada pagada en una foto que ya sabemos que está movida o repetida. */
  function revisarConIA(blob, vista) {
    var cfg = (window.CURIFOR_AGENDA || {}).visionIA;
    if (!cfg || !cfg.url) return Promise.resolve({ ok: true, omitido: true });
    return Promise.resolve({ ok: true, omitido: true });   // pendiente de configurar
  }

  window.FotoControl = {
    revisar: revisar,
    revisarConIA: revisarConIA,
    huella: huella,
    distancia: distancia,
    umbrales: { MIN_LADO: MIN_LADO, MIN_VARIACION: MIN_VARIACION,
                MIN_DETALLE: MIN_DETALLE, DIST_IGUAL: DIST_IGUAL }
  };
})();
