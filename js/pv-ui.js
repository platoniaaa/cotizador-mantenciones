/* ============================================================
   Post Venta — piezas de interfaz que usan todas las pantallas.

   Están acá y no repetidas en cada módulo porque son las mismas en todos:
   tarjetas de indicador, tablas con orden y filtro, exportar a Excel y
   formatos de número y fecha. Si una tabla se comporta raro, se arregla en un
   solo lugar.
   ============================================================ */
(function () {
  "use strict";

  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  };

  /* ---------- números y fechas ----------
     Los montos vienen del consolidador como texto en formato chileno
     ("1.234.567"). Con Number() eso da NaN —el punto se lee como decimal— y
     la columna Neto salía toda en "—" justo en los montos grandes. Por eso
     todo pasa primero por numero(). */
  function _n(v) {
    if (typeof v === "number") return isFinite(v) ? v : null;
    if (v == null || String(v).trim() === "") return null;
    var n = numero(v);
    return isFinite(n) ? n : null;
  }
  function miles(n) {
    var v = _n(n);
    if (v === null) return "—";
    return v.toLocaleString("es-CL", { maximumFractionDigits: 0 });
  }
  function pesos(n) {
    var v = _n(n);
    if (v === null) return "—";
    return "$" + v.toLocaleString("es-CL", { maximumFractionDigits: 0 });
  }
  function decimal(n, d) {
    var v = _n(n);
    if (v === null) return "—";
    return v.toLocaleString("es-CL", { minimumFractionDigits: d == null ? 1 : d,
                                       maximumFractionDigits: d == null ? 1 : d });
  }
  /* "dd/mm/aaaa" -> Date. Es el formato en que la app antigua guarda TODO;
     Date.parse() lo interpreta al revés (mes/día) y da fechas equivocadas. */
  function aFecha(txt) {
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(txt || "").trim());
    if (!m) return null;
    return new Date(+m[3], +m[2] - 1, +m[1]);
  }
  /* Para ordenar por fecha sin convertir a Date en cada comparación. */
  function fechaOrden(txt) {
    var d = aFecha(txt);
    return d ? d.getTime() : -Infinity;
  }
  function numero(v) {
    if (typeof v === "number") return v;
    var s = String(v == null ? "" : v).replace(/\./g, "").replace(/,/g, ".").replace(/[^\d.\-]/g, "");
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  /* ---------- tarjetas de indicador ---------- */
  function kpis(lista) {
    return '<div class="pv-kpis">' + lista.map(function (k) {
      return '<div class="pv-kpi' + (k.cls ? " " + k.cls : "") + '">' +
             '<h5>' + esc(k.t) + "</h5>" +
             '<div class="pv-kpi__v">' + esc(k.v) + "</div>" +
             (k.sub ? '<div class="pv-kpi__s">' + esc(k.sub) + "</div>" : "") +
             "</div>";
    }).join("") + "</div>";
  }

  /* ---------- tabla ----------
     `cols`: [{k, t, tipo:'texto'|'num'|'pesos'|'fecha', ancho, celda(fila)}]
     Ordena al pinchar el encabezado y pagina, porque hay tablas de 4.000 filas
     y pintarlas enteras congela el navegador varios segundos. */
  function Tabla(destino, cols, opciones) {
    this.el = typeof destino === "string" ? document.getElementById(destino) : destino;
    this.cols = cols;
    this.op = opciones || {};
    this.filas = [];
    this.orden = this.op.orden || null;
    this.desc = !!this.op.desc;
    this.pagina = 0;
    this.porPagina = this.op.porPagina || 100;
    var self = this;
    this.el.addEventListener("click", function (e) {
      var th = e.target.closest("th[data-k]");
      if (th) { self._ordenar(th.dataset.k); return; }
      var mas = e.target.closest("[data-pv-mas]");
      if (mas) { self.pagina++; self.pintar(); return; }
      var tr = e.target.closest("tr[data-i]");
      if (tr && self.op.alPinchar) self.op.alPinchar(self.filas[+tr.dataset.i], tr);
    });
  }

  Tabla.prototype._tipo = function (k) {
    var c = this.cols.find(function (x) { return x.k === k; });
    return (c && c.tipo) || "texto";
  };

  Tabla.prototype._ordenar = function (k) {
    if (this.orden === k) this.desc = !this.desc;
    else { this.orden = k; this.desc = this._tipo(k) !== "texto"; }
    this.pagina = 0;
    this.pintar();
  };

  Tabla.prototype.datos = function (filas) {
    this.filas = filas || [];
    this.pagina = 0;
    return this;
  };

  Tabla.prototype._ordenadas = function () {
    if (!this.orden) return this.filas;
    var k = this.orden, tipo = this._tipo(k), signo = this.desc ? -1 : 1;
    var val = tipo === "fecha" ? function (f) { return fechaOrden(f[k]); }
            : (tipo === "num" || tipo === "pesos") ? function (f) { return numero(f[k]); }
            : function (f) { return String(f[k] == null ? "" : f[k]).toLowerCase(); };
    return this.filas.slice().sort(function (a, b) {
      var x = val(a), y = val(b);
      return x < y ? -signo : x > y ? signo : 0;
    });
  };

  Tabla.prototype.pintar = function () {
    var self = this;
    var orden = this._ordenadas();
    var hasta = (this.pagina + 1) * this.porPagina;
    var visibles = orden.slice(0, hasta);

    var thead = "<thead><tr>" + this.cols.map(function (c) {
      var flecha = self.orden === c.k ? (self.desc ? " ↓" : " ↑") : "";
      return '<th data-k="' + esc(c.k) + '"' + (c.ancho ? ' style="width:' + c.ancho + '"' : "") +
             (c.tipo === "num" || c.tipo === "pesos" ? ' class="num"' : "") +
             ">" + esc(c.t) + flecha + "</th>";
    }).join("") + "</tr></thead>";

    var cuerpo = visibles.map(function (f, i) {
      var idx = orden.indexOf(f);
      return '<tr data-i="' + idx + '">' + self.cols.map(function (c) {
        if (c.celda) return "<td" + (c.tipo === "num" || c.tipo === "pesos" ? ' class="num"' : "") + ">" + c.celda(f) + "</td>";
        var v = f[c.k];
        var txt = c.tipo === "pesos" ? pesos(v)
                : c.tipo === "num" ? miles(v)
                : (v == null || v === "" ? "—" : esc(v));
        return "<td" + (c.tipo === "num" || c.tipo === "pesos" ? ' class="num"' : "") + ">" + txt + "</td>";
      }).join("") + "</tr>";
    }).join("");

    if (!orden.length) {
      cuerpo = '<tr><td colspan="' + this.cols.length + '" class="pv-vacio">' +
               esc(this.op.vacio || "Sin resultados con estos filtros.") + "</td></tr>";
    }

    var pie = "";
    if (orden.length > hasta) {
      pie = '<div class="pv-mas"><button type="button" data-pv-mas>Ver ' +
            Math.min(this.porPagina, orden.length - hasta) + " más</button>" +
            '<span>' + miles(hasta) + " de " + miles(orden.length) + "</span></div>";
    } else if (orden.length) {
      pie = '<div class="pv-mas"><span>' + miles(orden.length) + " fila" +
            (orden.length === 1 ? "" : "s") + "</span></div>";
    }

    this.el.innerHTML = '<div class="pv-tabla-scroll"><table class="pv-tabla">' +
                        thead + "<tbody>" + cuerpo + "</tbody></table></div>" + pie;
    return this;
  };

  /* ---------- exportar a Excel ----------
     Sin librerías: un archivo .xls en HTML, que Excel abre sin reclamar. Es lo
     mismo que hacía la app antigua con openpyxl, pero sin servidor. */
  function aExcel(nombre, cols, filas) {
    var cab = "<tr>" + cols.map(function (c) { return "<th>" + esc(c.t) + "</th>"; }).join("") + "</tr>";
    var cuerpo = filas.map(function (f) {
      return "<tr>" + cols.map(function (c) {
        var v = f[c.k];
        return "<td>" + esc(v == null ? "" : v) + "</td>";
      }).join("") + "</tr>";
    }).join("");
    var html = '<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head>' +
               '<meta charset="utf-8"></head><body><table border="1">' +
               cab + cuerpo + "</table></body></html>";
    var blob = new Blob(["﻿", html], { type: "application/vnd.ms-excel" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = nombre + ".xls";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- filtros ---------- */
  function opciones(filas, campo) {
    var vistos = {};
    filas.forEach(function (f) {
      var v = String(f[campo] == null ? "" : f[campo]).trim();
      if (v) vistos[v] = true;
    });
    return Object.keys(vistos).sort(function (a, b) { return a.localeCompare(b, "es"); });
  }

  function selector(id, etiqueta, valores, todos) {
    return '<label class="pv-f"><span>' + esc(etiqueta) + "</span>" +
           '<select id="' + esc(id) + '"><option value="">' + esc(todos || "Todas") + "</option>" +
           valores.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + "</option>"; }).join("") +
           "</select></label>";
  }

  function buscador(id, marcador) {
    return '<label class="pv-f pv-f--busca"><span>Buscar</span>' +
           '<input id="' + esc(id) + '" type="search" placeholder="' + esc(marcador || "patente, cliente, folio…") + '"></label>';
  }

  /* Aplica los filtros de una barra a una lista. `mapa` es {idDelControl: campo}
     y el buscador revisa TODOS los campos de texto de la fila. */
  function filtrar(filas, mapa, idBuscador) {
    var texto = idBuscador && document.getElementById(idBuscador)
              ? document.getElementById(idBuscador).value.trim().toLowerCase() : "";
    var pares = Object.keys(mapa).map(function (id) {
      var el = document.getElementById(id);
      return [mapa[id], el ? el.value : ""];
    }).filter(function (p) { return p[1]; });

    return filas.filter(function (f) {
      for (var i = 0; i < pares.length; i++) {
        if (String(f[pares[i][0]] == null ? "" : f[pares[i][0]]).trim() !== pares[i][1]) return false;
      }
      if (!texto) return true;
      for (var k in f) {
        if (typeof f[k] === "string" && f[k].toLowerCase().indexOf(texto) !== -1) return true;
        if (typeof f[k] === "number" && String(f[k]).indexOf(texto) !== -1) return true;
      }
      return false;
    });
  }

  /* ---------- avisos ---------- */
  var _t = null;
  function aviso(txt, tipo) {
    var el = document.getElementById("pvAviso");
    if (!el) return;
    el.textContent = txt;
    el.className = "pv-aviso" + (tipo ? " pv-aviso--" + tipo : "");
    el.hidden = false;
    clearTimeout(_t);
    if (tipo !== "error") _t = setTimeout(function () { el.hidden = true; }, 6000);
  }

  function cargando(destino, texto) {
    var el = typeof destino === "string" ? document.getElementById(destino) : destino;
    el.innerHTML = '<div class="pv-cargando"><span class="pv-spin"></span>' +
                   esc(texto || "Cargando…") + "</div>";
  }

  function error(destino, e) {
    var el = typeof destino === "string" ? document.getElementById(destino) : destino;
    var m = (e && e.message) || String(e);
    var ayuda = /sin sesión|sin_permiso/i.test(m)
      ? "Vuelve a entrar con tu correo @curifor.com."
      : "Revisa tu conexión y recarga la página.";
    el.innerHTML = '<div class="pv-error"><b>No se pudieron cargar los datos.</b>' +
                   "<p>" + esc(m) + "</p><p>" + esc(ayuda) + "</p></div>";
  }

  window.PVUI = {
    esc: esc, miles: miles, pesos: pesos, decimal: decimal,
    aFecha: aFecha, fechaOrden: fechaOrden, numero: numero,
    kpis: kpis, Tabla: Tabla, aExcel: aExcel,
    opciones: opciones, selector: selector, buscador: buscador, filtrar: filtrar,
    aviso: aviso, cargando: cargando, error: error
  };
})();
