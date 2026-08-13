/* ============================================================
   Orden de mantención en PDF (Cotizador).

   Reemplaza al botón "Imprimir orden", que abría el diálogo del navegador y
   dejaba el resultado a merced de la impresora configurada: márgenes distintos
   en cada equipo, el menú de la página impreso arriba y, cuando el asesor
   elegía "Guardar como PDF", un archivo llamado "cotizador.pdf" que no decía
   de qué auto era. Acá el documento se arma completo y siempre sale igual.

   Es lo que el cliente se lleva en la mano o recibe por correo, así que dice
   quién es el cliente, qué auto es, qué incluye la mantención, qué quedó
   FUERA si pidió solo una parte, y el total desglosado con IVA.

   Mismo formato y misma paleta que el acta de recepción (js/acta-pdf.js): los
   dos documentos los recibe la misma persona con días de diferencia.

   Sin folio a propósito: nada de esto se guarda todavía en la base, y un
   número inventado acá terminaría con un cliente llamando por la "cotización
   4471" que nadie puede buscar.

   Usa jsPDF (js/vendor/jspdf.umd.min.js).
   ============================================================ */
(function () {
  "use strict";

  var A4 = { ancho: 210, alto: 297 };
  var M = 14;                      // margen
  var COL = A4.ancho - M * 2;      // ancho útil

  var AZUL  = [13, 47, 90];
  var GRIS  = [110, 125, 145];
  var LINEA = [205, 214, 226];
  var TINTA = [22, 50, 79];
  var ROJO  = [168, 32, 42];
  var VERDE = [10, 125, 67];

  function hay() {
    return !!(window.jspdf && window.jspdf.jsPDF);
  }

  var CLP = new Intl.NumberFormat("es-CL", {
    style: "currency", currency: "CLP", maximumFractionDigits: 0
  });
  function money(n) {
    return n == null ? "—" : CLP.format(Math.round(n));
  }

  /* ---------- utilidades de dibujo (mismas del acta) ---------- */
  function titulo(doc, y, txt) {
    doc.setFillColor(238, 243, 251);
    doc.rect(M, y, COL, 7, "F");
    doc.setTextColor.apply(doc, AZUL);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.text(txt.toUpperCase(), M + 2.5, y + 4.8);
    return y + 10;
  }

  /* Pares etiqueta/valor en dos columnas. Los valores largos se parten en
     varias líneas y la fila crece: un nombre de cliente a medias en un
     documento que el cliente recibe no sirve. */
  function datos(doc, y, pares) {
    var mitad = COL / 2;
    var sangria = 32;
    var anchoVal = mitad - sangria - 3;
    var alto = 4.6;
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

  function sitio(doc, y, alto) {
    if (y + alto <= A4.alto - 20) return y;
    doc.addPage();
    return 20;
  }

  function fechaHoy() {
    return new Intl.DateTimeFormat("es-CL", {
      timeZone: "America/Santiago", day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date()).replace(",", "");
  }

  /* ---------- tabla del desglose ----------
     4 columnas: detalle, código, cantidad y valor. El detalle se parte en
     varias líneas si hace falta y la fila crece con él; los repuestos traen
     nombres largos ("Filtro de aire de habitáculo con carbón activado") y
     recortarlos deja al cliente sin saber qué está pagando. */
  var C_DET = 96, C_COD = 40, C_CANT = 16, C_VAL = COL - C_DET - C_COD - C_CANT;
  var X_DET = M, X_COD = M + C_DET, X_CANT = X_COD + C_COD, X_VAL = A4.ancho - M;

  function cabeceraTabla(doc, y) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(7.5);
    doc.setTextColor.apply(doc, GRIS);
    doc.text("DETALLE", X_DET, y);
    doc.text("CÓDIGO", X_COD, y);
    doc.text("CANT.", X_CANT, y);
    doc.text("VALOR NETO", X_VAL, y, { align: "right" });
    y += 1.8;
    doc.setDrawColor.apply(doc, LINEA);
    doc.setLineWidth(0.3);
    doc.line(M, y, A4.ancho - M, y);
    return y + 4;
  }

  /* Salto de página DENTRO de la tabla: además de la hoja nueva hay que
     repetir la cabecera. Sin eso la segunda página muestra una columna de
     números sin decir qué son. */
  function sitioTabla(doc, y, alto) {
    if (y + alto <= A4.alto - 20) return y;
    doc.addPage();
    return cabeceraTabla(doc, 20);
  }

  function filaItem(doc, y, it, atenuado) {
    doc.setFontSize(8.5);
    doc.setFont("helvetica", "normal");
    var lineas = doc.splitTextToSize(String(it.nombre || ""), C_DET - 3);
    /* El código de bodega solo cuando NO es el de la pauta: si son el mismo,
       repetirlo hace pensar que son dos repuestos distintos. */
    var altoFila = lineas.length * 4.2 + 2 + (it.codBodega ? 4 : 0);
    y = sitioTabla(doc, y, altoFila);

    doc.setTextColor.apply(doc, atenuado ? GRIS : TINTA);
    doc.text(lineas, X_DET, y);

    doc.setFontSize(7.8);
    doc.setTextColor.apply(doc, GRIS);
    if (it.codigo) doc.text(String(it.codigo), X_COD, y);
    if (it.cantidad) doc.text(String(it.cantidad), X_CANT, y);

    doc.setFontSize(8.5);
    doc.setFont("helvetica", atenuado ? "normal" : "bold");
    doc.setTextColor.apply(doc, atenuado ? GRIS : TINTA);
    doc.text(atenuado ? "no incluido" : money(it.subtotal), X_VAL, y, { align: "right" });

    if (it.codBodega) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(7);
      doc.setTextColor.apply(doc, GRIS);
      doc.text("en bodega: " + it.codBodega, X_COD, y + 4);
    }
    return y + altoFila;
  }

  function subtitulo(doc, y, txt) {
    y = sitioTabla(doc, y, 12);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, AZUL);
    doc.text(String(txt).toUpperCase(), M, y);
    return y + 4.6;
  }

  function filaTotal(doc, y, etiqueta, valor, fuerte) {
    doc.setFont("helvetica", fuerte ? "bold" : "normal");
    doc.setFontSize(fuerte ? 10 : 8.8);
    doc.setTextColor.apply(doc, fuerte ? AZUL : GRIS);
    doc.text(String(etiqueta), X_VAL - 42, y, { align: "right" });
    doc.setTextColor.apply(doc, fuerte ? AZUL : TINTA);
    doc.text(String(valor), X_VAL, y, { align: "right" });
    return y + (fuerte ? 6 : 5);
  }

  /* ---------- el documento ---------- */
  function generar(d) {
    if (!hay()) return null;
    d = d || {};
    var cli = d.cliente || {};
    var veh = d.vehiculo || {};
    var man = d.mantencion || {};
    var tot = d.totales || {};

    var doc = new window.jspdf.jsPDF({ unit: "mm", format: "a4" });
    var y = M;

    /* --- encabezado --- */
    if (d.logo) {
      try { doc.addImage(d.logo, "PNG", M, y - 1, 30, 6.7); } catch (e) { /* sigue sin logo */ }
    }
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor.apply(doc, AZUL);
    doc.text("Orden de Mantención", A4.ancho - M, y + 4, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor.apply(doc, GRIS);
    doc.text("Curifor S.A · Servicio y Postventa", A4.ancho - M, y + 9, { align: "right" });
    y += 13;

    doc.setDrawColor.apply(doc, AZUL);
    doc.setLineWidth(0.6);
    doc.line(M, y, A4.ancho - M, y);
    y += 6;

    /* --- fecha y quién cotiza --- */
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor.apply(doc, TINTA);
    doc.text("Fecha: " + fechaHoy(), M, y);
    var ase = d.asesor || {};
    if (ase.nombre || ase.email) {
      doc.setFont("helvetica", "normal");
      doc.setTextColor.apply(doc, GRIS);
      doc.text("Atiende: " + (ase.nombre || ase.email), A4.ancho - M, y, { align: "right" });
    }
    y += 6;

    /* Una cotización en modo interno lleva costos de la empresa, no precio de
       lista. Si sale impresa sin avisar y llega a manos de un cliente, queda
       un precio que Curifor no puede sostener. */
    if (man.modo === "interno") {
      doc.setFillColor(253, 240, 240);
      doc.rect(M, y - 3.4, COL, 7, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor.apply(doc, ROJO);
      doc.text("USO INTERNO · valores a costo, no corresponden al precio de lista al cliente", M + 2.5, y + 1.4);
      y += 8;
    }

    /* --- cliente --- */
    y = titulo(doc, y, "Datos del cliente");
    y = datos(doc, y, [
      ["Cliente", cli.nombre], ["RUT", cli.rut],
      ["Teléfono", cli.fono], ["E-mail", cli.email]
    ]);
    y = separador(doc, y);

    /* --- vehículo --- */
    y = titulo(doc, y, "Datos del vehículo");
    var filasVeh = [
      ["Patente", veh.patente],
      ["Marca / Modelo", [veh.marca, veh.modelo].filter(Boolean).join(" ")],
      ["Versión", veh.version],
      ["Año", veh.anio]
    ];
    if (veh.motor) filasVeh.push(["Motor", veh.motor]);
    if (veh.vin) filasVeh.push(["VIN", veh.vin]);
    if (veh.km != null) filasVeh.push(["Kilometraje", Number(veh.km).toLocaleString("es-CL") + " km"]);
    y = datos(doc, y, filasVeh);
    y = separador(doc, y);

    /* --- qué mantención es --- */
    y = titulo(doc, y, "Mantención");
    var etiquetaMant = "Revisión " + man.n +
      (man.etiqueta ? " — " + man.etiqueta : "") +
      (man.meses ? " · cada " + man.meses + " meses" : "");
    y = datos(doc, y, [
      ["Servicio", etiquetaMant],
      ["Tipo", man.modo === "interno" ? "Interno (costo)" : "Cliente particular"]
    ]);
    y = separador(doc, y);

    /* --- desglose --- */
    y = sitio(doc, y, 30);
    y = titulo(doc, y, "Repuestos, lubricantes y mano de obra");
    y = cabeceraTabla(doc, y);

    var hubo = false;
    (d.grupos || []).forEach(function (g) {
      var dentro = (g.items || []).filter(function (it) { return it.incluido !== false; });
      if (!dentro.length) return;
      hubo = true;
      y = subtitulo(doc, y, g.titulo);
      dentro.forEach(function (it) { y = filaItem(doc, y, it, false); });
      y += 1;
    });
    var mo = d.manoObra;
    if (mo && mo.incluido !== false && mo.valor) {
      hubo = true;
      y = subtitulo(doc, y, "Mano de obra");
      y = filaItem(doc, y, {
        nombre: "Mano de obra" + (mo.horas ? " (" + mo.horas + " h)" : ""),
        subtotal: mo.valor
      }, false);
      y += 1;
    }
    if (!hubo) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8.5);
      doc.setTextColor.apply(doc, GRIS);
      doc.text("El valor corresponde al precio total sugerido de la mantención.", M, y);
      y += 6;
    }

    /* --- totales --- */
    y = sitio(doc, y, 26);
    doc.setDrawColor.apply(doc, LINEA);
    doc.setLineWidth(0.3);
    doc.line(X_VAL - 62, y - 1, X_VAL, y - 1);
    y += 3.5;
    if (man.gratis) {
      y = filaTotal(doc, y, "Total", "Sin costo", true);
    } else {
      y = filaTotal(doc, y, "Neto", money(tot.neto), false);
      y = filaTotal(doc, y, "IVA 19%", money(tot.iva), false);
      y = filaTotal(doc, y, "TOTAL", money(tot.total), true);
    }

    /* --- lo que el cliente NO quiso ---
       Va escrito y no omitido: es exactamente lo que evita la discusión de la
       entrega ("yo pensé que incluía el filtro"). Y le sirve al cliente para
       saber qué le quedó pendiente. */
    var fuera = [];
    (d.grupos || []).forEach(function (g) {
      (g.items || []).forEach(function (it) { if (it.incluido === false) fuera.push(it); });
    });
    if (mo && mo.incluido === false && mo.valor) {
      fuera.push({ nombre: "Mano de obra" + (mo.horas ? " (" + mo.horas + " h)" : "") });
    }
    if (fuera.length) {
      y = sitio(doc, y, 30);
      y += 4;
      y = titulo(doc, y, "No incluido en esta cotización");
      doc.setFont("helvetica", "italic");
      doc.setFontSize(8);
      doc.setTextColor.apply(doc, GRIS);
      doc.text("A solicitud del cliente. No se cobra y no se prepara en bodega.", M, y);
      y += 5.5;
      fuera.forEach(function (it) { y = filaItem(doc, y, it, true); });
      y += 2;
    }

    /* --- adicionales --- */
    var adic = d.adicionales || [];
    if (adic.length) {
      y = sitio(doc, y, 30);
      y += 2;
      y = titulo(doc, y, "Servicios adicionales");
      adic.forEach(function (a) {
        y = filaItem(doc, y, { nombre: a.nombre, subtotal: a.precio }, false);
      });
      y += 1;
      doc.setDrawColor.apply(doc, LINEA);
      doc.line(X_VAL - 62, y - 1, X_VAL, y - 1);
      y += 3.5;
      y = filaTotal(doc, y, "Neto con adicionales", money(d.totalAdic && d.totalAdic.neto), false);
      y = filaTotal(doc, y, "TOTAL CON ADICIONALES", money(d.totalAdic && d.totalAdic.total), true);
    }

    /* --- operaciones incluidas --- */
    var ops = d.operaciones || [];
    if (ops.length) {
      y = sitio(doc, y, 30);
      y += 2;
      y = titulo(doc, y, "Operaciones incluidas");
      doc.setFontSize(8.2);
      var porFila = 2, anchoOp = COL / porFila - 4;
      var yInicio = y, maxY = y;
      ops.forEach(function (o, i) {
        var col = i % porFila;
        if (col === 0 && i > 0) y = maxY;
        var x = M + col * (COL / porFila);
        var txt = (o.accion === "R" ? "Reemplazar: " : "Inspeccionar: ") + o.nombre;
        var ls = doc.splitTextToSize(txt, anchoOp);
        if (col === 0) {
          var alto = ls.length * 4;
          if (y + alto > A4.alto - 24) { doc.addPage(); y = maxY = yInicio = 20; }
        }
        doc.setFont("helvetica", "normal");
        doc.setTextColor.apply(doc, o.accion === "R" ? TINTA : GRIS);
        doc.text(ls, x, y);
        maxY = Math.max(maxY, y + ls.length * 4);
      });
      y = maxY + 2;
      y = separador(doc, y);
    }

    /* --- consideraciones --- */
    var notas = d.notas || [];
    if (notas.length) {
      y = sitio(doc, y, 24);
      y = titulo(doc, y, "Consideraciones");
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8.2);
      doc.setTextColor.apply(doc, TINTA);
      notas.forEach(function (n) {
        var ls = doc.splitTextToSize("• " + n, COL);
        y = sitio(doc, y, ls.length * 4 + 2);
        doc.text(ls, M, y);
        y += ls.length * 4 + 1.4;
      });
      y += 1;
    }

    /* --- validez ---
       Los precios salen de la lista de la empresa y del inventario, que se
       actualizan solos. Sin una fecha de corte el cliente vuelve en marzo con
       la hoja de agosto y reclama el valor de entonces. */
    y = sitio(doc, y, 18);
    y = separador(doc, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.6);
    doc.setTextColor.apply(doc, GRIS);
    var pie = "Valores referenciales sugeridos, en pesos chilenos y con IVA incluido en el total. " +
              "Sujetos a confirmación de precio y disponibilidad al momento de la orden de trabajo.";
    if (d.stockActualizado) pie += " Disponibilidad de repuestos al " + d.stockActualizado + ".";
    if (d.fuente) pie += " " + d.fuente + ".";
    var lp = doc.splitTextToSize(pie, COL);
    doc.text(lp, M, y);

    /* --- pie de página --- */
    var paginas = doc.getNumberOfPages();
    for (var p = 1; p <= paginas; p++) {
      doc.setPage(p);
      doc.setDrawColor.apply(doc, LINEA);
      doc.setLineWidth(0.2);
      doc.line(M, A4.alto - 12, A4.ancho - M, A4.alto - 12);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(6.8);
      doc.setTextColor.apply(doc, GRIS);
      doc.text("Curifor S.A · Cotizador de Mantenciones · " + fechaHoy(), M, A4.alto - 8);
      doc.text("Página " + p + " de " + paginas, A4.ancho - M, A4.alto - 8, { align: "right" });
    }

    return doc;
  }

  /* El nombre lleva patente y kilometraje: el asesor termina con diez de estos
     en la carpeta de descargas y "cotizador.pdf" no le sirve a nadie. */
  function nombreArchivo(d) {
    d = d || {};
    var veh = d.vehiculo || {};
    var man = d.mantencion || {};
    var quien = veh.patente ||
                [veh.marca, veh.modelo].filter(Boolean).join("_") ||
                "vehiculo";
    var rev = man.km ? Math.round(man.km / 1000) + "k" : "rev" + (man.n != null ? man.n : "");
    return ("Mantencion_" + quien + "_" + rev).replace(/[^A-Za-z0-9_]+/g, "_") + ".pdf";
  }

  window.OrdenPDF = {
    disponible: hay,
    generar: generar,
    nombreArchivo: nombreArchivo
  };
})();
