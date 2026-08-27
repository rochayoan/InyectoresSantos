/**
 * Contrato de decisión.
 *
 * El motor inteligente nunca envía mensajes. Solo devuelve una de tres
 * decisiones, que el backend valida antes de tocar Kapso:
 *
 *   reply    hay respuesta respaldada por la información autorizada
 *   clarify  la consulta es del negocio pero falta concretar una opción
 *   silent   no hay información autorizada, o la consulta no es del negocio
 *
 * `silent` significa no llamar a Kapso. No existe mensaje de relleno.
 */

/** Razones de silencio que el modelo puede declarar por sí mismo. */
export const MODEL_SILENT_REASONS = ['out_of_scope', 'no_authorized_information'] as const;
export type ModelSilentReason = (typeof MODEL_SILENT_REASONS)[number];

/** Razones de silencio que decide el backend. El modelo nunca las produce. */
export const SYSTEM_SILENT_REASONS = [
  'responses_disabled',
  'knowledge_not_ready',
  'engine_not_configured',
  'engine_unavailable',
  'engine_timeout',
  'invalid_model_output',
  'clarify_not_allowed',
  'human_pause',
  'unsupported_content',
  'empty_message',
] as const;
export type SystemSilentReason = (typeof SYSTEM_SILENT_REASONS)[number];

export type SilentReason = ModelSilentReason | SystemSilentReason;

export interface ReplyDecision {
  readonly action: 'reply';
  readonly message: string;
  /** Ids de bloques autorizados que respaldan la respuesta. Nunca vacío. */
  readonly sources: readonly string[];
}

export interface ClarifyDecision {
  readonly action: 'clarify';
  readonly message: string;
  /** Ids de los bloques entre los que el cliente debe elegir. Nunca vacío. */
  readonly sources: readonly string[];
}

export interface SilentDecision {
  readonly action: 'silent';
  /** Interna. Se registra para auditar, jamás se envía al cliente. */
  readonly reason: SilentReason;
}

export type Decision = ReplyDecision | ClarifyDecision | SilentDecision;
export type DeliverableDecision = ReplyDecision | ClarifyDecision;

/** Longitud máxima de una respuesta. El dueño escribe corto. */
export const MAX_REPLY_LENGTH = 1200;
/** Una aclaración es una pregunta breve, no un interrogatorio. */
export const MAX_CLARIFY_LENGTH = 200;
/** Tope de bloques citables en una sola respuesta. */
export const MAX_SOURCES = 6;

export function silent(reason: SilentReason): SilentDecision {
  return { action: 'silent', reason };
}

export function isDeliverable(decision: Decision): decision is DeliverableDecision {
  return decision.action !== 'silent';
}

/** Etiqueta corta y sin datos del cliente, apta para registrar en Supabase. */
export function decisionOutcome(decision: Decision): string {
  return decision.action === 'silent' ? `silent:${decision.reason}` : decision.action;
}
