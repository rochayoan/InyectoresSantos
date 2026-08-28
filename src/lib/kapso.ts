/**
 * Envío de texto por Kapso.
 *
 * Dos límites de tiempo: uno por intento y uno para toda la operación. El
 * segundo existe porque la función tiene `maxDuration = 30` y el reintento del
 * 409 introduce esperas: sin presupuesto total, tres intentos lentos agotarían
 * la invocación entera.
 */

const KAPSO_MESSAGES_URL = 'https://api.kapso.ai/meta/whatsapp/v24.0';

/** Un intento por si Kapso responde 409, más los dos reintentos autorizados. */
const MAX_ATTEMPTS = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 20_000;

export interface SendKapsoTextInput {
  readonly apiKey: string;
  readonly phoneNumberId: string;
  readonly to: string;
  readonly body: string;
  readonly attemptTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
  /** Puntos de inyección para las pruebas. Nunca se usan en producción. */
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function sendKapsoText(input: SendKapsoTextInput): Promise<string> {
  const url = `${KAPSO_MESSAGES_URL}/${encodeURIComponent(input.phoneNumberId)}/messages`;
  const attemptTimeoutMs = input.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const totalTimeoutMs = input.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const doFetch = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const deadline = Date.now() + totalTimeoutMs;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('kapso_send_failed:budget_exhausted');

    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': input.apiKey,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: input.to,
          type: 'text',
          text: { body: input.body, preview_url: false },
        }),
        signal: AbortSignal.timeout(Math.min(attemptTimeoutMs, remaining)),
      });
    } catch (error) {
      // No se reintenta: si la petición se cortó, no sabemos si Kapso la
      // aceptó, y repetirla podría escribirle dos veces al cliente.
      throw new Error(`kapso_send_failed:${isAbort(error) ? 'timeout' : 'network'}`);
    }

    if (response.ok) {
      const data = (await response.json()) as { messages?: Array<{ id?: string }> };
      const messageId = data.messages?.[0]?.id;
      if (!messageId) throw new Error('kapso_missing_message_id');
      return messageId;
    }

    // 409 significa que ya hay otro envío en curso para esa conversación y que
    // esta petición todavía no fue aceptada. Es el único código que se
    // reintenta, con una espera corta y sin salirse del presupuesto.
    if (response.status === 409 && attempt < MAX_ATTEMPTS - 1) {
      const wait = 1_000 * (attempt + 1);
      if (Date.now() + wait >= deadline) throw new Error('kapso_send_failed:budget_exhausted');
      await sleep(wait);
      continue;
    }

    throw new Error(`kapso_send_failed:${response.status}`);
  }

  throw new Error('kapso_send_failed:retry_exhausted');
}
