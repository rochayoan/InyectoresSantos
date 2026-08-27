# InyectoresSantos

Servicio mínimo de respuestas predeterminadas para WhatsApp Business mediante Kapso.

## Qué hace

- Responde solo cuatro tipos de consulta: servicios, horarios, ubicación e información general.
- No usa OpenAI ni revela o menciona inteligencia artificial.
- Si no reconoce la consulta, no responde nada.
- Cuando el dueño escribe manualmente desde WhatsApp Business, pausa solo ese chat por 30 minutos.
- Cada nuevo mensaje manual del dueño reinicia los 30 minutos.
- Los mensajes enviados por el propio sistema (`cloud_api`) no activan la pausa.
- No incluye dashboard, pedidos, pagos, Telegram ni memoria de conversación.

## Antes de desplegar

1. Editar `src/config/business.ts` con los cuatro textos exactos del dueño.
2. Crear un proyecto Supabase exclusivo y ejecutar `supabase/migrations/0001_initial.sql`.
3. Crear el proyecto en Vercel y copiar las variables de `.env.example`.
4. Mantener `BUSINESS_RESPONSES_ENABLED=false` hasta revisar los cuatro textos.
5. Configurar en Kapso el webhook `https://TU-DOMINIO/api/kapso/webhook` para:
   - `whatsapp.message.received`
   - `whatsapp.message.sent`
6. Usar payload V2 y desactivar el buffering del webhook.
7. Después de una prueba controlada, cambiar `BUSINESS_RESPONSES_ENABLED=true`.

## Desarrollo

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Seguridad

- La firma HMAC de Kapso se verifica antes de interpretar el payload.
- Las claves viven solo en Vercel; nunca se envían al navegador.
- Supabase usa RLS sin políticas públicas y el backend accede con `service_role`.
- Los eventos se registran por idempotency key para no contestar dos veces una misma entrega.
