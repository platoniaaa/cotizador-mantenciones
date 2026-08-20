/* ============================================================
   Condiciones generales del acta de recepción.

   Van en un archivo propio y no dentro del generador del PDF porque son texto
   LEGAL: lo revisa y lo corrige gente que no toca código, y tiene que poder
   editarse sin entrar a la lógica de dibujo.

   VERSION es lo importante de acá. Si mañana Legal cambia una cláusula, hay
   que poder responder qué texto firmó un cliente en agosto: la versión se
   imprime en el acta y se guarda con la recepción. Al cambiar cualquier
   cláusula, súbele la versión.

   Las once cláusulas son las que Curifor ya usa en sus órdenes de trabajo
   (ver OT 1196355), transcritas tal cual. No se reescribieron ni se
   "mejoraron": cambiarle una palabra a un texto legal vigente no es una
   decisión de programación.
   ============================================================ */
(function () {
  "use strict";

  window.ActaCondiciones = {
    version: "2026-08.2",

    titulo: "Condiciones generales de la recepción y reparación de vehículos",

    generales: [
      "CURIFOR S.A., no se responsabiliza por objetos no declarados en recepción y debidamente consignados en esta Orden de Trabajo.",
      "CURIFOR S.A., no se hace responsable por daños causados por incendio, sismos u otras causas de fuerza mayor durante la permanencia del vehículo en el local.",
      "El cliente acepta que CURIFOR S.A., no será responsable de los daños no visibles que pueda tener el vehículo al momento de su recepción en el taller, ni de los defectos de la reparación que sean consecuentes de aquellos.",
      "El cliente acepta que en los trabajos contratados, CURIFOR S.A. aplicará las normas estándares establecidas en los manuales del fabricante, las que pueden ser previamente consultadas por el cliente.",
      "El cliente se compromete a pagar los trabajos expresados en la presente Recepción ST y por aquellos que autorice incluso verbalmente.",
      "CURIFOR S.A. es extraño a toda desaveniencia cualquiera que sea, que pueda sobrevenir entre una Compañía de Seguros y el cliente que haya ordenado una reparación a su vehículo por causa de un accidente. En todo caso el propietario del vehículo es el único responsable del pago integral de las reparaciones frente a CURIFOR S.A.",
      "Las piezas cuyo reemplazo fue pagado por el cliente, están a su disposición en el momento de entrega mandatado. Las piezas no reclamadas en el momento de la entrega son destruidas y por lo tanto, no se puede tomar en consideración ninguna reclamación posterior. No se podrán imputar al costo de la reparación parte alguna del valor de las piezas reemplazadas.",
      "El cliente deberá retirar el vehículo en un plazo máximo de tres días desde que se notifica que los trabajos fueron realizados, pasado el cual CURIFOR S.A. se reserva el derecho de cobrar estacionamiento a precio de mercado.",
      "En caso de que el vehículo fuere retirado por terceras personas, ajenas al dueño o quien ordenó su reparación, o alguna acción de índole judicial, el cliente deberá pagar a CURIFOR S.A. el total de la reparación a la época de entrega y/o retiro.",
      "El cliente autoriza a CURIFOR S.A. a efectuar las reparaciones indicadas al reverso, el uso de materiales y el reemplazo de repuestos que sea necesario, si al realizar el trabajo se constatan defectos no visibles en el momento de extender esta orden de trabajo, autorizo efectuar los trabajos de reparación pertinentes, responsabilizándome de mayores costos.",
      "Autorizo a CURIFOR S.A. a trasladar mi vehículo entre sucursales, prestadores de servicio externo, prueba de ruta, para un fiel cumplimiento del encargo."
    ],

    /* ---- datos personales ----
       Separado de las once cláusulas a propósito: es materia distinta, es
       nuevo, y conviene que se vea como un bloque aparte y no como una
       cláusula más escondida entre las otras.

       Las comunicaciones DEL SERVICIO (avisos del estado de esta OT) y las
       COMERCIALES van separadas. Las primeras son necesarias para prestar el
       servicio que el cliente vino a contratar; las segundas requieren una
       autorización voluntaria, que se pide aparte y se puede revocar. Meterlas
       en un solo "acepto todo" es lo que después vuelve la autorización
       discutible. */
    datosTitulo: "Tratamiento de datos personales",
    datos: [
      "Curifor S.A., RUT 92.909.000-4, trata los datos personales del cliente —nombre, RUT, teléfono, correo electrónico, dirección y los datos de su vehículo— para gestionar la recepción, reparación y entrega del vehículo, emitir los documentos tributarios que correspondan y comunicarse con el cliente sobre el estado de esta Orden de Trabajo. Esas comunicaciones pueden hacerse por llamada telefónica, mensaje de texto, correo electrónico o WhatsApp, al teléfono y al correo registrados en este documento.",
      "Los datos se conservan mientras dure la relación comercial y por los plazos que exija la normativa aplicable. No se entregan a terceros, salvo a los prestadores necesarios para ejecutar el servicio (por ejemplo, talleres externos o servicios de traslado) y a quienes la ley obligue.",
      "El cliente puede pedir en cualquier momento acceder a sus datos, rectificarlos, cancelarlos u oponerse a su tratamiento, y revocar la autorización comercial, escribiendo a postventa@curifor.com. El tratamiento se rige por la Ley N° 19.628 sobre Protección de la Vida Privada y, desde su entrada en vigencia, por la Ley N° 21.719."
    ],

    /* El texto que se imprime junto al SÍ/NO que marcó el asesor. Dice que es
       voluntaria y que no condiciona el servicio, porque de eso depende que la
       autorización valga algo. */
    comercialEtiqueta: "Comunicaciones comerciales",
    comercialSi: "AUTORIZA el envío de ofertas, promociones y recordatorios de mantención por WhatsApp, correo o teléfono.",
    comercialNo: "NO autoriza el envío de ofertas, promociones ni recordatorios comerciales.",
    comercialNota: "Autorización voluntaria: no condiciona la atención ni el servicio, y puede revocarse en cualquier momento escribiendo a postventa@curifor.com."
  };
})();
