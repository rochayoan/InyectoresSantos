# InyectoresSantos

Atención automática del WhatsApp Business de Inyectores Santos.

OpenAI es el motor de comprensión y redacción, pero no decide qué se puede
decir: solo puede responder con la información autorizada del negocio, y su
salida se valida antes de que ningún mensaje salga hacia un cliente.

## Cómo funciona

Un webhook de Kapso recibe los mensajes. Por cada mensaje de un cliente el
sistema decide una de tres cosas:

| Decisión | Significado | Qué hace |
|---|---|---|
| `reply` | Hay respuesta respaldada por la información autorizada | Envía el mensaje |
| `clarify` | La consulta es del negocio pero falta concretar una opción | Envía una pregunta breve |
| `silent` | No hay información autorizada, o la consulta no es del negocio | **No envía nada** |

`silent` significa no llamar a Kapso. No existe mensaje de relleno: nunca se
envía «no tengo esa información», «un asesor te responderá», «¿en qué puedo
ayudarte?» ni «no entendí tu consulta».

Si el motor falla, tarda de más, no está disponible o devuelve una salida que
no supera la validación, el comportamiento es el mismo: silencio.

## Reglas del sistema

El motor puede identificar la intención, seleccionar y combinar información
autorizada, adaptar ligeramente el tono, entender seguimientos con el
historial reciente y pedir una aclaración breve.

No puede inventar precios, servicios, horarios, ubicaciones ni garantías,
prometer resultados, completar datos con conocimiento general, responder
consultas ajenas al negocio ni decir que es una inteligencia artificial. Las
instrucciones que escriba un cliente no cambian estas reglas.

## Toma de control del dueño

El dueño sigue respondiendo a mano desde WhatsApp Business. Cuando lo hace,
la automatización se detiene **solo en ese chat** durante 30 minutos, y cada
mensaje manual suyo reinicia la cuenta.

Solo cuenta como respuesta manual esta combinación exacta: evento
`whatsapp.message.sent` con `message.kapso.direction === "outbound"` y
`message.kapso.origin === "business_app"`. Los mensajes del propio sistema
llegan con `origin === "cloud_api"` y no pausan nada; los eventos de entrega,
lectura y fallo tampoco. El cliente nunca recibe aviso de que hay una pausa.

La pausa se comprueba dos veces: al recibir el mensaje y otra vez
inmediatamente antes de enviar. La segunda comprobación es la que evita
hablar encima del dueño cuando él contesta mientras el motor decide.

## Información del negocio

Todo lo que el sistema puede decir vive en [`src/config/business/`](src/config/business/):

- `knowledge.ts` — bloques autorizados: mensajes informativos, ubicaciones,
  horarios, servicios y enlaces.
- `voice.ts` — ejemplos reales de cómo escribe el dueño.
- `rules.ts` — reglas de respuesta propias del dueño.

**Está vacío a propósito.** Se completa en la Fase 5 con los textos reales.
Mientras siga vacío, `assessKnowledge()` devuelve `ready: false` y el sistema
calla ante cualquier consulta, aunque el flag esté encendido.

No escribir datos de ejemplo ni provisionales: un texto inventado en esos
archivos se convierte en un mensaje enviado a un cliente.

## Estado del proyecto

Fase 2 completada: persistencia recuperable, historial corto y barrera.

El motor activo es `createSilentEngine()`, que calla siempre. OpenAI se
integra en la Fase 3. El sistema es desplegable y no puede escribirle a nadie.

| Fase | Estado |
|---|---|
| 0 · Auditoría | Completada |
| 1 · Diseño técnico y estructura segura | Completada |
| 2 · Persistencia, idempotencia recuperable, pausa y barrera | Completada |
| 3 · Núcleo OpenAI | Pendiente |
| 4 · Pruebas de robustez | Pendiente |
| 5 · Información real del negocio | Pendiente |
| 6 · Pruebas de comprensión | Pendiente |
| 7 · Infraestructura | Pendiente |
| 8 · Pruebas reales y activación | Pendiente |

## Variables de entorno

Ver [`.env.example`](.env.example). Ninguna clave se escribe en el
repositorio; todas se cargan en Vercel y solo del lado del servidor.

`BUSINESS_RESPONSES_ENABLED` debe valer exactamente `true` para responder.
Además, si falta cualquier pieza de configuración necesaria para enviar, el
servicio se apaga hacia el silencio en lugar de devolver errores: una tanda
de 500 puede hacer que Kapso pause el webhook entero.

## Base de datos

Una sola migración, [`supabase/migrations/0001_initial.sql`](supabase/migrations/0001_initial.sql),
**todavía no aplicada**. Tres tablas: pausa por conversación, idempotencia con
arrendamiento de eventos e historial corto. RLS activado y sin políticas: solo
el backend con `service_role` entra.

A partir de su primera aplicación, toda migración posterior será aditiva.

## Desarrollo

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Las pruebas no llaman a ningún servicio externo y no necesitan claves.

## Seguridad

- La firma HMAC SHA-256 de Kapso se verifica sobre el cuerpo crudo, con
  comparación en tiempo constante, antes de interpretar el payload.
- Idempotencia por `X-Idempotency-Key`, resuelta dentro de una función SQL
  atómica. Un evento con entrega registrada nunca se vuelve a tomar; uno
  fallido, o huérfano con el arrendamiento vencido, sí se recupera.
- Los registros no incluyen claves, teléfonos, textos de clientes ni payloads
  del proveedor: solo etiquetas cortas de desenlace.
- El historial guarda una ventana corta y se purga a las 24 horas.

### Límite conocido de la entrega

Entre que Kapso acepta un mensaje y que se graba su `sent_message_id` hay una
ventana breve. Si la invocación muere justo ahí, el evento queda sin entrega
registrada y un reintento posterior de Kapso, una vez vencido el
arrendamiento, podría reenviar el mismo mensaje.

La ventana se acota poniendo el arrendamiento por encima de `maxDuration`
(45 s frente a 30 s) y grabando la entrega inmediatamente después del envío,
pero no se cierra del todo: la API de envío de Kapso no expone una clave de
idempotencia confirmada. **No se puede afirmar entrega exactamente una vez.**
Lo que sí está garantizado es que un evento con entrega ya registrada no
vuelve a enviarse nunca.
