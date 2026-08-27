import { MODEL_SILENT_REASONS } from './contract';

/**
 * Esquema de la salida estructurada que se pedirá a OpenAI en la Fase 3.
 *
 * Es deliberadamente plano. Las salidas estructuradas en modo estricto no
 * admiten uniones discriminadas ni campos opcionales: exigen que todas las
 * propiedades estén declaradas y presentes. Por eso el modelo devuelve
 * siempre los cuatro campos y el validador los traduce a la unión
 * `Decision` de `contract.ts`, ignorando los que no apliquen.
 *
 * Este archivo no importa el SDK de OpenAI: es solo la descripción del
 * contrato, y se puede probar sin red.
 */
export const DECISION_SCHEMA_NAME = 'business_decision';

export const DECISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'message', 'sources', 'reason'],
  properties: {
    action: {
      type: 'string',
      enum: ['reply', 'clarify', 'silent'],
      description:
        'reply: hay respuesta respaldada por la informacion autorizada. ' +
        'clarify: la consulta es del negocio pero falta concretar una opcion. ' +
        'silent: no hay informacion autorizada o la consulta no es del negocio.',
    },
    message: {
      type: 'string',
      description:
        'Texto a enviar al cliente cuando action es reply o clarify. ' +
        'Cadena vacia cuando action es silent.',
    },
    sources: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Ids de los bloques de informacion autorizada que respaldan el mensaje. ' +
        'Obligatorio y no vacio cuando action es reply o clarify. ' +
        'Lista vacia cuando action es silent.',
    },
    reason: {
      type: 'string',
      enum: [...MODEL_SILENT_REASONS, 'not_applicable'],
      description:
        'Motivo del silencio cuando action es silent. ' +
        'not_applicable cuando action es reply o clarify.',
    },
  },
} as const;

/** Forma cruda que devuelve el modelo, antes de validar. */
export interface RawDecision {
  readonly action: string;
  readonly message: string;
  readonly sources: readonly string[];
  readonly reason: string;
}
