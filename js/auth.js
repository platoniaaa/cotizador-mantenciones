/* ============================================================
   Autenticación del personal interno · Curifor
   Login/registro contra Supabase Auth. Protege las páginas
   internas (index.html cotizador, taller.html) con un guard.

   Reglas:
   · solo se registran correos @curifor.com (se valida acá y,
     lo importante, la base solo entrega las reservas a tokens
     con ese dominio — ver RLS en setup_supabase_reservas.sql).
   · el guard NO corre cuando la página va embebida en un iframe
     (el cotizador dentro de la app Streamlit de Curifor ya tiene
     su propio login): así no se rompe esa integración.
   · la sesión se comparte con la bandeja de reservas del taller
     (misma clave localStorage), así el asesor no loguea dos veces.

   Config (url + anonKey) en js/agenda-config.js.
   ============================================================ */
(function () {
  "use strict";

  var CFG = window.CURIFOR_AGENDA || {};
  var SESKEY = "curiforTallerWebSes_v1";   // misma clave que usa taller.js
  // Dominios del personal. El segundo es el dominio por defecto del tenant de
  // Microsoft de Curifor: hay gente cuya cuenta quedó ahí y sin esto no podía
  // ni registrarse. Ambos son de Curifor; nadie externo obtiene una dirección.
  // La barrera REAL es la misma lista en la base (es_personal_curifor(), ver
  // herramientas/setup_supabase_dominios.sql). Esto es solo para avisar antes
  // de mandar el formulario; si se cambia acá, hay que cambiarlo allá.
  var DOMINIOS = ["@curifor.com", "@curifor.onmicrosoft.com"];
  var DOMINIO = DOMINIOS[0];   // el que se muestra en los mensajes
  var embebido = window.top !== window.self;   // dentro de un iframe

  function cfgOk() { return !!(CFG.url && CFG.anonKey); }

  // ---- sesión en localStorage ----
  function sesGuardada() {
    try { return JSON.parse(localStorage.getItem(SESKEY) || "null"); } catch (e) { return null; }
  }
  function guardarSes(s) {
    try { s ? localStorage.setItem(SESKEY, JSON.stringify(s)) : localStorage.removeItem(SESKEY); }
    catch (e) { /* sin espacio */ }
  }

  function guardarDesdeToken(j) {
    var s = {
      access: j.access_token,
      refresh: j.refresh_token,
      exp: j.expires_at || (Date.now() / 1000 + (j.expires_in || 3600)),
      email: (j.user && j.user.email) || ""
    };
    guardarSes(s);
    return s;
  }

  // ---- llamadas a Supabase Auth ----
  function authPost(grant, body) {
    return fetch(CFG.url + "/auth/v1/token?grant_type=" + grant, {
      method: "POST",
      headers: { apikey: CFG.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (j) { return r.ok ? j : Promise.reject(j); });
    });
  }

  function login(email, password) {
    return authPost("password", { email: email, password: password }).then(guardarDesdeToken);
  }

  function registrar(nombre, email, password) {
    return fetch(CFG.url + "/auth/v1/signup", {
      method: "POST",
      headers: { apikey: CFG.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: email, password: password,
        data: { nombre: nombre }   // queda en user_metadata
      })
    }).then(function (r) {
      return r.json().then(function (j) { return r.ok ? j : Promise.reject(j); });
    });
  }

  // sesión vigente (refresca si está por vencer) o null
  function sesion() {
    var s = sesGuardada();
    if (!s || !s.refresh) return Promise.resolve(null);
    if (s.exp - 60 > Date.now() / 1000) return Promise.resolve(s);
    return authPost("refresh_token", { refresh_token: s.refresh })
      .then(guardarDesdeToken)
      .catch(function () { guardarSes(null); return null; });
  }

  function logout() {
    guardarSes(null);
    location.href = "login.html";
  }

  function dominioOk(email) {
    var e = String(email || "").trim().toLowerCase();
    return DOMINIOS.some(function (d) { return e.slice(-d.length) === d; });
  }

  function onReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  // ---- guard de página ----
  // Corre desde el <head>: si no hay sesión guardada redirige de inmediato
  // (antes de pintar el body → sin parpadeo). Si la hay, valida/refresca y
  // muestra el usuario cuando el DOM esté listo. Se salta en modo embebido.
  function guard() {
    if (embebido || !cfgOk()) return;              // iframe o sin backend → no molesta
    var s = sesGuardada();
    if (!s || !s.refresh) { irALogin(); return; }  // redirect sincrónico, sin tocar el DOM
    onReady(function () {
      sesion().then(function (v) { if (!v) irALogin(); else pintarUsuario(v.email); });
    });
  }

  function irALogin() {
    var actual = location.pathname.split("/").pop() + location.search;
    location.replace("login.html?next=" + encodeURIComponent(actual || "index.html"));
  }

  // muestra "correo · Salir" donde haya un #authUser; si no, un badge fijo
  function pintarUsuario(email) {
    var cont = document.getElementById("authUser");
    if (!cont) {
      cont = document.createElement("div");
      cont.id = "authUser";
      cont.style.cssText = "position:fixed;top:8px;right:10px;z-index:9999;font:600 12px/1 'Segoe UI',system-ui,sans-serif;color:#001b6c;background:#eef2fb;border:1px solid #d3ddf4;border-radius:999px;padding:6px 10px;display:flex;gap:8px;align-items:center";
      document.body.appendChild(cont);
    }
    cont.innerHTML = '<span title="' + email + '">' + (email || "sesión") + "</span>" +
      '<a href="#" id="authSalir" style="color:#b42318;text-decoration:none;font-weight:700">Salir</a>';
    var a = document.getElementById("authSalir");
    if (a) a.addEventListener("click", function (e) { e.preventDefault(); logout(); });
  }

  window.CURIFOR_AUTH = {
    login: login, registrar: registrar, sesion: sesion, logout: logout,
    dominioOk: dominioOk, dominio: DOMINIO, dominios: DOMINIOS, cfgOk: cfgOk, guard: guard,
    pintarUsuario: pintarUsuario
  };

  // auto-guard en páginas marcadas con <html data-auth="require">
  if (document.documentElement.getAttribute("data-auth") === "require") guard();
})();
