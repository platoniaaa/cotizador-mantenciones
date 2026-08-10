/* ============================================================
   Control y Gestión Post Venta — órdenes de trabajo pendientes.

   Reemplaza el módulo "Control" de la app Streamlit (app.py). Lee de las
   tablas que dejó la migración del 10-08-2026 (herramientas/setup_supabase_ots.sql):

     · ots            — la sábana del ERP. SOLO LECTURA: la recarga el proceso
                        de consolidación y aquí nunca se escribe.
     · ots_gestion    — las cuatro columnas que escribe la gente. Vive aparte
                        justamente para que el refresco diario no la pise.
     · ots_comentarios— hilo por OT, solo se agrega.
     · auditoria      — quién cambió qué. Solo se agrega.

   Todo pasa por PostgREST con el token del asesor, así las policies de la base
   son la barrera real (no hay clave de servicio en el navegador).
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.CURIFOR_AGENDA || {};
  var AUTH = window.CURIFOR_AUTH || {};

  // [nombre, sufijo de columna, sigla del chip]. La sigla va explícita y no
  // calculada con las iniciales: "Vale de Consumo" salía "VdC" y no se entendía.
  var DOCS = [
    ["Liquidación ST", "liq_st", "LIQ"],
    ["Factura Cliente", "fact_cliente", "FC"],
    ["Factura Compañía", "fact_compania", "FCÍA"],
    ["Cargo Interno", "cargo_int", "CI"],
    ["Cargo Garantía", "cargo_gtia", "CG"],
    ["Factura Garantía", "fact_gtia", "FG"],
    ["Vale de Consumo", "vale_consumo", "VALE"]
  ];

  // Columnas de `ots` que necesita el listado. Se excluyen los jsonb de
  // repuestos a propósito: pesan y solo se miran en la ficha de una OT.
  var COLS_LISTA = [
    "folio_ot", "sucursal", "rango", "dias_apertura", "fecha_ot", "tipo_venta",
    "tipo_cliente", "marca", "modelo", "anio_vehiculo", "patente", "asesor",
    "estado", "neto", "glosa_trabajo", "rut_cliente"
  ].concat(DOCS.map(function (d) { return "folios_" + d[1]; }));

  var CAMPOS_EDIT = [
    ["categoria", "Categoría"],
    ["observacion_ot", "Observación"],
    ["notas", "Notas"],
    ["avance_gestion", "Avance / gestión"]
  ];

  var PAGINA = 150;         // filas por tanda en la tabla

  var ST = {
    ots: [],                // filas crudas de `ots`
    gestion: {},            // folio -> fila de ots_gestion
    comentarios: {},        // folio -> cantidad
    filtradas: [],
    mostradas: PAGINA,
    orden: { col: "dias_apertura", desc: true },
    email: "",
    categorias: []          // las que ya existen, para el datalist
  };

  /* ---------------- utilidades ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    if (n == null || n === "") return "";
    return "$" + Number(n).toLocaleString("es-CL", { maximumFractionDigits: 0 });
  }
  function fechaCorta(iso) {
    if (!iso) return "";
    var p = String(iso).slice(0, 10).split("-");
    return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : iso;
  }
  // dd/mm/aaaa hh:mm en 24 h, a mano y no con toLocaleString: la columna
  // `ultima_edicion` ya trae años de valores heredados con ESTE formato, y
  // es-CL devuelve "10-08-2026, 09:38 a. m.", que en la misma columna se ve roto.
  function fechaHora(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d)) return iso;
    function dd(n) { return String(n).padStart(2, "0"); }
    return dd(d.getDate()) + "/" + dd(d.getMonth() + 1) + "/" + d.getFullYear() +
           " " + dd(d.getHours()) + ":" + dd(d.getMinutes());
  }
  // El ERP manda "PENDIENTE" y "Pendiente" para lo mismo: se muestra parejo.
  function titulo(s) {
    s = String(s || "").trim();
    if (!s) return "";
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  var _avisoTimer = null;
  function aviso(txt, tipo) {
    var el = $("otsAviso");
    el.textContent = txt;
    el.className = "ots-aviso" + (tipo ? " is-" + tipo : "");
    el.hidden = false;
    clearTimeout(_avisoTimer);
    _avisoTimer = setTimeout(function () { el.hidden = true; }, tipo === "error" ? 9000 : 4000);
  }

  /* ---------------- acceso a datos ---------------- */
  function api(ruta, opts) {
    opts = opts || {};
    return AUTH.sesion().then(function (s) {
      if (!s) { location.replace("login.html?next=ots.html"); return Promise.reject("sin sesión"); }
      ST.email = s.email || "";
      var h = {
        apikey: CFG.anonKey,
        Authorization: "Bearer " + s.access,
        "Content-Type": "application/json"
      };
      if (opts.prefer) h.Prefer = opts.prefer;
      return fetch(CFG.url + "/rest/v1/" + ruta, {
        method: opts.method || "GET",
        headers: h,
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) { return Promise.reject(new Error(t || r.status)); });
        return r.status === 204 ? null : r.json();
      });
    });
  }

  function cargarTodo() {
    return Promise.all([
      api("ots?select=" + COLS_LISTA.join(",") + "&order=dias_apertura.desc.nullslast&limit=20000"),
      api("ots_gestion?select=*&limit=20000"),
      api("ots_comentarios?select=folio_ot&limit=20000")
    ]).then(function (r) {
      ST.ots = r[0] || [];
      ST.gestion = {};
      (r[1] || []).forEach(function (g) { ST.gestion[g.folio_ot] = g; });
      ST.comentarios = {};
      (r[2] || []).forEach(function (c) {
        ST.comentarios[c.folio_ot] = (ST.comentarios[c.folio_ot] || 0) + 1;
      });
      var cats = {};
      Object.keys(ST.gestion).forEach(function (f) {
        var c = (ST.gestion[f].categoria || "").trim();
        if (c) cats[c] = 1;
      });
      ST.categorias = Object.keys(cats).sort();
    });
  }

  // La gestión y su rastro de auditoría van juntos: si la fila se guarda, el
  // registro de quién la tocó también. Si falla el guardado, no se audita nada.
  function guardarGestion(folio, campo, valor) {
    var fila = ST.ots.find(function (o) { return o.folio_ot === folio; });
    var prev = ST.gestion[folio] || {};
    var cuerpo = {
      folio_ot: folio,
      sucursal: (fila && fila.sucursal) || prev.sucursal || "",
      categoria: prev.categoria || null,
      observacion_ot: prev.observacion_ot || null,
      notas: prev.notas || null,
      avance_gestion: prev.avance_gestion || null,
      marca_color: prev.marca_color || null,
      etapa_jpcb: prev.etapa_jpcb || null
    };
    cuerpo[campo] = valor || null;
    cuerpo.ultima_edicion = ST.email + " — " + fechaHora(new Date().toISOString());

    return api("ots_gestion", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=representation",
      body: cuerpo
    }).then(function (r) {
      ST.gestion[folio] = (r && r[0]) || cuerpo;
      return api("auditoria", {
        method: "POST", prefer: "return=minimal",
        body: {
          usuario: ST.email, accion: "EDICION",
          detalle: campo + ": " + (valor || "(vacío)").slice(0, 200), folio_ot: folio
        }
      }).catch(function () { /* el rastro no debe tumbar el guardado */ });
    });
  }

  /* ---------------- filtros ---------------- */
  function opciones(sel, valores) {
    sel.innerHTML = valores.map(function (v) {
      return '<option value="' + esc(v) + '">' + esc(v) + "</option>";
    }).join("");
  }

  function unicos(campo) {
    var m = {};
    ST.ots.forEach(function (o) {
      var v = (o[campo] || "").trim();
      if (v) m[v] = 1;
    });
    return Object.keys(m).sort(function (a, b) { return a.localeCompare(b, "es"); });
  }

  function seleccionados(sel) {
    return Array.prototype.filter.call(sel.options, function (o) { return o.selected; })
      .map(function (o) { return o.value; });
  }

  function poblarFiltros() {
    opciones($("fSucursal"), unicos("sucursal"));
    opciones($("fRango"), ["0-30", "31-60", "61-90", "91 o más"]);
    opciones($("fTipoVenta"), unicos("tipo_venta"));
    opciones($("fMarca"), unicos("marca"));
    opciones($("fAsesor"), unicos("asesor"));
    opciones($("fCategoria"), ST.categorias.concat(["(sin categoría)"]));
    opciones($("fDocumento"), DOCS.map(function (d) { return d[0]; }));
    var fechas = ST.ots.map(function (o) { return o.fecha_ot; }).filter(Boolean).sort();
    if (fechas.length) {
      $("fDesde").min = $("fHasta").min = fechas[0];
      $("fDesde").max = $("fHasta").max = fechas[fechas.length - 1];
    }
    $("fichaLista").innerHTML = ST.ots.map(function (o) {
      return '<option value="' + esc(o.folio_ot) + '">' + esc(o.patente || "") + " · " + esc(o.sucursal) + "</option>";
    }).join("");
  }

  function aplicarFiltros() {
    var q = $("fBuscar").value.trim().toLowerCase();
    var suc = seleccionados($("fSucursal")), ran = seleccionados($("fRango"));
    var tv = seleccionados($("fTipoVenta")), mar = seleccionados($("fMarca"));
    var ase = seleccionados($("fAsesor")), cat = seleccionados($("fCategoria"));
    var doc = seleccionados($("fDocumento"));
    var desde = $("fDesde").value, hasta = $("fHasta").value;

    ST.filtradas = ST.ots.filter(function (o) {
      if (suc.length && suc.indexOf(o.sucursal) < 0) return false;
      if (ran.length && ran.indexOf(o.rango) < 0) return false;
      if (tv.length && tv.indexOf(o.tipo_venta) < 0) return false;
      if (mar.length && mar.indexOf(o.marca) < 0) return false;
      if (ase.length && ase.indexOf(o.asesor) < 0) return false;
      if (desde && (!o.fecha_ot || o.fecha_ot < desde)) return false;
      if (hasta && (!o.fecha_ot || o.fecha_ot > hasta)) return false;
      if (cat.length) {
        var c = ((ST.gestion[o.folio_ot] || {}).categoria || "").trim();
        var ok = cat.some(function (x) { return x === "(sin categoría)" ? !c : x === c; });
        if (!ok) return false;
      }
      if (doc.length) {
        var tiene = doc.some(function (nom) {
          var suf = (DOCS.find(function (d) { return d[0] === nom; }) || [])[1];
          return suf && String(o["folios_" + suf] || "").trim() !== "";
        });
        if (!tiene) return false;
      }
      if (q) {
        var g = ST.gestion[o.folio_ot] || {};
        var heno = [o.folio_ot, o.patente, o.asesor, o.sucursal, o.marca, o.modelo,
                    o.glosa_trabajo, o.rut_cliente, o.tipo_cliente,
                    g.categoria, g.observacion_ot, g.notas, g.avance_gestion]
          .join(" ").toLowerCase();
        if (heno.indexOf(q) < 0) return false;
      }
      return true;
    });
    ordenar();
    ST.mostradas = PAGINA;
    var hayFiltro = q || suc.length || ran.length || tv.length || mar.length ||
                    ase.length || cat.length || doc.length || desde || hasta;
    $("fLimpiar").hidden = !hayFiltro;
    $("fCuenta").textContent = ST.filtradas.length === ST.ots.length
      ? ST.ots.length.toLocaleString("es-CL") + " OT"
      : ST.filtradas.length.toLocaleString("es-CL") + " de " + ST.ots.length.toLocaleString("es-CL") + " OT";
    render();
  }

  function ordenar() {
    var col = ST.orden.col, desc = ST.orden.desc;
    ST.filtradas.sort(function (a, b) {
      var x = a[col], y = b[col];
      if (col === "neto" || col === "dias_apertura") { x = x == null ? -1 : +x; y = y == null ? -1 : +y; }
      else { x = String(x == null ? "" : x); y = String(y == null ? "" : y); }
      if (x < y) return desc ? 1 : -1;
      if (x > y) return desc ? -1 : 1;
      return 0;
    });
  }

  /* ---------------- render ---------------- */
  function render() {
    if (vistaActual() === "resumen") renderResumen();
    else if (vistaActual() === "detalle") renderTabla();
  }

  function vistaActual() {
    var v = document.querySelector(".view.active");
    return v ? v.id.replace("v-", "") : "resumen";
  }

  function renderResumen() {
    var f = ST.filtradas;
    var total = f.reduce(function (s, o) { return s + (+o.neto || 0); }, 0);
    var vencidas = f.filter(function (o) { return (o.dias_apertura || 0) > 90; }).length;
    var sinGestion = f.filter(function (o) {
      var g = ST.gestion[o.folio_ot];
      return !g || !((g.categoria || "").trim() || (g.avance_gestion || "").trim());
    }).length;

    $("kpiGrid").innerHTML = [
      ["OT pendientes", f.length.toLocaleString("es-CL"), ""],
      ["Monto neto en juego", money(total), ""],
      ["Más de 90 días", vencidas.toLocaleString("es-CL"), vencidas ? "alerta" : ""],
      ["Sin gestión registrada", sinGestion.toLocaleString("es-CL"), sinGestion ? "aviso" : ""]
    ].map(function (k) {
      return '<div class="kpi-card' + (k[2] ? " is-" + k[2] : "") + '"><h5>' + k[0] +
             '</h5><div class="kpi-val">' + k[1] + "</div></div>";
    }).join("");

    function agrupar(fn) {
      var m = {};
      f.forEach(function (o) { var k = fn(o) || "(sin dato)"; m[k] = (m[k] || 0) + 1; });
      return Object.keys(m).map(function (k) { return [k, m[k]]; })
        .sort(function (a, b) { return b[1] - a[1]; });
    }
    var html = "";
    html += barras("Por rango de días", [["0-30", 0], ["31-60", 0], ["61-90", 0], ["91 o más", 0]]
      .map(function (p) { return [p[0], f.filter(function (o) { return o.rango === p[0]; }).length]; }));
    html += barras("Por sucursal", agrupar(function (o) { return o.sucursal; }));
    html += barras("Por categoría de gestión", agrupar(function (o) {
      return ((ST.gestion[o.folio_ot] || {}).categoria || "").trim() || "(sin categoría)";
    }));
    html += barras("Por asesor (top 12)", agrupar(function (o) { return o.asesor; }).slice(0, 12));
    $("resumenGraficos").innerHTML = html;
  }

  function barras(titulo, pares) {
    var max = Math.max.apply(null, pares.map(function (p) { return p[1]; }).concat([1]));
    var filas = pares.map(function (p) {
      return '<div class="bar-row"><span class="bl" title="' + esc(p[0]) + '">' + esc(p[0]) +
             '</span><span class="bt"><i style="width:' + Math.round(p[1] / max * 100) + '%"></i></span>' +
             '<b class="bn">' + p[1] + "</b></div>";
    }).join("");
    if (!pares.length) filas = '<p class="sin-datos">Sin datos con estos filtros.</p>';
    return '<div class="rep-card"><h5>' + esc(titulo) + "</h5>" + filas + "</div>";
  }

  function docsChips(o) {
    return DOCS.filter(function (d) { return String(o["folios_" + d[1]] || "").trim() !== ""; })
      .map(function (d) {
        return '<span class="doc-chip" title="' + esc(d[0]) + ": " + esc(o["folios_" + d[1]]) + '">' +
               esc(d[2]) + "</span>";
      }).join("");
  }

  function renderTabla() {
    var filas = ST.filtradas.slice(0, ST.mostradas);
    var html = filas.map(function (o) {
      var g = ST.gestion[o.folio_ot] || {};
      var dias = o.dias_apertura;
      var clsDias = dias > 90 ? "dias-rojo" : dias > 60 ? "dias-naranjo" : "";
      var nCom = ST.comentarios[o.folio_ot] || 0;
      var tds = CAMPOS_EDIT.map(function (c) {
        var val = g[c[0]] || "";
        var attr = c[0] === "categoria" ? ' list="catLista"' : "";
        return '<td class="td-edit"><input class="cel" data-folio="' + esc(o.folio_ot) +
               '" data-campo="' + c[0] + '" value="' + esc(val) + '"' + attr +
               ' aria-label="' + c[1] + " de la OT " + esc(o.folio_ot) + '"></td>';
      }).join("");
      return "<tr>" +
        '<td><a href="#" class="folio-link" data-folio="' + esc(o.folio_ot) + '">' + esc(o.folio_ot) + "</a>" +
          (nCom ? ' <span class="com-badge" title="' + nCom + ' comentario(s)">' + nCom + "</span>" : "") + "</td>" +
        '<td class="' + clsDias + '">' + (dias == null ? "" : dias) + "</td>" +
        "<td>" + fechaCorta(o.fecha_ot) + "</td>" +
        "<td>" + esc(o.sucursal) + "</td>" +
        "<td>" + esc(o.patente || "") + "</td>" +
        "<td>" + esc([o.marca, o.modelo].filter(Boolean).join(" ")) + "</td>" +
        "<td>" + esc(o.asesor || "") + "</td>" +
        '<td class="num">' + money(o.neto) + "</td>" +
        '<td class="td-docs">' + docsChips(o) + "</td>" +
        tds + "</tr>";
    }).join("");
    $("tblOts").innerHTML = html ||
      '<tr><td colspan="13" class="sin-datos">Ninguna OT calza con estos filtros.</td></tr>';
    var faltan = ST.filtradas.length - ST.mostradas;
    $("btnMas").hidden = faltan <= 0;
    $("otsMasTxt").textContent = faltan > 0
      ? "Mostrando " + ST.mostradas + " de " + ST.filtradas.length
      : (ST.filtradas.length ? "Mostrando las " + ST.filtradas.length : "");
  }

  /* ---------------- ficha de una OT ---------------- */
  function abrirFicha(folio) {
    irA("ficha");
    $("fichaFolio").value = folio;
    $("fichaVacia").hidden = true;
    $("fichaCont").hidden = false;
    $("fichaCont").innerHTML = '<p class="cargando">Cargando la OT ' + esc(folio) + "…</p>";

    Promise.all([
      api("ots?folio_ot=eq." + encodeURIComponent(folio) + "&select=*"),
      api("ots_comentarios?folio_ot=eq." + encodeURIComponent(folio) + "&select=*&order=fecha.asc")
    ]).then(function (r) {
      var o = (r[0] || [])[0];
      if (!o) { $("fichaCont").innerHTML = '<p class="sin-datos">No existe la OT ' + esc(folio) + ".</p>"; return; }
      var g = ST.gestion[folio] || {};
      var coms = r[1] || [];

      var datos = [
        ["Sucursal", o.sucursal], ["Fecha OT", fechaCorta(o.fecha_ot)],
        ["Días abierta", o.dias_apertura], ["Estado", titulo(o.estado)],
        ["Patente", o.patente], ["Vehículo", [o.marca, o.modelo, o.anio_vehiculo].filter(Boolean).join(" ")],
        ["Asesor", o.asesor], ["Tipo de venta", o.tipo_venta],
        ["Tipo de cliente", o.tipo_cliente], ["RUT cliente", o.rut_cliente],
        ["Neto", money(o.neto)], ["Importador", o.importador]
      ].filter(function (d) { return d[1] != null && d[1] !== ""; })
       .map(function (d) { return "<div><dt>" + esc(d[0]) + "</dt><dd>" + esc(d[1]) + "</dd></div>"; }).join("");

      var docs = DOCS.map(function (d) {
        var fol = String(o["folios_" + d[1]] || "").trim();
        var n = o["n_" + d[1]];
        if (!fol && !n) return "";
        return "<tr><td>" + esc(d[0]) + '</td><td class="num">' + (n == null ? "" : n) +
               "</td><td>" + esc(fol) + "</td></tr>";
      }).join("");

      function tablaRep(lista, titulo, cols) {
        if (!lista || !lista.length) return "";
        var filas = lista.map(function (x) {
          return "<tr>" + cols.map(function (c) {
            var v = x[c[0]];
            if (c[1] === "money") v = money(v);
            return "<td" + (c[1] === "money" || c[1] === "num" ? ' class="num"' : "") + ">" + esc(v || "") + "</td>";
          }).join("") + "</tr>";
        }).join("");
        return '<h4>' + titulo + " <span class=\"n\">(" + lista.length + ")</span></h4>" +
               '<div class="tabla-scroll"><table class="ficha-tabla"><thead><tr>' +
               cols.map(function (c) { return "<th>" + c[2] + "</th>"; }).join("") +
               "</tr></thead><tbody>" + filas + "</tbody></table></div>";
      }

      var colsRep = [["producto", "t", "Código"], ["descripcion", "t", "Descripción"],
                     ["cantidad", "num", "Cant."], ["costo_total", "money", "Costo"],
                     ["vale", "t", "Vale"]];

      var hilo = coms.map(function (c) {
        return '<li><div class="com-cab"><b>' + esc(c.autor) + "</b><time>" + fechaHora(c.fecha) +
               "</time></div><p>" + esc(c.comentario) + "</p></li>";
      }).join("");

      $("fichaCont").innerHTML =
        '<div class="ficha-cab"><h3>OT ' + esc(o.folio_ot) + "</h3>" +
          '<p class="glosa">' + esc(o.glosa_trabajo || "Sin glosa de trabajo.") + "</p></div>" +
        '<dl class="ficha-datos">' + datos + "</dl>" +

        '<div class="ficha-gestion"><h4>Gestión</h4>' +
          (g.ultima_edicion ? '<p class="ult">Última edición: ' + esc(g.ultima_edicion) + "</p>" : "") +
          CAMPOS_EDIT.map(function (c) {
            return '<label class="fg-campo">' + c[1] +
              '<input class="cel" data-folio="' + esc(folio) + '" data-campo="' + c[0] +
              '" value="' + esc(g[c[0]] || "") + '"' + (c[0] === "categoria" ? ' list="catLista"' : "") + "></label>";
          }).join("") +
        "</div>" +

        (docs ? '<h4>Documentos posteriores</h4><div class="tabla-scroll"><table class="ficha-tabla">' +
                "<thead><tr><th>Documento</th><th>N°</th><th>Folios</th></tr></thead><tbody>" +
                docs + "</tbody></table></div>"
              : '<h4>Documentos posteriores</h4><p class="sin-datos">Esta OT todavía no tiene documentos asociados.</p>') +

        tablaRep(o.repuestos_actual, "Repuestos del vale actual", colsRep) +
        tablaRep(o.repuestos_historico, "Repuestos históricos", colsRep) +
        tablaRep(o.repuestos_compras, "Compras asociadas",
                 [["producto", "t", "Código"], ["descripcion", "t", "Descripción"],
                  ["cantidad", "num", "Cant."], ["costo_total", "money", "Costo"]]) +

        '<div class="ficha-coms"><h4>Comentarios <span class="n">(' + coms.length + ")</span></h4>" +
          (hilo ? "<ul>" + hilo + "</ul>" : '<p class="sin-datos">Sin comentarios todavía.</p>') +
          '<div class="com-nuevo"><textarea id="comTexto" rows="3" placeholder="Escribe un comentario para el equipo…"></textarea>' +
          '<button type="button" id="comEnviar">Agregar comentario</button></div>' +
        "</div>";

      $("comEnviar").addEventListener("click", function () { enviarComentario(folio); });
    }).catch(function (e) {
      $("fichaCont").innerHTML = '<p class="sin-datos">No se pudo cargar la OT: ' + esc(e.message || e) + "</p>";
    });
  }

  function enviarComentario(folio) {
    var ta = $("comTexto");
    var txt = ta.value.trim();
    if (!txt) { aviso("Escribe algo antes de agregar el comentario.", "warn"); ta.focus(); return; }
    var btn = $("comEnviar");
    btn.disabled = true;
    api("ots_comentarios", {
      method: "POST", prefer: "return=minimal",
      body: { folio_ot: folio, autor: ST.email, comentario: txt }
    }).then(function () {
      ST.comentarios[folio] = (ST.comentarios[folio] || 0) + 1;
      aviso("Comentario agregado.", "ok");
      abrirFicha(folio);
    }).catch(function (e) {
      btn.disabled = false;
      aviso("No se pudo guardar el comentario: " + (e.message || e), "error");
    });
  }

  /* ---------------- navegación ---------------- */
  function irA(v) {
    document.querySelectorAll(".tab").forEach(function (x) { x.classList.remove("active"); });
    document.querySelectorAll(".view").forEach(function (x) { x.classList.remove("active"); });
    var t = document.querySelector('.tab[data-v="' + v + '"]');
    if (t) t.classList.add("active");
    $("v-" + v).classList.add("active");
    // Los filtros mandan sobre Resumen y Detalle; en la ficha estorban.
    $("otsFiltros").hidden = (v === "ficha");
    render();
    window.scrollTo(0, 0);
  }

  /* ---------------- eventos ---------------- */
  function conectar() {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { irA(t.dataset.v); });
    });

    var timer = null;
    $("fBuscar").addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(aplicarFiltros, 200);
    });
    ["fSucursal", "fRango", "fTipoVenta", "fMarca", "fAsesor", "fCategoria",
     "fDocumento", "fDesde", "fHasta"].forEach(function (id) {
      $(id).addEventListener("change", aplicarFiltros);
    });

    $("fToggle").addEventListener("click", function () {
      var g = $("fGrid");
      g.hidden = !g.hidden;
      this.setAttribute("aria-expanded", String(!g.hidden));
      this.textContent = g.hidden ? "Más filtros" : "Ocultar filtros";
    });

    $("fLimpiar").addEventListener("click", function () {
      $("fBuscar").value = "";
      ["fSucursal", "fRango", "fTipoVenta", "fMarca", "fAsesor", "fCategoria", "fDocumento"]
        .forEach(function (id) {
          Array.prototype.forEach.call($(id).options, function (o) { o.selected = false; });
        });
      $("fDesde").value = ""; $("fHasta").value = "";
      aplicarFiltros();
    });

    $("btnMas").addEventListener("click", function () {
      ST.mostradas += PAGINA;
      renderTabla();
    });

    document.querySelectorAll(".th-ord").forEach(function (th) {
      th.addEventListener("click", function () {
        var col = th.dataset.ord;
        if (ST.orden.col === col) ST.orden.desc = !ST.orden.desc;
        else { ST.orden.col = col; ST.orden.desc = (col === "neto" || col === "dias_apertura"); }
        document.querySelectorAll(".th-ord").forEach(function (x) { x.classList.remove("ord-asc", "ord-desc"); });
        th.classList.add(ST.orden.desc ? "ord-desc" : "ord-asc");
        ordenar();
        renderTabla();
      });
    });

    // Edición inline: se guarda al salir del campo, y solo si cambió. Delegado
    // porque las filas se repintan; y con captura para que también agarre los
    // campos de la ficha, que se crean después.
    document.addEventListener("focusin", function (e) {
      if (e.target.classList && e.target.classList.contains("cel")) e.target.dataset.prev = e.target.value;
    });
    document.addEventListener("focusout", function (e) {
      var el = e.target;
      if (!el.classList || !el.classList.contains("cel")) return;
      var val = el.value.trim();
      if (val === (el.dataset.prev || "").trim()) return;
      el.classList.add("guardando");
      guardarGestion(el.dataset.folio, el.dataset.campo, val).then(function () {
        el.classList.remove("guardando");
        el.classList.add("guardado");
        setTimeout(function () { el.classList.remove("guardado"); }, 1500);
        el.dataset.prev = val;
        if (el.dataset.campo === "categoria" && val && ST.categorias.indexOf(val) < 0) {
          ST.categorias.push(val); ST.categorias.sort();
          $("catLista").innerHTML = ST.categorias.map(function (c) {
            return '<option value="' + esc(c) + '">';
          }).join("");
        }
      }).catch(function (err) {
        el.classList.remove("guardando");
        el.classList.add("error");
        el.value = el.dataset.prev || "";
        setTimeout(function () { el.classList.remove("error"); }, 3000);
        aviso("No se pudo guardar: " + (err.message || err), "error");
      });
    });

    // Enter confirma (dispara el blur) y Escape descarta.
    document.addEventListener("keydown", function (e) {
      if (!e.target.classList || !e.target.classList.contains("cel")) return;
      if (e.key === "Enter") e.target.blur();
      if (e.key === "Escape") { e.target.value = e.target.dataset.prev || ""; e.target.blur(); }
    });

    document.addEventListener("click", function (e) {
      var a = e.target.closest && e.target.closest(".folio-link");
      if (a) { e.preventDefault(); abrirFicha(a.dataset.folio); }
    });

    $("fichaVer").addEventListener("click", function () {
      var f = $("fichaFolio").value.trim();
      if (f) abrirFicha(f);
    });
    $("fichaFolio").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); $("fichaVer").click(); }
    });
  }

  /* ---------------- arranque ---------------- */
  function iniciar() {
    if (!CFG.url || !CFG.anonKey) {
      $("otsSub").textContent = "Falta la configuración de la base (js/agenda-config.js).";
      return;
    }
    var dl = document.createElement("datalist");
    dl.id = "catLista";
    document.body.appendChild(dl);

    cargarTodo().then(function () {
      $("catLista").innerHTML = ST.categorias.map(function (c) {
        return '<option value="' + esc(c) + '">';
      }).join("");
      poblarFiltros();
      conectar();
      var conGestion = Object.keys(ST.gestion).length;
      $("otsSub").textContent = ST.ots.length.toLocaleString("es-CL") + " órdenes pendientes · " +
        conGestion.toLocaleString("es-CL") + " con gestión registrada";
      aplicarFiltros();
      var q = new URLSearchParams(location.search).get("folio");
      if (q) abrirFicha(q);
    }).catch(function (e) {
      $("otsSub").textContent = "No se pudieron cargar las OT: " + (e.message || e);
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();
})();
