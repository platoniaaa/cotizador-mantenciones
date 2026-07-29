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
  url: "https://ordgsglujssgzmnlmcus.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yZGdzZ2x1anNzZ3ptbmxtY3VzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUzMzM4NTgsImV4cCI6MjEwMDkwOTg1OH0.n15xGwipVso0hRC9_LuWfFEe34eP9O1J1NC4LlenwUM",
  tabla: "reservas_web",
};
