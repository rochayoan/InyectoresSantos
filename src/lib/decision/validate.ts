import { normalizeText } from '@/lib/text';
import {
  MAX_CLARIFY_LENGTH,
  MAX_REPLY_LENGTH,
  MAX_SOURCES,
  MODEL_SILENT_REASONS,
  type Decision,
  type ModelSilentReason,
  silent,
} from './contract';
import { AI_DISCLOSURE_PATTERNS, GENERIC_FILLER_PATTERNS, matchesAny } from './forbidden';

/** Motivo por el que se rechazó una salida del modelo. Solo para auditoría. */
export type ValidationFailure =
  | 'not_an_object'
  | 'unknown_action'
  | 'unknown_silent_reason'
  | 'message_empty'
  | 'message_too_long'
  | 'sources_empty'
  | 'sources_too_many'
  | 'sources_unknown'
  | 'clarify_not_allowed'
  | 'ai_disclosure'
  | 'generic_filler'
  | 'unauthorized_link'
  | 'unauthorized_number';

export type ValidationResult =
  | { readonly ok: true; readonly decision: Decision }
  | { readonly ok: false; readonly failure: ValidationFailure };

export interface ValidationContext {
  /** Ids citables. Cualquier otro invalida la respuesta. */
  readonly authorizedIds: ReadonlySet<string>;
  /** Texto autorizado completo, para comprobar enlaces y números. */
  readonly authorizedText: string;
  /** Falso cuando ya se pidió una aclaración y el cliente no la resolvió. */
  readonly clarifyAllowed: boolean;
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'()]+/gi;
const DIGIT_SEPARATORS = /(?<=\d)[\s.\-()]+(?=\d)/g;
/** Un número de siete cifras o más es un dato duro: teléfono, NIT, referencia. */
const LONG_NUMBER_PATTERN = /\d{7,}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
}

function extractUrls(value: string): string[] {
  return (value.match(URL_PATTERN) ?? []).map((url) =>
    url.replace(/[.,;:!?]+$/, '').toLowerCase(),
  );
}

function compactDigits(value: string): string {
  return value.replace(DIGIT_SEPARATORS, '');
}

function extractLongNumbers(value: string): string[] {
  return compactDigits(value).match(LONG_NUMBER_PATTERN) ?? [];
}

/**
 * Valida una salida cruda del modelo contra la información autorizada.
 *
 * Comprueba, en orden: forma, alcance de la aclaración, longitud, respaldo en
 * bloques reales, ausencia de frases prohibidas y ausencia de enlaces o
 * números que no existan en la información del negocio.
 */
export function validateDecision(raw: unknown, context: ValidationContext): ValidationResult {
  if (!isRecord(raw)) return { ok: false, failure: 'not_an_object' };

  const action = readString(raw.action);

  if (action === 'silent') {
    const reason = readString(raw.reason);
    if (!(MODEL_SILENT_REASONS as readonly string[]).includes(reason)) {
      return { ok: false, failure: 'unknown_silent_reason' };
    }
    return { ok: true, decision: silent(reason as ModelSilentReason) };
  }

  if (action !== 'reply' && action !== 'clarify') {
    return { ok: false, failure: 'unknown_action' };
  }

  if (action === 'clarify' && !context.clarifyAllowed) {
    return { ok: false, failure: 'clarify_not_allowed' };
  }

  const message = readString(raw.message);
  if (message === '') return { ok: false, failure: 'message_empty' };

  const maxLength = action === 'reply' ? MAX_REPLY_LENGTH : MAX_CLARIFY_LENGTH;
  if (message.length > maxLength) return { ok: false, failure: 'message_too_long' };

  const sources = readStringArray(raw.sources).filter((id) => id !== '');
  if (sources.length === 0) return { ok: false, failure: 'sources_empty' };
  if (sources.length > MAX_SOURCES) return { ok: false, failure: 'sources_too_many' };
  if (sources.some((id) => !context.authorizedIds.has(id))) {
    return { ok: false, failure: 'sources_unknown' };
  }

  const normalized = normalizeText(message);
  if (matchesAny(normalized, AI_DISCLOSURE_PATTERNS)) {
    return { ok: false, failure: 'ai_disclosure' };
  }
  if (matchesAny(normalized, GENERIC_FILLER_PATTERNS)) {
    return { ok: false, failure: 'generic_filler' };
  }

  const authorized = context.authorizedText.toLowerCase();
  if (extractUrls(message).some((url) => !authorized.includes(url))) {
    return { ok: false, failure: 'unauthorized_link' };
  }

  const authorizedDigits = compactDigits(context.authorizedText);
  if (extractLongNumbers(message).some((number) => !authorizedDigits.includes(number))) {
    return { ok: false, failure: 'unauthorized_number' };
  }

  const unique = [...new Set(sources)];
  return {
    ok: true,
    decision:
      action === 'reply'
        ? { action: 'reply', message, sources: unique }
        : { action: 'clarify', message, sources: unique },
  };
}

/**
 * Igual que `validateDecision`, pero nunca falla: una salida inválida se
 * convierte en silencio. Es la forma que usa el pipeline.
 */
export function toSafeDecision(raw: unknown, context: ValidationContext): Decision {
  const result = validateDecision(raw, context);
  return result.ok ? result.decision : silent('invalid_model_output');
}
