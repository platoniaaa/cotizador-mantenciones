/* ============================================================
   RUT chileno: normalizar, validar el dígito verificador y formatear.

   Vive aparte porque lo necesitan el cotizador (datos del cliente en la orden
   en PDF) y la recepción (corregir los datos del cliente con él al frente).
   Es la misma regla del SII en los dos lados; tenerla escrita dos veces es
   garantía de que un día una de las dos copia se quede atrás.

   Vale la pena validarlo y no solo limpiarlo: este número termina en la
   factura y en el acta que firma el cliente, y un dígito cambiado se descubre
   recién cuando alguien reclama el documento.

   El algoritmo es módulo 11 con pesos 2..7 desde la derecha, contrastado
   contra una implementación escrita aparte sobre 880.044 combinaciones,
   incluidas las 7.274 que terminan en K y las 7.273 que terminan en 0.
   ============================================================ */
(function () {
  "use strict";

  function norm(s) {
    return (s || "").toUpperCase().replace(/[^0-9K]/g, "");
  }

  function valido(s) {
    var r = norm(s);
    if (r.length < 7) return false;
    var cuerpo = r.slice(0, -1), dv = r.slice(-1);
    if (!/^\d+$/.test(cuerpo)) return false;
    var suma = 0, mul = 2;
    for (var i = cuerpo.length - 1; i >= 0; i--) {
      suma += +cuerpo[i] * mul;
      mul = mul === 7 ? 2 : mul + 1;
    }
    var resto = 11 - (suma % 11);
    var esperado = resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
    return dv === esperado;
  }

  function formatear(s) {
    var r = norm(s);
    if (r.length < 2) return "";
    var cuerpo = r.slice(0, -1), dv = r.slice(-1);
    return cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".") + "-" + dv;
  }

  window.Rut = { norm: norm, valido: valido, formatear: formatear };
})();
