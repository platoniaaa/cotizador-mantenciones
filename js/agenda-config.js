/* ============================================================
   Agenda web — configuración de Supabase (un solo lugar).
   La usan cliente.html (el cliente INSERTA su reserva) y
   taller.html (el personal LEE las reservas con su login).

   La clave "anon" es pública por diseño: con las políticas RLS
   de herramientas/setup_supabase_reservas.sql solo permite
   insertar reservas, nunca leerlas ni modificarlas.

   Mientras url/anonKey estén vacíos, el botón "Agendar hora"
   no aparece en la vista cliente ni en el taller.
   ============================================================ */
window.CURIFOR_AGENDA = {
  url: "",      // p. ej. "https://abcdefghijkl.supabase.co"
  anonKey: "",  // Supabase → Settings → API → anon public
  tabla: "reservas_web",
};
