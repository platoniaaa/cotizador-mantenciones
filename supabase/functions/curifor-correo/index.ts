// ============================================================
//  curifor-correo · Edge Function (Deno)
//
//  Envía un correo por Microsoft 365 usando Microsoft Graph.
//
//  POR QUÉ EXISTE ESTA FUNCIÓN
//  ---------------------------
//  El motor de avisos vive en Postgres y llama con pg_net, que SOLO sabe
//  mandar cuerpo JSON. El login de Microsoft (OAuth) exige el cuerpo en
//  formato form-urlencoded y rechaza JSON. Son incompatibles. Esta función
//  es el puente: Postgres le habla JSON, y ella le habla a Microsoft en el
//  formato que Microsoft exige.
//
//  SEGURIDAD
//  ---------
//  · El client_secret de Microsoft vive SOLO en las variables de la función,
//    nunca en la base ni en el repo.
//  · Se despliega con --no-verify-jwt y se protege con un secreto propio
//    (FUNC_SECRET) que Postgres manda en el header x-curifor-secret. Si se
//    filtrara, lo único que permite es pedirle a esta función que mande un
//    correo desde la casilla fija: no da ningún otro acceso.
//
//  VARIABLES (Supabase → Edge Functions → Secrets):
//    MS_TENANT_ID      id del directorio (Entra)
//    MS_CLIENT_ID      id de la aplicación registrada
//    MS_CLIENT_SECRET  secreto de la aplicación
//    MS_SENDER         casilla remitente (serviciotecnico@curifor.com)
//    FUNC_SECRET       secreto compartido con Postgres (largo y aleatorio)
//
//  Desplegar:  supabase functions deploy curifor-correo --no-verify-jwt
// ============================================================

interface Payload {
  to: string;
  toName?: string;
  subject: string;
  html: string;
}

const TENANT      = Deno.env.get("MS_TENANT_ID") ?? "";
const CLIENT      = Deno.env.get("MS_CLIENT_ID") ?? "";
const SECRET      = Deno.env.get("MS_CLIENT_SECRET") ?? "";
const SENDER      = Deno.env.get("MS_SENDER") ?? "";
const FUNC_SECRET = Deno.env.get("FUNC_SECRET") ?? "";

// Token cacheado en el isolate: mientras la función siga "caliente", se reusa
// y no se pide uno nuevo a Microsoft en cada correo.
let cachedToken: string | null = null;
let cachedExp = 0;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedExp - 60_000) return cachedToken;

  const body = new URLSearchParams({
    client_id: CLIENT,
    client_secret: SECRET,
    scope: "https://graph.microsoft.com/.default",
    grant_type: "client_credentials",
  });

  const r = await fetch(
    `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
  );

  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`token ${r.status}: ${j.error ?? "?"} ${j.error_description ?? ""}`.slice(0, 300));
  }
  cachedToken = j.access_token as string;
  cachedExp = now + ((j.expires_in ?? 3600) as number) * 1000;
  return cachedToken;
}

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);

  // Puerta: solo Postgres, que conoce el secreto.
  if (!FUNC_SECRET || req.headers.get("x-curifor-secret") !== FUNC_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  // Config incompleta: mejor decirlo claro que fallar oscuro.
  if (!TENANT || !CLIENT || !SECRET || !SENDER) {
    return json({ ok: false, error: "faltan variables MS_* en la función" }, 500);
  }

  let p: Payload;
  try {
    p = await req.json();
  } catch {
    return json({ ok: false, error: "cuerpo no es JSON" }, 400);
  }
  if (!p.to || !p.subject || !p.html) {
    return json({ ok: false, error: "faltan campos to/subject/html" }, 400);
  }

  try {
    const token = await getToken();
    const msg = {
      message: {
        subject: p.subject,
        body: { contentType: "HTML", content: p.html },
        toRecipients: [{ emailAddress: { address: p.to, name: p.toName ?? p.to } }],
      },
      saveToSentItems: true,
    };

    const g = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(msg),
      },
    );

    // sendMail responde 202 Accepted sin cuerpo cuando encoló el correo.
    if (g.status === 202) return json({ ok: true });

    const t = await g.text().catch(() => "");
    return json({ ok: false, error: `graph ${g.status}: ${t.slice(0, 300)}` }, 502);
  } catch (e) {
    return json({ ok: false, error: String(e).slice(0, 300) }, 502);
  }
});
