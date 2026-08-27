/**
 * Configuración del servidor.
 *
 * Dos grupos distintos:
 *
 * - Siempre obligatorio: lo que hace falta para recibir y validar webhooks
 *   (secreto de firma y Supabase). Sin esto el servicio no puede ni escuchar.
 * - Obligatorio solo para responder: claves de Kapso y de OpenAI. Si falta
 *   algo de este grupo, el servicio sigue recibiendo y validando eventos,
 *   pero queda en silencio.
 *
 * Esa separación permite desplegar en modo «recibir sin responder» sin
 * inventar valores falsos para las claves que todavía no existen.
 */

export interface Env {
  readonly kapsoWebhookSecret: string;
  readonly kapsoApiKey: string | null;
  readonly kapsoPhoneNumberId: string | null;
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly openaiApiKey: string | null;
  /** Sin valor por defecto: se elige tras evaluar costo, latencia y calidad. */
  readonly openaiModel: string | null;
  readonly openaiTimeoutMs: number;
  readonly openaiMaxOutputTokens: number;
  readonly contextWindowMessages: number;
  readonly contextWindowMinutes: number;
  readonly humanPauseMinutes: number;
  /**
   * Verdadero solo si el flag vale exactamente 'true' Y existe toda la
   * configuración necesaria para enviar. Fallar hacia el silencio es
   * preferible a fallar hacia el 500: una tanda de errores puede hacer que
   * Kapso pause el webhook entero.
   */
  readonly responsesEnabled: boolean;
  /** Por qué quedó apagado pese al flag. Nunca contiene valores de claves. */
  readonly disabledReason: string | null;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing_env:${name}`);
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`invalid_env:${name}`);
  }
  return value;
}

export function getEnv(): Env {
  const kapsoApiKey = optional('KAPSO_API_KEY');
  const kapsoPhoneNumberId = optional('KAPSO_PHONE_NUMBER_ID');
  const openaiApiKey = optional('OPENAI_API_KEY');
  const openaiModel = optional('OPENAI_MODEL');

  const flagOn = process.env.BUSINESS_RESPONSES_ENABLED === 'true';

  const missing: string[] = [];
  if (!kapsoApiKey) missing.push('KAPSO_API_KEY');
  if (!kapsoPhoneNumberId) missing.push('KAPSO_PHONE_NUMBER_ID');
  if (!openaiApiKey) missing.push('OPENAI_API_KEY');
  if (!openaiModel) missing.push('OPENAI_MODEL');

  const responsesEnabled = flagOn && missing.length === 0;

  let disabledReason: string | null = null;
  if (!flagOn) disabledReason = 'flag_off';
  else if (missing.length > 0) disabledReason = `missing:${missing.join(',')}`;

  return {
    kapsoWebhookSecret: required('KAPSO_WEBHOOK_SECRET'),
    kapsoApiKey,
    kapsoPhoneNumberId,
    supabaseUrl: required('SUPABASE_URL'),
    supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    openaiApiKey,
    openaiModel,
    openaiTimeoutMs: integer('OPENAI_TIMEOUT_MS', 8_000, 1_000, 20_000),
    openaiMaxOutputTokens: integer('OPENAI_MAX_OUTPUT_TOKENS', 400, 64, 2_000),
    contextWindowMessages: integer('CONTEXT_WINDOW_MESSAGES', 6, 0, 20),
    contextWindowMinutes: integer('CONTEXT_WINDOW_MINUTES', 30, 1, 180),
    humanPauseMinutes: integer('HUMAN_PAUSE_MINUTES', 30, 1, 1_440),
    responsesEnabled,
    disabledReason,
  };
}
