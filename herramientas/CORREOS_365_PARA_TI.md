# Encender los correos de la agenda por Microsoft 365

Para: equipo de TI Curifor
Qué es: la agenda web manda 3 correos automáticos al cliente (al agendar, 7 días
antes y 24 horas antes). El código ya está listo. Falta lo que solo TI puede hacer:
registrar una aplicación en Entra y entregar 3 datos.

El correo sale desde **serviciotecnico@curifor.com**. **No se tocan registros DNS**:
el dominio curifor.com ya está autenticado en Microsoft 365.

---

## Paso A · Registrar la aplicación en Entra ID (Azure AD)

1. Entra ID → **App registrations** → **New registration**.
   - Nombre: `Curifor Agenda - Correos` (o el que prefieran).
   - Cuentas: solo este directorio organizacional.
   - Sin Redirect URI (no aplica, es de servidor a servidor).
2. En la app creada → **API permissions** → **Add a permission** →
   **Microsoft Graph** → **Application permissions** → buscar y marcar **Mail.Send**.
3. Botón **Grant admin consent** (lo hace un administrador). Debe quedar en verde.
4. **Certificates & secrets** → **New client secret** → copiar el **Value**
   (se ve una sola vez).

De ahí salen los 3 datos:
- **Directory (tenant) ID** — está en la portada de la app (Overview).
- **Application (client) ID** — también en Overview.
- **Client secret** — el Value del punto 4.

## Paso B · Acotar la app a UNA sola casilla (importante)

Por defecto, una app con Mail.Send puede enviar **como cualquier buzón** del tenant.
Hay que limitarla a serviciotecnico@curifor.com con una **Application Access Policy**
(PowerShell, módulo ExchangeOnlineManagement):

```powershell
Connect-ExchangeOnline
New-ApplicationAccessPolicy -AppId <APPLICATION_CLIENT_ID> `
  -PolicyScopeGroupId serviciotecnico@curifor.com `
  -AccessRight RestrictAccess `
  -Description "Agenda Curifor: solo enviar como serviciotecnico"
# comprobar:
Test-ApplicationAccessPolicy -Identity serviciotecnico@curifor.com -AppId <APPLICATION_CLIENT_ID>
```

Con esto, aunque la credencial se filtrara, solo podría enviar desde esa casilla,
nunca en nombre de gerencia u otra persona.

---

## Paso C · Desplegar la función de envío (lo hace el equipo de la plataforma)

Con los 3 datos de arriba, en el proyecto Supabase:

```bash
supabase functions deploy curifor-correo --no-verify-jwt

supabase secrets set \
  MS_TENANT_ID=<tenant_id> \
  MS_CLIENT_ID=<client_id> \
  MS_CLIENT_SECRET=<client_secret> \
  MS_SENDER=serviciotecnico@curifor.com \
  FUNC_SECRET=<generar uno largo y aleatorio>
```

Y en la base (SQL), dejar dos secretos en Vault para que el motor encuentre la función:

```sql
select vault.create_secret(
  'https://<PROJECT_REF>.supabase.co/functions/v1/curifor-correo',
  'CURIFOR_CORREO_URL');
select vault.create_secret('<el mismo FUNC_SECRET de arriba>', 'CURIFOR_FUNC_SECRET');
```

## Paso D · Probar y encender

```sql
-- 1) probar el tubo completo (base → función → Microsoft):
select public.avisos_probar_correo('correo-de-prueba@curifor.com');
-- 2) segundos después, ver cómo le fue:
select status_code, content from net._http_response order by id desc limit 1;
--    202/200 = enviado. Revisar la bandeja de la casilla de prueba.

-- 3) si llegó, encender:
update public.avisos_config set proveedor = 'graph', activo = true;
```

El motor (pg_cron) ya corre solo cada 5 minutos. Desde que `activo = true`, los
correos empiezan a salir con cada nueva reserva. Para apagar todo sin desinstalar
nada: `update public.avisos_config set activo = false;`

---

## Resumen de lo que TI entrega

| Dato | De dónde sale |
|---|---|
| Directory (tenant) ID | Entra → la app → Overview |
| Application (client) ID | Entra → la app → Overview |
| Client secret | Entra → la app → Certificates & secrets |
| Application Access Policy aplicada | Paso B (PowerShell) |

Nada de esto toca el correo normal de la empresa ni el ERP. Es una casilla de
envío acotada y un permiso de una sola cosa (enviar correo).
