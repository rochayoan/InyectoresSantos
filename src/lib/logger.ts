import { createHmac } from 'node:crypto';

/**
 * Registro mínimo y redactado.
 *
 * El criterio es una lista blanca, no una lista negra: solo salen los campos
 * declarados abajo, y cualquier otro se descarta contando cuántos fueron. Una
 * lista negra habría que ampliarla cada vez que alguien añade un campo nuevo,
 * y el fallo sería silencioso y hacia fuera.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LogRecord {
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Record<string, string | number | boolean>;
}

export type LogSink = (record: LogRecord) => void;

/**
 * Campos permitidos. Ninguno puede contener el mensaje del cliente, su
 * teléfono, una clave ni un payload del proveedor.
 */
const ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  'stage',
  'outcome',
  'reason',
  'action',
  'status',
  'code',
  'attempts',
  'durationMs',
  'turns',
  'claimed',
  'clarifyAllowed',
  'conversation',
  'eventName',
]);

const MAX_VALUE_LENGTH = 64;
/** Última red: una secuencia larga de dígitos nunca sale de aquí. */
const LONG_NUMBER = /\d{7,}/g;

function sanitizeValue(value: unknown): string | number | boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  return value.slice(0, MAX_VALUE_LENGTH).replace(LONG_NUMBER, '[num]');
}

export function sanitizeFields(fields: Record<string, unknown> = {}): Record<
  string,
  string | number | boolean
> {
  const safe: Record<string, string | number | boolean> = {};
  let dropped = 0;

  for (const [key, raw] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key)) {
      dropped += 1;
      continue;
    }
    const value = sanitizeValue(raw);
    if (value === null) {
      dropped += 1;
      continue;
    }
    safe[key] = value;
  }

  if (dropped > 0) safe.droppedFields = dropped;
  return safe;
}

/**
 * Identificador de conversación estable e irreversible.
 *
 * Un simple hash del teléfono no serviría: el espacio de números es pequeño y
 * se recorre por fuerza bruta en segundos. Con HMAC y un secreto de servidor,
 * el registro deja de ser un directorio telefónico.
 */
export function conversationRef(phone: string, salt: string): string {
  return createHmac('sha256', salt).update(phone).digest('hex').slice(0, 12);
}

/**
 * Reduce un error a un código corto y sin datos.
 *
 * Los errores del proyecto ya vienen en forma `motivo:codigo`. De cualquier
 * otro se conserva solo lo que parece un identificador técnico.
 */
export function normalizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const code = message.trim().split(/\s+/)[0] ?? '';
  const clean = code.replace(/[^a-zA-Z0-9_:.-]/g, '').slice(0, 60);
  return clean === '' ? 'unknown' : clean;
}

export const consoleSink: LogSink = (record) => {
  const line = { event: record.event, ...record.fields };
  if (record.level === 'error') console.error(record.event, line);
  else if (record.level === 'warn') console.warn(record.event, line);
  else console.info(record.event, line);
};

export function createLogger(options: { sink?: LogSink } = {}): Logger {
  const sink = options.sink ?? consoleSink;

  const emit = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    sink({ level, event, fields: sanitizeFields(fields) });
  };

  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
