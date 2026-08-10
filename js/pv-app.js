/* ============================================================
   Post Venta — los módulos.

   Cada módulo es una función que pinta dentro de #pvVista. Son los mismos
   módulos de la app de Streamlit, con los mismos datos y las mismas reglas;
   lo que cambia es que ahora corren en el navegador y hablan directo con
   Supabase, sin servidor de por medio.

   Mientras dure la migración las dos versiones conviven: escriben en los
   mismos documentos, así que lo que se guarde acá lo ve la app antigua y al
   revés.
   ============================================================ */
(function () {
  "use strict";

  var U = window.PVUI, D = window.PV;
  var vista = document.getElementById("pvVista");
  var MODS = {};
  var actual = null;

  /* Las 4 columnas que edita la gente. Son las únicas que la plataforma
     escribe sobre las OT: el resto lo fabrica el consolidador cada día y se
     pisaría solo. */
  var EDITABLES = ["CATEGORIA", "OBSERVACION OT", "NOTAS", "AVANCE - GESTIÓN"];

  var CATEGORIAS = ["", "COBRAR", "GARANTIA", "SINIESTRO", "INTERNA", "REVISAR", "CERRAR"];

  /* ============================================================
     Órdenes de trabajo
     ============================================================ */
  MODS.ots = function () {
    U.cargando(vista, "Cargando órdenes de trabajo…");
    Promise.all([D.leer("datos_dashboard.json"), D.leer("comentarios_log.json")])
      .then(function (r) {
        var doc = r[0].data || {};
        var ots = doc.ots || [];
        var coments = (r[1].data && r[1].data.comentarios) || [];

        /* Comentarios agrupados por folio: la ficha los muestra y la tabla
           marca cuáles tienen. Agrupar una vez evita recorrer 308 comentarios
           por cada una de las 2.069 filas. */
        var porFolio = {};
        coments.forEach(function (c) {
          var f = String(c.folio_ot || "").trim();
          (porFolio[f] = porFolio[f] || []).push(c);
        });

        pintarOTs(ots, doc, porFolio);
      })
      .catch(function (e) { U.error(vista, e); });
  };

  function pintarOTs(ots, doc, porFolio) {
    var sucursales = U.opciones(ots, "SUCURSAL");
    var asesores = U.opciones(ots, "ASESOR");
    var estados = U.opciones(ots, "ESTADO");
    var categorias = U.opciones(ots, "CATEGORIA");

    vista.innerHTML =
      cabecera("Órdenes de trabajo", "Actualizado " + U.esc(doc.fecha_actualizacion || "—"),
               '<button type="button" class="pv-btn" id="otXls">Exportar a Excel</button>') +
      '<div id="otKpis"></div>' +
      '<div class="pv-filtros">' +
        U.selector("fSuc", "Sucursal", sucursales) +
        U.selector("fAse", "Asesor", asesores, "Todos") +
        U.selector("fEst", "Estado", estados, "Todos") +
        U.selector("fCat", "Categoría", categorias) +
        U.buscador("fTxt", "folio, patente, cliente, glosa…") +
        '<label class="pv-f pv-f--check"><input type="checkbox" id="fSinGestion"> <span>Solo sin gestión</span></label>' +
      "</div>" +
      '<div id="otTabla"></div>' +
      '<div id="otFicha" class="pv-ficha" hidden></div>';

    var cols = [
      { k: "FOLIO OT", t: "Folio", ancho: "88px" },
      { k: "FECHA OT", t: "Fecha", tipo: "fecha", ancho: "94px" },
      { k: "DIAS APERTURA", t: "Días", tipo: "num", ancho: "62px" },
      { k: "SUCURSAL", t: "Sucursal" },
      { k: "PATENTE", t: "Patente", ancho: "80px" },
      { k: "MARCA", t: "Marca" },
      { k: "MODELO", t: "Modelo" },
      { k: "ASESOR", t: "Asesor" },
      { k: "ESTADO", t: "Estado", ancho: "96px" },
      { k: "NETO", t: "Neto", tipo: "pesos", ancho: "104px" },
      { k: "CATEGORIA", t: "Categoría", ancho: "104px",
        celda: function (f) {
          var v = f.CATEGORIA || "";
          return v ? '<span class="pv-etq pv-etq--' + U.esc(v.toLowerCase().replace(/[^a-z]/g, "")) + '">' + U.esc(v) + "</span>" : "—";
        } },
      { k: "_com", t: "💬", ancho: "44px",
        celda: function (f) {
          var n = (porFolio[String(f["FOLIO OT"]).trim()] || []).length;
          return n ? '<span class="pv-com">' + n + "</span>" : "";
        } }
    ];

    var tabla = new U.Tabla("otTabla", cols, {
      orden: "DIAS APERTURA", desc: true, porPagina: 60,
      vacio: "Ninguna orden calza con estos filtros.",
      alPinchar: function (fila) { abrirFicha(fila, porFolio, doc); }
    });

    function aplicar() {
      var filtradas = U.filtrar(ots, {
        fSuc: "SUCURSAL", fAse: "ASESOR", fEst: "ESTADO", fCat: "CATEGORIA"
      }, "fTxt");
      if (document.getElementById("fSinGestion").checked) {
        filtradas = filtradas.filter(function (o) {
          return !EDITABLES.some(function (c) { return String(o[c] || "").trim(); });
        });
      }
      pintarKpis(filtradas);
      tabla.datos(filtradas).pintar();
      MODS.ots._filtradas = filtradas;
    }

    function pintarKpis(f) {
      var neto = f.reduce(function (a, o) { return a + U.numero(o.NETO); }, 0);
      var viejas = f.filter(function (o) { return U.numero(o["DIAS APERTURA"]) >= 90; }).length;
      var sinGestion = f.filter(function (o) {
        return !EDITABLES.some(function (c) { return String(o[c] || "").trim(); });
      }).length;
      document.getElementById("otKpis").innerHTML = U.kpis([
        { t: "Órdenes", v: U.miles(f.length) },
        { t: "Monto neto", v: U.pesos(neto) },
        { t: "Con 90 días o más", v: U.miles(viejas), cls: viejas ? "pv-kpi--alerta" : "" },
        { t: "Sin gestión", v: U.miles(sinGestion), cls: sinGestion ? "pv-kpi--aviso" : "" }
      ]);
    }

    ["fSuc", "fAse", "fEst", "fCat"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", aplicar);
    });
    document.getElementById("fSinGestion").addEventListener("change", aplicar);
    var t = null;
    document.getElementById("fTxt").addEventListener("input", function () {
      clearTimeout(t); t = setTimeout(aplicar, 200);
    });
    document.getElementById("otXls").addEventListener("click", function () {
      U.aExcel("ordenes_de_trabajo", cols.filter(function (c) { return c.k !== "_com"; }),
               MODS.ots._filtradas || ots);
    });

    aplicar();
  }

  /* ---------- ficha de una OT ---------- */
  function abrirFicha(o, porFolio, doc) {
    var folio = String(o["FOLIO OT"]).trim();
    var el = document.getElementById("otFicha");
    el.hidden = false;

    var docs = [
      ["Liquidaciones", o.N_LIQ_ST, o.FOLIOS_LIQ_ST],
      ["Facturas a cliente", o.N_FACT_CLIENTE, o.FOLIOS_FACT_CLIENTE],
      ["Facturas a compañía", o.N_FACT_COMPANIA, o.FOLIOS_FACT_COMPANIA],
      ["Cargos internos", o.N_CARGO_INT, o.FOLIOS_CARGO_INT],
      ["Cargos garantía", o.N_CARGO_GTIA, o.FOLIOS_CARGO_GTIA],
      ["Facturas garantía", o.N_FACT_GTIA, o.FOLIOS_FACT_GTIA],
      ["Vales de consumo", o.N_VALE_CONSUMO, o.FOLIOS_VALE_CONSUMO]
    ].filter(function (d) { return U.numero(d[1]) > 0 || String(d[2] || "").trim(); });

    var reps = (o.repuestos_actual || []).concat(o.repuestos_historico || []);

    el.innerHTML =
      '<div class="pv-ficha__cab">' +
        "<div><h3>OT " + U.esc(folio) + " · " + U.esc(o.PATENTE || "sin patente") + "</h3>" +
        "<p>" + U.esc([o.MARCA, o.MODELO, o["AÑO"]].filter(Boolean).join(" ")) + " · " +
        U.esc(o.SUCURSAL || "") + " · " + U.esc(o.ASESOR || "sin asesor") + "</p></div>" +
        '<button type="button" class="pv-cerrar" id="fiCerrar" aria-label="Cerrar">×</button>' +
      "</div>" +

      '<div class="pv-ficha__grid">' +
        '<div class="pv-ficha__col">' +
          "<h4>Gestión</h4>" +
          '<label class="pv-campo"><span>Categoría</span>' +
            '<select id="edCATEGORIA">' + CATEGORIAS.map(function (c) {
              return '<option value="' + U.esc(c) + '"' +
                     (String(o.CATEGORIA || "") === c ? " selected" : "") + ">" +
                     U.esc(c || "— sin categoría —") + "</option>";
            }).join("") + "</select></label>" +
          campoTexto("OBSERVACION OT", "Observación", o["OBSERVACION OT"]) +
          campoTexto("NOTAS", "Notas", o.NOTAS) +
          campoTexto("AVANCE - GESTIÓN", "Avance / gestión", o["AVANCE - GESTIÓN"], true) +
          '<p class="pv-ultima">' + (o.ULTIMA_EDICION ? "Última edición: " + U.esc(o.ULTIMA_EDICION) : "Sin ediciones.") + "</p>" +
          '<button type="button" class="pv-btn pv-btn--ok" id="fiGuardar">Guardar gestión</button>' +
        "</div>" +

        '<div class="pv-ficha__col">' +
          "<h4>Trabajo</h4>" +
          '<p class="pv-glosa">' + U.esc(o["GLOSA TRABAJO"] || "Sin glosa.") + "</p>" +
          "<dl class=\"pv-datos\">" +
            fila("Estado", o.ESTADO) + fila("Tipo de venta", o["TIPO VENTA"]) +
            fila("Tipo de cliente", o["TIPO CLIENTE"]) + fila("RUT", o.rut_cliente) +
            fila("Importador", o.IMPORTADOR) + fila("Neto", U.pesos(o.NETO)) +
            fila("Días abierta", o["DIAS APERTURA"]) + fila("Rango", o.RANGO) +
          "</dl>" +
          (docs.length
            ? "<h4>Documentos</h4><dl class=\"pv-datos\">" + docs.map(function (d) {
                return fila(d[0] + (U.numero(d[1]) ? " (" + U.numero(d[1]) + ")" : ""), d[2]);
              }).join("") + "</dl>"
            : "") +
          (reps.length
            ? "<h4>Repuestos (" + reps.length + ")</h4>" +
              '<div class="pv-reps">' + reps.slice(0, 40).map(function (rp) {
                return "<div><b>" + U.esc(rp.producto || "") + "</b> " +
                       U.esc(rp.descripcion || "") +
                       (rp.cantidad ? " · " + U.esc(rp.cantidad) : "") + "</div>";
              }).join("") + (reps.length > 40 ? "<div>… y " + (reps.length - 40) + " más</div>" : "") + "</div>"
            : "") +
        "</div>" +

        '<div class="pv-ficha__col">' +
          "<h4>Comentarios</h4>" +
          '<div class="pv-coments" id="fiComents">' + pintarComents(porFolio[folio] || []) + "</div>" +
          '<textarea id="fiNuevo" rows="3" placeholder="Escribe un comentario…"></textarea>' +
          '<button type="button" class="pv-btn" id="fiComentar">Agregar comentario</button>' +
        "</div>" +
      "</div>";

    el.scrollIntoView({ behavior: "smooth", block: "start" });

    document.getElementById("fiCerrar").onclick = function () { el.hidden = true; };
    document.getElementById("fiGuardar").onclick = function () { guardarGestion(o, folio); };
    document.getElementById("fiComentar").onclick = function () { comentar(folio, porFolio); };
  }

  function campoTexto(k, etiqueta, valor, alto) {
    return '<label class="pv-campo"><span>' + U.esc(etiqueta) + "</span>" +
           '<textarea id="ed' + U.esc(k) + '" rows="' + (alto ? 4 : 2) + '">' +
           U.esc(valor || "") + "</textarea></label>";
  }
  function fila(t, v) {
    return "<dt>" + U.esc(t) + "</dt><dd>" + (v == null || v === "" ? "—" : U.esc(v)) + "</dd>";
  }
  function pintarComents(lista) {
    if (!lista.length) return '<p class="pv-vacio">Sin comentarios.</p>';
    return lista.slice().reverse().map(function (c) {
      return '<div class="pv-com__it"><b>' + U.esc(c.autor || "?") + "</b> " +
             '<span>' + U.esc(c.fecha || "") + "</span><p>" + U.esc(c.comentario || "") + "</p></div>";
    }).join("");
  }

  /* Guarda SOLO las 4 columnas editables sobre la OT que corresponde. Se
     busca por folio dentro del documento fresco, no por posición: el
     consolidador reordena las filas cada día. */
  function guardarGestion(o, folio) {
    var cambios = {};
    EDITABLES.forEach(function (k) {
      var el = document.getElementById("ed" + k);
      if (el) cambios[k] = el.value.trim();
    });
    var sello = D.quienSoy() + " — " + D.fechaHoraChile();

    U.aviso("Guardando…");
    D.guardar("datos_dashboard.json", function (d) {
      var lista = (d && d.ots) || [];
      for (var i = 0; i < lista.length; i++) {
        if (String(lista[i]["FOLIO OT"]).trim() === folio) {
          Object.keys(cambios).forEach(function (k) { lista[i][k] = cambios[k]; });
          lista[i].ULTIMA_EDICION = sello;
          break;
        }
      }
      return d;
    }, "gestión OT " + folio)
      .then(function () {
        Object.keys(cambios).forEach(function (k) { o[k] = cambios[k]; });
        o.ULTIMA_EDICION = sello;
        U.aviso("Gestión guardada.", "ok");
        D.auditar("EDICION", "Gestión de OT " + folio, folio);
        MODS.ots();
      })
      .catch(function (e) {
        U.aviso("No se guardó: " + ((e && e.message) || e) + ". Vuelve a intentarlo.", "error");
      });
  }

  function comentar(folio, porFolio) {
    var ta = document.getElementById("fiNuevo");
    var txt = ta.value.trim();
    if (!txt) { U.aviso("Escribe algo antes de agregar.", "aviso"); return; }
    var nuevo = {
      folio_ot: folio, autor: D.quienSoy(),
      fecha: D.fechaHoraChile(), comentario: txt, mencionado: ""
    };
    U.aviso("Guardando comentario…");
    D.guardar("comentarios_log.json", function (d) {
      var lista = (d && d.comentarios) || [];
      lista.push(nuevo);
      return { comentarios: lista };
    }, "comentario OT " + folio)
      .then(function () {
        (porFolio[folio] = porFolio[folio] || []).push(nuevo);
        document.getElementById("fiComents").innerHTML = pintarComents(porFolio[folio]);
        ta.value = "";
        U.aviso("Comentario agregado.", "ok");
        D.auditar("COMENTARIO", "Comentario en OT " + folio, folio);
      })
      .catch(function (e) {
        U.aviso("No se guardó el comentario: " + ((e && e.message) || e), "error");
      });
  }

  /* ============================================================
     Campañas
     ============================================================ */
  MODS.campanas = function () {
    U.cargando(vista, "Cargando campañas…");
    D.leer("campanas_curifor.json").then(function (r) {
      var d = r.data || {};
      var camp = d.campanas || [];

      vista.innerHTML =
        cabecera("Campañas", "Actualizado " + U.esc(d.fecha_actualizacion || "—"),
                 '<button type="button" class="pv-btn" id="cmXls">Exportar a Excel</button>') +
        '<div id="cmKpis"></div>' +
        '<div class="pv-filtros">' +
          U.selector("cSuc", "Sucursal", U.opciones(camp, "sucursal")) +
          U.selector("cAse", "Asesor", U.opciones(camp, "asesor"), "Todos") +
          U.selector("cEst", "Estado", U.opciones(camp, "estado_texto"), "Todos") +
          U.selector("cRev", "Revisado", U.opciones(camp, "revisado"), "Todos") +
          U.buscador("cTxt", "patente, chasis, propietario…") +
        "</div><div id=\"cmTabla\"></div>";

      var cols = [
        { k: "fecha_programacion", t: "Fecha", tipo: "fecha", ancho: "94px" },
        { k: "hora", t: "Hora", ancho: "62px",
          celda: function (f) {
            var h = String(f.hora || "");
            return h.length === 4 ? h.slice(0, 2) + ":" + h.slice(2) : (h || "—");
          } },
        { k: "sucursal", t: "Sucursal" },
        { k: "patente", t: "Patente", ancho: "80px" },
        { k: "modelo", t: "Modelo" },
        { k: "propietario", t: "Propietario" },
        { k: "asesor", t: "Asesor" },
        { k: "campanas", t: "Campañas" },
        { k: "estado_texto", t: "Estado", ancho: "110px",
          celda: function (f) {
            var c = String(f.estado_color || "").toLowerCase();
            return '<span class="pv-etq pv-etq--' + U.esc(c.replace(/[^a-z]/g, "") || "gris") + '">' +
                   U.esc(f.estado_texto || f.estado || "—") + "</span>";
          } },
        { k: "revisado", t: "Revisado", ancho: "100px" }
      ];

      var tabla = new U.Tabla("cmTabla", cols, { orden: "fecha_programacion", desc: true, porPagina: 80 });

      function aplicar() {
        var f = U.filtrar(camp, { cSuc: "sucursal", cAse: "asesor", cEst: "estado_texto", cRev: "revisado" }, "cTxt");
        var obligatorias = f.filter(function (x) { return x.recall_obligatorio; }).length;
        var realizadas = f.filter(function (x) { return String(x.estado || "") === "realizada"; }).length;
        document.getElementById("cmKpis").innerHTML = U.kpis([
          { t: "Citas con campaña", v: U.miles(f.length) },
          { t: "Realizadas", v: U.miles(realizadas) },
          { t: "Pendientes", v: U.miles(f.length - realizadas), cls: (f.length - realizadas) ? "pv-kpi--aviso" : "" },
          { t: "Recall obligatorio", v: U.miles(obligatorias), cls: obligatorias ? "pv-kpi--alerta" : "" }
        ]);
        tabla.datos(f).pintar();
        MODS.campanas._f = f;
      }

      ["cSuc", "cAse", "cEst", "cRev"].forEach(function (id) {
        document.getElementById(id).addEventListener("change", aplicar);
      });
      var t = null;
      document.getElementById("cTxt").addEventListener("input", function () {
        clearTimeout(t); t = setTimeout(aplicar, 200);
      });
      document.getElementById("cmXls").addEventListener("click", function () {
        U.aExcel("campanas", cols, MODS.campanas._f || camp);
      });
      aplicar();
    }).catch(function (e) { U.error(vista, e); });
  };

  /* ============================================================
     Producción de técnicos
     ============================================================ */
  MODS.produccion = function () {
    U.cargando(vista, "Cargando producción…");
    D.leer("produccion_tecnicos.json").then(function (r) {
      var d = r.data || {};
      var resumen = d.resumen || [], detalle = d.detalle_ot || [];

      vista.innerHTML =
        cabecera("Producción de técnicos", "Actualizado " + U.esc(d.fecha_actualizacion || "—"),
                 '<button type="button" class="pv-btn" id="prXls">Exportar a Excel</button>') +
        '<div id="prKpis"></div>' +
        '<div class="pv-filtros">' +
          U.selector("pSuc", "Sucursal", U.opciones(resumen, "sucursal_mecanico")) +
          U.selector("pMec", "Mecánico", U.opciones(resumen, "mecanico"), "Todos") +
          U.selector("pMes", "Mes", U.opciones(resumen, "mes").reverse(), "Todos") +
          U.buscador("pTxt", "mecánico…") +
        "</div><div id=\"prTabla\"></div>";

      var cols = [
        { k: "mes", t: "Mes", ancho: "88px" },
        { k: "mecanico", t: "Mecánico" },
        { k: "sucursal_mecanico", t: "Sucursal" },
        { k: "n_ot", t: "OT", tipo: "num", ancho: "70px" },
        { k: "total_horas", t: "Horas", tipo: "num", ancho: "84px",
          celda: function (f) { return U.decimal(f.total_horas); } }
      ];
      var tabla = new U.Tabla("prTabla", cols, { orden: "total_horas", desc: true, porPagina: 80 });

      function aplicar() {
        var f = U.filtrar(resumen, { pSuc: "sucursal_mecanico", pMec: "mecanico", pMes: "mes" }, "pTxt");
        var horas = f.reduce(function (a, x) { return a + U.numero(x.total_horas); }, 0);
        var ots = f.reduce(function (a, x) { return a + U.numero(x.n_ot); }, 0);
        var mecs = {};
        f.forEach(function (x) { mecs[x.mecanico] = true; });
        document.getElementById("prKpis").innerHTML = U.kpis([
          { t: "Horas", v: U.decimal(horas, 1) },
          { t: "Órdenes atendidas", v: U.miles(ots) },
          { t: "Mecánicos", v: U.miles(Object.keys(mecs).length) },
          { t: "Horas por OT", v: ots ? U.decimal(horas / ots) : "—" }
        ]);
        tabla.datos(f).pintar();
        MODS.produccion._f = f;
      }

      ["pSuc", "pMec", "pMes"].forEach(function (id) {
        document.getElementById(id).addEventListener("change", aplicar);
      });
      var t = null;
      document.getElementById("pTxt").addEventListener("input", function () {
        clearTimeout(t); t = setTimeout(aplicar, 200);
      });
      document.getElementById("prXls").addEventListener("click", function () {
        U.aExcel("produccion_tecnicos", cols, MODS.produccion._f || resumen);
      });
      aplicar();
    }).catch(function (e) { U.error(vista, e); });
  };

  /* ============================================================
     Cierres y ranking
     ============================================================ */
  MODS.cierres = function () {
    U.cargando(vista, "Cargando cierres…");
    Promise.all([D.leer("ranking_cierres.json"), D.leer("historial_cierres.json")])
      .then(function (r) {
        var rk = r[0].data || {}, hist = (r[1].data && r[1].data.registros) || [];

        vista.innerHTML =
          cabecera("Cierres y ranking",
                   "Generado " + U.esc(rk.fecha_generacion || "—") +
                   " · desde " + U.esc(rk.periodo_desde || "—")) +
          U.kpis([
            { t: "OT cerradas con 90 días o más", v: U.miles(rk.total_ots_90mas || 0),
              cls: (rk.total_ots_90mas || 0) ? "pv-kpi--alerta" : "" },
            { t: "Asesores en el ranking", v: U.miles((rk.por_asesor || []).length) },
            { t: "Sucursales", v: U.miles((rk.por_sucursal || []).length) },
            { t: "Días de cierre más alto", v: U.miles(Math.max.apply(null,
                (rk.por_sucursal || []).map(function (x) { return U.numero(x.dias_max); }).concat([0]))) }
          ]) +
          '<div class="pv-dos">' +
            '<section><h4>Por sucursal</h4><div id="ckSuc"></div></section>' +
            '<section><h4>Por asesor</h4><div id="ckAse"></div></section>' +
          "</div>" +
          "<h4>Órdenes que más demoraron en cerrarse</h4><div id=\"ckTop\"></div>" +
          "<h4>Cierres por día</h4><div id=\"ckHist\"></div>";

        new U.Tabla("ckSuc", [
          { k: "SUCURSAL", t: "Sucursal" },
          { k: "total", t: "OT", tipo: "num", ancho: "64px" },
          { k: "dias_promedio", t: "Días prom.", tipo: "num", ancho: "94px",
            celda: function (f) { return U.decimal(f.dias_promedio); } },
          { k: "dias_max", t: "Máx.", tipo: "num", ancho: "70px" }
        ], { orden: "total", desc: true, porPagina: 20 }).datos(rk.por_sucursal || []).pintar();

        new U.Tabla("ckAse", [
          { k: "ASESOR", t: "Asesor" },
          { k: "total", t: "OT", tipo: "num", ancho: "64px" },
          { k: "dias_promedio", t: "Días prom.", tipo: "num", ancho: "94px",
            celda: function (f) { return U.decimal(f.dias_promedio); } },
          { k: "dias_max", t: "Máx.", tipo: "num", ancho: "70px" }
        ], { orden: "total", desc: true, porPagina: 25 }).datos(rk.por_asesor || []).pintar();

        new U.Tabla("ckTop", [
          { k: "folio_ot", t: "Folio", ancho: "90px" },
          { k: "sucursal", t: "Sucursal" },
          { k: "asesor", t: "Asesor" },
          { k: "tipo_venta", t: "Tipo de venta" },
          { k: "fecha_apertura", t: "Apertura", tipo: "fecha", ancho: "96px" },
          { k: "fecha_cierre", t: "Cierre", tipo: "fecha", ancho: "96px" },
          { k: "dias_al_cierre", t: "Días", tipo: "num", ancho: "70px" }
        ], { orden: "dias_al_cierre", desc: true, porPagina: 40 }).datos(rk.top_ots || []).pintar();

        new U.Tabla("ckHist", [
          { k: "fecha", t: "Fecha", tipo: "fecha", ancho: "110px" },
          { k: "total_cerradas", t: "Cerradas", tipo: "num" },
          { k: "total_nuevas", t: "Nuevas", tipo: "num" },
          { k: "total_activas", t: "Activas", tipo: "num" }
        ], { orden: "fecha", desc: true, porPagina: 30 }).datos(hist).pintar();
      })
      .catch(function (e) { U.error(vista, e); });
  };

  /* ============================================================
     Loaners
     ============================================================ */
  MODS.loaners = function () {
    U.cargando(vista, "Cargando loaners…");
    D.leer("loaners.json").then(function (r) {
      var mapa = (r.data && r.data.loaners) || {};
      var filas = Object.keys(mapa).map(function (vin) {
        var x = mapa[vin] || {};
        x._vin = vin;
        return x;
      });

      vista.innerHTML =
        cabecera("Loaners", "Flota de vehículos de cortesía",
                 '<button type="button" class="pv-btn" id="loXls">Exportar a Excel</button>') +
        U.kpis([
          { t: "Vehículos", v: U.miles(filas.length) },
          { t: "Disponibles", v: U.miles(filas.filter(function (f) {
              return !String(f.patente_cliente || f.ot || "").trim(); }).length) }
        ]) +
        '<div id="loTabla"></div>';

      var cols = [
        { k: "_vin", t: "VIN" },
        { k: "patente", t: "Patente", ancho: "88px" },
        { k: "modelo", t: "Modelo" },
        { k: "sucursal", t: "Sucursal" },
        { k: "estado", t: "Estado" },
        { k: "cliente", t: "Cliente" },
        { k: "desde", t: "Desde", tipo: "fecha", ancho: "96px" },
        { k: "hasta", t: "Hasta", tipo: "fecha", ancho: "96px" }
      ];
      new U.Tabla("loTabla", cols, { orden: "_vin", porPagina: 50,
        vacio: "No hay vehículos de cortesía cargados." }).datos(filas).pintar();
      document.getElementById("loXls").addEventListener("click", function () {
        U.aExcel("loaners", cols, filas);
      });
    }).catch(function (e) { U.error(vista, e); });
  };

  /* ============================================================
     Actividad (auditoría)
     ============================================================ */
  MODS.auditoria = function () {
    U.cargando(vista, "Cargando actividad…");
    D.leer("audit_log.json").then(function (r) {
      var regs = (r.data && r.data.registros) || [];

      vista.innerHTML =
        cabecera("Actividad", "Lo que ha hecho el equipo en la plataforma") +
        '<div class="pv-filtros">' +
          U.selector("aUsu", "Usuario", U.opciones(regs, "usuario"), "Todos") +
          U.selector("aAcc", "Acción", U.opciones(regs, "accion"), "Todas") +
          U.buscador("aTxt", "folio, detalle…") +
        "</div><div id=\"auTabla\"></div>";

      var cols = [
        { k: "fecha", t: "Fecha", tipo: "fecha", ancho: "130px" },
        { k: "usuario", t: "Usuario" },
        { k: "accion", t: "Acción", ancho: "120px" },
        { k: "folio_ot", t: "OT", ancho: "88px" },
        { k: "detalle", t: "Detalle" }
      ];
      var tabla = new U.Tabla("auTabla", cols, { orden: "fecha", desc: true, porPagina: 60 });

      function aplicar() {
        tabla.datos(U.filtrar(regs, { aUsu: "usuario", aAcc: "accion" }, "aTxt")).pintar();
      }
      ["aUsu", "aAcc"].forEach(function (id) {
        document.getElementById(id).addEventListener("change", aplicar);
      });
      var t = null;
      document.getElementById("aTxt").addEventListener("input", function () {
        clearTimeout(t); t = setTimeout(aplicar, 200);
      });
      aplicar();
    }).catch(function (e) { U.error(vista, e); });
  };

  /* ============================================================
     Indicadores — informe de Power BI incrustado
     ============================================================ */
  MODS.indicadores = function () {
    var url = (window.CURIFOR_AGENDA && window.CURIFOR_AGENDA.powerbi) || "";
    vista.innerHTML = cabecera("Indicadores Post Venta", "Avances de facturación · Power BI");
    if (!url) {
      vista.innerHTML +=
        '<div class="pv-error"><b>El informe todavía no está configurado.</b>' +
        "<p>Falta la dirección del informe de Power BI. Se agrega en " +
        "<code>js/agenda-config.js</code>, en la clave <code>powerbi</code>, " +
        "con el enlace de <i>Publicar en la web</i> del informe.</p></div>";
      return;
    }
    vista.innerHTML +=
      '<div class="pv-chips">' +
        ["Post Venta General", "Servicio Técnico", "DyP", "Avance Facturación",
         "Venta Repuestos", "Pronóstico Ventas"].map(function (t, i) {
          return '<span class="pv-chip">' + (i + 1) + " · " + U.esc(t) + "</span>";
        }).join("") +
      "</div>" +
      '<div class="pv-pbi"><iframe title="Indicadores Post Venta" src="' + U.esc(url) +
      '" frameborder="0" allowfullscreen></iframe></div>';
  };

  /* ============================================================
     Los que faltan por migrar
     ============================================================ */
  ["cuenta", "informes"].forEach(function (m) {
    MODS[m] = function () {
      var nombres = { cuenta: "Cuenta Ficha", informes: "Informes de gestión" };
      vista.innerHTML = cabecera(nombres[m], "En migración") +
        '<div class="pv-error"><b>Este módulo todavía vive en la app antigua.</b>' +
        "<p>Se está migrando. Mientras tanto sigue funcionando allá, con los " +
        "mismos datos: lo que se guarda en un lado lo ve el otro.</p></div>";
    };
  });

  /* ============================================================
     Navegación
     ============================================================ */
  function cabecera(titulo, sub, acciones) {
    return '<div class="pv-cab"><div><h2>' + U.esc(titulo) + "</h2>" +
           (sub ? "<p>" + sub + "</p>" : "") + "</div>" +
           (acciones ? '<div class="pv-cab__acc">' + acciones + "</div>" : "") + "</div>";
  }

  function ir(mod) {
    if (!MODS[mod]) return;
    actual = mod;
    document.querySelectorAll(".pv-nav__btn").forEach(function (b) {
      b.classList.toggle("is-on", b.dataset.mod === mod);
    });
    try { history.replaceState(null, "", "?m=" + mod); } catch (e) {}
    var el = document.getElementById("pvAviso");
    if (el) el.hidden = true;
    MODS[mod]();
    window.scrollTo(0, 0);
  }

  document.getElementById("pvNav").addEventListener("click", function (e) {
    var b = e.target.closest(".pv-nav__btn");
    if (b) ir(b.dataset.mod);
  });

  /* Arranca en el módulo de la dirección, o en las OT.

     Se espera a que auth.js confirme (o refresque) la sesión antes de pedir
     nada: si se arranca de inmediato con un token recién vencido, la primera
     consulta falla y el usuario ve un error en vez de su pantalla. */
  function arrancar() {
    var m = new URLSearchParams(location.search).get("m");
    ir(MODS[m] ? m : "ots");
  }

  function iniciar() {
    var A = window.CURIFOR_AUTH;
    if (A && A.sesion) A.sesion().then(arrancar, arrancar);
    else arrancar();
  }

  if (document.readyState === "complete" || document.readyState === "interactive") iniciar();
  else window.addEventListener("DOMContentLoaded", iniciar);
})();
