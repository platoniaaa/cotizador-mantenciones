/* ============================================================
   Servicios, sucursales y asesores del agendamiento.

   Este archivo es CONFIGURACIÓN DE NEGOCIO, no lógica. Lo edita quien sabe
   qué hace cada taller, sin tocar el resto del código.

   Existe porque tres reglas del flujo nuevo no se pueden deducir de ninguna
   tabla actual:

     · qué servicios hace cada sucursal (no todas tienen cabina de pintura);
     · qué asesor atiende cada servicio en cada sucursal;
     · en qué horario atiende ese asesor.

   Mientras una sucursal no declare un servicio, no aparece cuando el cliente
   lo elige. Eso es a propósito: es preferible que falte una sucursal de la
   lista a que un cliente maneje 40 minutos hasta un taller que no puede
   atenderlo.

   OJO: `asesores` es solo para repartir la agenda. El cliente NUNCA elige
   asesor —la tendencia es marcar siempre el primero de la lista— y el nombre
   se le muestra recién al confirmar.
   ============================================================ */
(function () {
  "use strict";

  /* Los cuatro servicios que ve el cliente. La lista es corta a propósito:
     antes eran una decena y el cliente terminaba eligiendo mal. */
  var SERVICIOS = [
    {
      id: "mantencion",
      nombre: "Mantención por kilometraje",
      detalle: "La mantención programada que le toca a tu auto según sus kilómetros.",
      icono: "🔧",
      // la única que necesita la pauta para saber qué incluye y cuánto vale
      usaPauta: true,
      duracion: 60
    },
    {
      id: "dip",
      nombre: "Desabolladura y pintura",
      detalle: "Golpes, rayones y trabajos de carrocería.",
      icono: "🎨",
      usaPauta: false,
      duracion: 90
    },
    {
      id: "diagnostico",
      nombre: "Diagnóstico técnico",
      detalle: "Un ruido, una luz encendida o algo que no anda bien.",
      icono: "🔍",
      usaPauta: false,
      duracion: 60
    },
    {
      id: "garantia",
      nombre: "Garantía",
      detalle: "Revisión de una falla cubierta por la garantía del fabricante.",
      icono: "🛡️",
      usaPauta: false,
      duracion: 60
    }
  ];

  /* ---------------------------------------------------------------
     SUCURSALES  ·  COMPLETAR CON EL DATO REAL

     `servicios` es la lista de ids que esa sucursal SÍ atiende.
     `marcas`    limita por marca cuando corresponde (garantía oficial, por
                 ejemplo). Vacío o ausente = atiende todas.

     Hoy están todas declaradas con los cuatro servicios porque nadie ha dicho
     lo contrario. Apenas se confirme qué taller hace qué, hay que sacar de la
     lista lo que no corresponda: es el único lugar donde se toca.
     --------------------------------------------------------------- */
  var SUCURSALES = [
    { id: "CURIFOR CHILLÁN",             nombre: "Chillán",          direccion: "Calle Brasil N° 954",
      servicios: ["mantencion", "dip", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR CHILLÁN VIEJO",       nombre: "Chillán Viejo",    direccion: "Carretera Panamericana Sur",
      servicios: ["mantencion", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR CURICÓ",              nombre: "Curicó",           direccion: "Ruta 5 km 186,5",
      servicios: ["mantencion", "dip", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR LINDEROS",            nombre: "Linderos",         direccion: "Ruta 5 Sur N° 3502",
      servicios: ["mantencion", "dip", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR LO BLANCO",           nombre: "Lo Blanco",        direccion: "Avenida Lo Blanco 2111, La Pintana",
      servicios: ["mantencion", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR MACUL (AUTO-PARK)",   nombre: "Macul",            direccion: "Av. Departamental 4400, Macul",
      servicios: ["mantencion", "diagnostico"], marcas: [] },
    { id: "CURIFOR PLACILLA",            nombre: "Placilla",         direccion: "Ruta 68 km 98,4",
      servicios: ["mantencion", "dip", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR RANCAGUA",            nombre: "Rancagua",         direccion: "Diego de Almagro 0455, Rancagua",
      servicios: ["mantencion", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR TALCA",               nombre: "Talca",            direccion: "Calle 1 Norte N° 2153",
      servicios: ["mantencion", "dip", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR TALCA BMW",           nombre: "Talca BMW",        direccion: "",
      servicios: ["mantencion", "diagnostico", "garantia"], marcas: [] },
    { id: "CURIFOR TALCA CAMIONES",      nombre: "Talca Camiones",   direccion: "Calle 1 Norte N° 2153",
      servicios: ["mantencion", "diagnostico"], marcas: [] },
    { id: "CURIFOR TALLER MOVIL",        nombre: "Taller Móvil",     direccion: "",
      servicios: ["mantencion"], marcas: [] }
  ];

  /* ---------------------------------------------------------------
     ASESORES  ·  COMPLETAR CON EL DATO REAL

     Quién atiende cada servicio en cada sucursal, y en qué horario. El cliente
     no los ve ni los elige: solo determinan qué bloques hay libres y quién
     queda asignado.

     `horario` son los bloques que ese asesor puede tomar. Vacío = usa el
     horario general del taller.

     Mientras un servicio no tenga asesor declarado en una sucursal, se reparte
     con el horario general y la asignación queda pendiente para el taller. No
     se bloquea el agendamiento por esto: perder una hora agendada es peor que
     asignar al asesor después.
     --------------------------------------------------------------- */
  var ASESORES = [
    // { correo: "asesor@curifor.com", sucursal: "CURIFOR CHILLÁN",
    //   servicios: ["mantencion", "diagnostico"], horario: ["09:00", "09:30", "10:00"] }
  ];

  /* Horario general del taller, cuando el asesor no declara el suyo. */
  var HORARIO = {
    manana: ["08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30", "12:00"],
    tarde:  ["14:30", "15:00", "15:30", "16:00", "16:30", "17:00"]
  };

  /* ---------- consultas ---------- */

  function servicio(id) {
    for (var i = 0; i < SERVICIOS.length; i++) if (SERVICIOS[i].id === id) return SERVICIOS[i];
    return null;
  }

  /* Las sucursales que atienden ese servicio para esa marca. Es el filtro que
     evita que el cliente elija un taller donde no lo pueden atender. */
  function sucursalesPara(servicioId, marca) {
    return SUCURSALES.filter(function (s) {
      if (s.servicios.indexOf(servicioId) < 0) return false;
      if (s.marcas && s.marcas.length && marca) {
        return s.marcas.some(function (m) {
          return String(m).toUpperCase() === String(marca).toUpperCase();
        });
      }
      return true;
    });
  }

  /* Los asesores que pueden tomar ese servicio en esa sucursal. */
  function asesoresPara(servicioId, sucursalId) {
    return ASESORES.filter(function (a) {
      return a.sucursal === sucursalId && (a.servicios || []).indexOf(servicioId) >= 0;
    });
  }

  /* Los bloques de hora que se le ofrecen al cliente. Si hay asesores
     declarados, es la unión de sus horarios; si no, el horario general. */
  function horasPara(servicioId, sucursalId) {
    var eq = asesoresPara(servicioId, sucursalId);
    if (!eq.length) return { manana: HORARIO.manana.slice(), tarde: HORARIO.tarde.slice() };
    var todas = {};
    eq.forEach(function (a) {
      (a.horario && a.horario.length ? a.horario : HORARIO.manana.concat(HORARIO.tarde))
        .forEach(function (h) { todas[h] = 1; });
    });
    var lista = Object.keys(todas).sort();
    return {
      manana: lista.filter(function (h) { return h < "13:00"; }),
      tarde:  lista.filter(function (h) { return h >= "13:00"; })
    };
  }

  /* A quién le toca. Reparte por carga para no cargarle todo al primero de la
     lista, que es exactamente lo que pasaría si eligiera el cliente.
     `ocupadas` son las horas ya tomadas ese día, por correo de asesor. */
  function asignarAsesor(servicioId, sucursalId, ocupadas) {
    var eq = asesoresPara(servicioId, sucursalId);
    if (!eq.length) return null;
    ocupadas = ocupadas || {};
    var elegido = eq[0], menos = Infinity;
    eq.forEach(function (a) {
      var carga = ocupadas[a.correo] || 0;
      if (carga < menos) { menos = carga; elegido = a; }
    });
    return elegido;
  }

  window.AgendaServicios = {
    SERVICIOS: SERVICIOS,
    SUCURSALES: SUCURSALES,
    HORARIO: HORARIO,
    servicio: servicio,
    sucursalesPara: sucursalesPara,
    asesoresPara: asesoresPara,
    horasPara: horasPara,
    asignarAsesor: asignarAsesor
  };
})();
