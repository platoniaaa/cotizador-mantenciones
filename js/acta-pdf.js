/* ============================================================
   Acta de recepción en PDF.

   Se genera al pulsar "Ingresar a Taller", con lo que quedó en pantalla. Es el
   respaldo del taller frente a un reclamo: qué kilometraje traía el auto, con
   cuánto combustible, qué accesorios venían, qué daños se declararon y las dos
   firmas.

   Por qué se arma acá y no en un servidor: las firmas y las fotos ya están en
   el navegador en ese instante. Pedirlas de vuelta al almacenamiento obligaría
   a generar enlaces firmados y a esperar la red, justo cuando el asesor tiene
   al cliente al frente esperando.

   Usa jsPDF (js/vendor/jspdf.umd.min.js). Si no cargara, la recepción se
   guarda igual: el PDF es un extra, nunca un requisito para recibir el auto.
   ============================================================ */
(function () {
  "use strict";

  var A4 = { ancho: 210, alto: 297 };
  var M = 14;                      // margen
  var COL = A4.ancho - M * 2;      // ancho útil

  var AZUL = [13, 47, 90];
  var GRIS = [110, 125, 145];
  var LINEA = [205, 214, 226];
  var TINTA = [22, 50, 79];
  var ROJO = [168, 32, 42];

  function hay() {
    return !!(window.jspdf && window.jspdf.jsPDF);
  }

  /* ---------- utilidades de dibujo ---------- */
  function titulo(doc, y, txt) {
    doc.setFillColor.apply(doc, [238, 243, 251]);
    doc.rect(M, y, COL, 7, "F");
    doc.setTextColor.apply(doc, AZUL);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(txt.toUpperCase(), M + 2.5, y + 4.8);
    return y + 10;
  }

  /* Pares etiqueta/valor en dos columnas. Devuelve la Y de abajo.

     Los valores que no caben se parten en varias líneas y la fila crece. La
     primera versión dibujaba solo la primera línea y descartaba el resto sin
     avisar: "REALE CHILE SEGUROS GENERALES S.A." salía como "REALE CHILE
     SEGUROS GENERALES". En un acta que respalda al taller, un nombre de
     cliente a medias no sirve. */
  function datos(doc, y, pares) {
    var mitad = COL / 2;
    var sangria = 32;
    var anchoVal = mitad - sangria - 3;
    var alto = 4.6;                 // separación entre líneas
    doc.setFontSize(8.5);

    for (var i = 0; i < pares.length; i += 2) {
      var fila = [pares[i], pares[i + 1]].filter(Boolean);
      var lineas = fila.map(function (p) {
        var txt = String(p[1] == null || p[1] === "" ? "—" : p[1]);
        doc.setFont("helvetica", "bold");
        return doc.splitTextToSize(txt, anchoVal);
      });
      var altoFila = Math.max.apply(null, lineas.map(function (l) { return l.length; })) * alto + 1.6;

      fila.forEach(function (p, col) {
        var x = M + col * mitad;
        doc.setFont("helvetica", "normal");
        doc.setTextColor.apply(doc, GRIS);
        doc.text(String(p[0]), x, y);
        doc.setFont("helvetica", "bold");
        doc.setTextColor.apply(doc, p[2] ? ROJO : TINTA);
        doc.text(lineas[col], x + sangria, y);
      });
      y += altoFila;
    }
    return y + 1;
  }

  function separador(doc, y) {
    doc.setDrawColor.apply(doc, LINEA);
    doc.setLineWidth(0.2);
    doc.line(M, y, A4.ancho - M, y);
    return y + 4;
  }

  /* Salto de página cuando lo que viene no cabe. Sin esto el contenido se
     dibuja fuera de la hoja y simplemente no se ve. */
  function sitio(doc, y, alto) {
    if (y + alto <= A4.alto - 18) return y;
    doc.addPage();
    return 20;
  }

  function fmtFecha(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return new Intl.DateTimeFormat("es-CL", {
      timeZone: "America/Santiago", day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(d).replace(",", "");
  }

  /* ---------- el acta ---------- */
  function generar(a, ro, opciones) {
    opciones = opciones || {};
    if (!hay()) return null;

    var doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    var y = M;

    /* --- encabezado --- */
    var logo = opciones.logo || null;
    if (logo) {
      try { doc.addImage(logo, "PNG", M, y - 1, 30, 6.7); } catch (e) { /* sigue sin logo */ }
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor.apply(doc, AZUL);
    doc.text("Acta de Recepción de Vehículo", A4.ancho - M, y + 4, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, GRIS);
    doc.text((a.sucursal || "Curifor S.A"), A4.ancho - M, y + 9, { align: "right" });
    y += 13;

    doc.setDrawColor.apply(doc, AZUL);
    doc.setLineWidth(0.6);
    doc.line(M, y, A4.ancho - M, y);
    y += 6;

    /* --- identificación --- */
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor.apply(doc, TINTA);
    doc.text("N° de agendamiento: " + (a.oc != null ? a.oc : "—") +
             "     Orden de trabajo: RO " + (ro || "—"), M, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor.apply(doc, GRIS);
    doc.text("Recibido: " + fmtFecha(a.recibidoEn) , A4.ancho - M, y, { align: "right" });
    y += 6;

    /* --- quién atendió ---
       Va ARRIBA, junto al cliente y no perdido al pie: cuando alguien reclama
       tres semanas después, la primera pregunta es siempre quién recibió el
       auto. Se distingue el asesor ASIGNADO a la cita de quien realmente hizo
       la recepción, porque no siempre son la misma persona (turnos, colación,
       el que estaba libre en el mesón). */
    var ase = opciones.asesor || {};
    var filasAse = [
      ["Asesor", ase.nombre || a.asesor],
      ["Correo", ase.email]
    ];
    if (ase.rol) filasAse.push(["Cargo", ase.rol]);
    if (ase.sucursal || a.sucursal) filasAse.push(["Sucursal", ase.sucursal || a.sucursal]);
    var recibio = opciones.recibio || {};
    var mismoQueRecibe = !recibio.email || !ase.email ||
                         recibio.email.toLowerCase() === ase.email.toLowerCase();
    if (!mismoQueRecibe) {
      filasAse.push(["Recibió el vehículo", recibio.nombre || a.recibidoPor]);
      filasAse.push(["Correo de quien recibió", recibio.email]);
    }
    y = titulo(doc, y, "Atendido por");
    y = datos(doc, y, filasAse);
    y = separador(doc, y);

    /* --- cliente --- */
    y = titulo(doc, y, "Datos del cliente");
    y = datos(doc, y, [
      ["Cliente", a.cli], ["RUT", a.rut],
      ["Teléfono", a.fono], ["E-mail", a.email]
    ]);
    y = separador(doc, y);

    /* --- vehículo. El km real va marcado si falta: es el dato que define qué
           mantención corresponde y el que más se reclama después. --- */
    y = titulo(doc, y, "Datos del vehículo");
    y = datos(doc, y, [
      ["Patente", a.pat],
      ["Marca / Modelo", [a.marcaNombre, a.modeloNombre].filter(Boolean).join(" ")],
      ["Año", a.anio], ["VIN", a.vin],
      ["Km de la cita", a.km != null ? Number(a.km).toLocaleString("es-CL") + " km" : "—"],
      ["Km real", a.kmReal != null ? Number(a.kmReal).toLocaleString("es-CL") + " km" : "SIN REGISTRAR",
       a.kmReal == null],
      ["Servicio", a.serv],
      ["Combustible", a.comb ? a.comb : "SIN REGISTRAR", !a.comb]
    ]);
    y = separador(doc, y);

    /* --- accesorios: se listan TODOS, marcando presentes y ausentes. Un acta
           que solo nombra lo que venía no sirve para discutir lo que faltaba. --- */
    y = sitio(doc, y, 34);
    y = titulo(doc, y, "Accesorios");
    var acc = a.acc || {};
    var lista = (window.AGACC || []);
    var porFila = 4, anchoCel = COL / porFila;
    doc.setFontSize(8);
    lista.forEach(function (nombre, i) {
      var col = i % porFila, fila = Math.floor(i / porFila);
      var x = M + col * anchoCel, yy = y + fila * 5.4;
      var marcado = !!acc[nombre];
      doc.setDrawColor.apply(doc, marcado ? AZUL : LINEA);
      doc.setLineWidth(0.3);
      doc.rect(x, yy - 2.6, 3, 3);
      if (marcado) {
        doc.setFillColor.apply(doc, AZUL);
        doc.rect(x + 0.6, yy - 2, 1.8, 1.8, "F");
      }
      doc.setFont("helvetica", marcado ? "bold" : "normal");
      doc.setTextColor.apply(doc, marcado ? TINTA : GRIS);
      doc.text(String(nombre), x + 4.6, yy);
    });
    y += Math.ceil(lista.length / porFila) * 5.4 + 2;
    var nMarcados = Object.keys(acc).filter(function (k) { return acc[k]; }).length;
    doc.setFont("helvetica", "italic");
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, GRIS);
    doc.text(nMarcados + " de " + lista.length + " accesorios presentes al ingreso.", M, y);
    y = separador(doc, y + 3);

    /* --- comentario del agendamiento ---
       Separado de las observaciones a propósito: esto se anotó ANTES de que el
       auto llegara (o lo escribió el cliente al reservar), mientras que las
       observaciones son los daños constatados con el vehículo delante. */
    var coment = String(a.coment || "").trim();
    if (coment) {
      y = sitio(doc, y, 22);
      y = titulo(doc, y, "Comentario del agendamiento");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor.apply(doc, TINTA);
      var lc = doc.splitTextToSize(coment, COL);
      doc.text(lc, M, y);
      y = separador(doc, y + lc.length * 4.4 + 2);
    }

    /* --- observaciones --- */
    y = sitio(doc, y, 26);
    y = titulo(doc, y, "Observaciones · daños previos y faltantes declarados");
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, TINTA);
    var obs = String(a.obs || "").trim();
    if (obs) {
      var lineas = doc.splitTextToSize(obs, COL);
      doc.text(lineas, M, y);
      y += lineas.length * 4.4 + 2;
    } else {
      doc.setFont("helvetica", "italic");
      doc.setTextColor.apply(doc, GRIS);
      doc.text("Sin observaciones. El vehículo se recibe sin daños ni faltantes declarados.", M, y);
      y += 6;
    }
    y = separador(doc, y + 1);

    /* --- mapa de daños ---
       Va JUNTO a las observaciones y antes de las fotos: es la versión
       inequívoca de lo mismo que el texto describe. Una foto muestra el rayón
       pero no dice de qué lado del auto es; el diagrama sí. */
    var dn = opciones.danos;
    if (dn && dn.img) {
      var altoMapa = COL * (dn.prop || 0.12);
      y = sitio(doc, y, altoMapa + 14 + (dn.lista || []).length * 4);
      y = titulo(doc, y, "Mapa de daños");
      try { doc.addImage(dn.img, "PNG", M, y, COL, altoMapa); }
      catch (e) {
        doc.setDrawColor.apply(doc, LINEA);
        doc.rect(M, y, COL, altoMapa);
      }
      y += altoMapa + 3;
      // La leyenda no es decorativa: sin ella un punto en el dibujo no dice si
      // es un rayón o una abolladura, y el acta deja de servir como respaldo.
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor.apply(doc, TINTA);
      (dn.lista || []).forEach(function (t) {
        y = sitio(doc, y, 6);
        doc.text(String(t), M + 2, y);
        y += 4.2;
      });
      y = separador(doc, y + 1);
    }

    /* --- fotos: las que alcanzaron a quedar en pantalla. Van reducidas; el
           original queda en el almacenamiento, esto es la referencia visual. --- */
    var fotos = (opciones.fotos || []).filter(function (f) { return f && f.img; });
    if (fotos.length) {
      y = sitio(doc, y, 42);
      y = titulo(doc, y, "Inspección fotográfica");
      var porFilaF = 4, anchoF = (COL - 3 * 3) / porFilaF, altoF = anchoF * 0.72;
      fotos.forEach(function (f, i) {
        var col = i % porFilaF, fila = Math.floor(i / porFilaF);
        if (col === 0 && fila > 0) y = sitio(doc, y, altoF + 8);
        var x = M + col * (anchoF + 3);
        var yy = y + fila * (altoF + 8);
        try { doc.addImage(f.img, "JPEG", x, yy, anchoF, altoF); }
        catch (e) {
          doc.setDrawColor.apply(doc, LINEA);
          doc.rect(x, yy, anchoF, altoF);
        }
        doc.setFont("helvetica", "normal");
        doc.setFontSize(7);
        doc.setTextColor.apply(doc, GRIS);
        doc.text(String(f.t || ""), x, yy + altoF + 3.4);
      });
      y += Math.ceil(fotos.length / porFilaF) * (altoF + 8) + 1;
      y = separador(doc, y);
    }

    /* --- condiciones generales y datos personales ---
       Van ANTES de las firmas y no al final del documento: lo que se firma es
       esto, y un anexo que aparece después de la firma no lo leyó nadie.

       Cuerpo chico (6.6 pt) porque son ~2.400 caracteres y el acta ya trae
       fotos y el mapa de daños; a tamaño normal se llevaría una hoja entera
       ella sola. Es el mismo tamaño que usa la orden de trabajo actual. */
    var cnd = window.ActaCondiciones;
    if (cnd) {
      y = sitio(doc, y, 40);
      y = titulo(doc, y, cnd.titulo);
      /* A DOS COLUMNAS. A ancho completo el bloque medía 133 mm y empujaba las
         firmas a una hoja aparte, donde quedaban solas y —lo que importa— en
         una página distinta del texto que el cliente está firmando. En dos
         columnas ocupa la mitad y la firma va inmediatamente debajo de las
         condiciones. */
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.6);
      var sangriaN = 4;
      var anchoCol = (COL - 8) / 2;
      var alturaLin = 2.9, separaClau = 1.6;

      var clau = cnd.generales.map(function (txt, i) {
        var ls = doc.splitTextToSize(txt, anchoCol - sangriaN);
        return { n: i + 1, ls: ls, alto: ls.length * alturaLin + separaClau };
      });
      // se reparten buscando dos columnas de alto parecido
      var altoTotal = clau.reduce(function (t, c) { return t + c.alto; }, 0);
      var corte = 0, acum = 0;
      while (corte < clau.length && acum + clau[corte].alto <= altoTotal / 2) {
        acum += clau[corte].alto; corte++;
      }
      var cols = [clau.slice(0, corte), clau.slice(corte)];
      var altoBloque = Math.max(
        cols[0].reduce(function (t, c) { return t + c.alto; }, 0),
        cols[1].reduce(function (t, c) { return t + c.alto; }, 0)
      );
      // el bloque entero cabe o se va completo a la hoja siguiente: partir las
      // condiciones a la mitad de una columna las vuelve ilegibles
      y = sitio(doc, y, altoBloque + 4);

      cols.forEach(function (col, ci) {
        var x = M + ci * (anchoCol + 8);
        var yy = y;
        col.forEach(function (c) {
          doc.setFont("helvetica", "bold");
          doc.setTextColor.apply(doc, TINTA);
          doc.text(String(c.n) + ".", x, yy);
          doc.setFont("helvetica", "normal");
          doc.text(c.ls, x + sangriaN, yy);
          yy += c.alto;
        });
      });
      y += altoBloque + 1;

      /* Datos personales: bloque aparte y no una cláusula más. Es materia
         distinta y es nueva; escondida como "cláusula 12" pasa inadvertida, y
         una autorización que nadie vio no sirve de autorización. */
      y = sitio(doc, y, 26);
      y += 2;
      y = titulo(doc, y, cnd.datosTitulo);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.6);
      doc.setTextColor.apply(doc, TINTA);
      cnd.datos.forEach(function (txt) {
        var ls = doc.splitTextToSize(txt, COL);
        y = sitio(doc, y, ls.length * 2.9 + 2);
        doc.text(ls, M, y);
        y += ls.length * 2.9 + 2;
      });

      /* Lo que el cliente decidió sobre publicidad, marcado y visible. Va en
         recuadro porque es lo único de todo este bloque que cambia de un
         cliente a otro, y lo que después hay que poder mostrar si alguien
         reclama que le llegó publicidad sin pedirla. */
      var acepta = !!a.marketing;
      y = sitio(doc, y, 16);
      y += 1.5;
      doc.setDrawColor.apply(doc, acepta ? AZUL : LINEA);
      doc.setLineWidth(0.4);
      var altoC = 12.5;
      doc.rect(M, y, COL, altoC);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7.4);
      doc.setTextColor.apply(doc, acepta ? AZUL : TINTA);
      doc.text(cnd.comercialEtiqueta + ": " + (acepta ? "SÍ" : "NO"), M + 3, y + 4.6);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.6);
      doc.setTextColor.apply(doc, TINTA);
      doc.text(doc.splitTextToSize(acepta ? cnd.comercialSi : cnd.comercialNo, COL - 6), M + 3, y + 8);
      doc.setTextColor.apply(doc, GRIS);
      doc.text(doc.splitTextToSize(cnd.comercialNota, COL - 6), M + 3, y + 11);
      y += altoC + 3;

      doc.setFont("helvetica", "italic");
      doc.setFontSize(6.4);
      doc.setTextColor.apply(doc, GRIS);
      doc.text("Condiciones generales versión " + cnd.version +
               ". Al firmar, el cliente declara haberlas leído y aceptado.", M, y);
      y = separador(doc, y + 2);
    }

    /* --- firmas --- */
    y = sitio(doc, y, 46);
    y = titulo(doc, y, "Firmas");
    var anchoFirma = (COL - 10) / 2, altoFirma = 24;
    // Bajo la firma va el NOMBRE de la persona, no su correo: el acta la lee
    // un cliente, y "mfigueroa@curifor.com" no le dice a quién le entregó el auto.
    var firmaAsesor = (opciones.recibio && opciones.recibio.nombre) ||
                      (opciones.asesor && opciones.asesor.nombre) ||
                      a.recibidoPor || a.asesor;
    [["cliente", "Firma del cliente", a.cli],
     ["asesor", "Firma del asesor", firmaAsesor]].forEach(function (par, i) {
      var x = M + i * (anchoFirma + 10);
      doc.setDrawColor.apply(doc, LINEA);
      doc.setLineWidth(0.3);
      doc.rect(x, y, anchoFirma, altoFirma);
      var img = (opciones.firmas || {})[par[0]];
      if (img) {
        try { doc.addImage(img, "PNG", x + 2, y + 2, anchoFirma - 4, altoFirma - 4); }
        catch (e) { /* si la firma no se puede dibujar, queda el recuadro */ }
      } else {
        doc.setFont("helvetica", "italic");
        doc.setFontSize(8);
        doc.setTextColor.apply(doc, ROJO);
        doc.text("sin firmar", x + anchoFirma / 2, y + altoFirma / 2, { align: "center" });
      }
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor.apply(doc, TINTA);
      doc.text(par[1], x, y + altoFirma + 4.5);
      doc.setFont("helvetica", "normal");
      doc.setTextColor.apply(doc, GRIS);
      doc.text(String(par[2] || "—"), x, y + altoFirma + 8.5);
    });
    y += altoFirma + 13;

    /* --- pie legal, en todas las páginas --- */
    var paginas = doc.getNumberOfPages();
    for (var p = 1; p <= paginas; p++) {
      doc.setPage(p);
      doc.setDrawColor.apply(doc, LINEA);
      doc.setLineWidth(0.2);
      doc.line(M, A4.alto - 14, A4.ancho - M, A4.alto - 14);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
      doc.setTextColor.apply(doc, GRIS);
      doc.text("El cliente declara que los datos, accesorios y observaciones registrados corresponden " +
               "al estado del vehículo al momento de la recepción.", M, A4.alto - 10);
      doc.text("Curifor S.A · " + (a.sucursal || "") + " · Documento generado el " +
               fmtFecha(new Date().toISOString()), M, A4.alto - 6.8);
      doc.text("Página " + p + " de " + paginas, A4.ancho - M, A4.alto - 6.8, { align: "right" });
    }

    return doc;
  }

  function nombreArchivo(a, ro) {
    var pat = String(a.pat || "sinpatente").replace(/[^A-Za-z0-9]/g, "");
    return "Acta_" + pat + "_RO" + (ro || "SN") + ".pdf";
  }

  window.ActaPDF = {
    disponible: hay,
    generar: generar,
    nombreArchivo: nombreArchivo
  };
})();
