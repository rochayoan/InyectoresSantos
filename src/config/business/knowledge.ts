import type { KnowledgeBlock } from './types';

/**
 * INFORMACIÓN AUTORIZADA DEL NEGOCIO.
 *
 * Este es el único archivo donde se escribe qué puede decir el sistema.
 *
 * Está vacío a propósito. Se completa en la Fase 5, con los textos reales del
 * dueño y solo con ellos. Mientras siga vacío, `assessKnowledge()` devuelve
 * `ready: false` y el sistema permanece en silencio ante cualquier consulta,
 * incluso si `BUSINESS_RESPONSES_ENABLED` estuviera encendido.
 *
 * Qué escribir en cada bloque, cuando llegue el momento:
 *
 * - `id`      Identificador corto, estable y único. El modelo lo cita en
 *             `sources` y el validador comprueba que exista. Cambiar un `id`
 *             después de tener evaluaciones escritas las invalida.
 * - `kind`    'info' para los dos mensajes informativos largos, 'location'
 *             para cada sucursal, 'hours' para horarios, 'service' para cada
 *             servicio, 'link' para enlaces sueltos autorizados.
 * - `label`   Nombre corto y descriptivo. Solo lo lee el modelo.
 * - `content` El texto exacto del dueño. Literal, sin reescribir, sin
 *             resumir y sin añadir nada que él no haya dicho.
 * - `order`   1, 2, 3... dentro de cada `kind`. La ubicación con `order: 2`
 *             es «la segunda» cuando el cliente pregunta por ella.
 * - `url`     Solo si el dueño entregó ese enlace. El validador rechaza
 *             cualquier respuesta que contenga un enlace que no aparezca aquí.
 *
 * Mínimo requerido para que el sistema pueda responder: dos bloques 'info',
 * dos bloques 'location', al menos uno de 'hours' y al menos uno de 'service'.
 *
 * NO escribir datos de ejemplo, aproximados o «provisionales». Un texto
 * inventado en este archivo se convierte en un mensaje enviado a un cliente.
 */
export const KNOWLEDGE_BLOCKS: readonly KnowledgeBlock[] = [];
