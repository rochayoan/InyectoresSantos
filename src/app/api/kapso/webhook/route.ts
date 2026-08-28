import { NextResponse } from 'next/server';
import { getBusinessKnowledge } from '@/config/business';
import { resolveDecisionEngine } from '@/lib/decision/engine';
import { getEnv } from '@/lib/env';
import { sendKapsoText } from '@/lib/kapso';
import { conversationRef, createLogger, normalizeError } from '@/lib/logger';
import { processEvent, type SendText } from '@/lib/pipeline';
import { parseKapsoEvent } from '@/lib/provenance';
import { verifyKapsoSignature } from '@/lib/security';
import { createStore } from '@/lib/store';

export const runtime = 'nodejs';

/**
 * Presupuesto total de la invocación. Tiene que cubrir Supabase, el motor de
 * decisión y el envío a Kapso, y quedar holgadamente por debajo de los 10
 * segundos que tarda Kapso en lanzar su primer reintento.
 */
export const maxDuration = 30;

/**
 * Arrendamiento del evento, algo por encima de `maxDuration`.
 *
 * Si la invocación muere, el evento queda tomado hasta que vence el lease y
 * entonces vuelve a ser reclamable. Más corto que `maxDuration` permitiría que
 * dos invocaciones vivas trabajasen el mismo evento; mucho más largo dejaría
 * los eventos huérfanos fuera del alcance de los reintentos de Kapso, que se
 * agotan alrededor de los dos minutos y medio.
 */
const PROCESSING_LEASE_SECONDS = 45;

/** Fracción de eventos tras los que se intenta purgar. */
const PURGE_SAMPLE_RATE = 0.02;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature') ?? '';
  const version = request.headers.get('x-webhook-payload-version') ?? '';
  const eventName = request.headers.get('x-webhook-event') ?? '';
  const eventId = request.headers.get('x-idempotency-key') ?? '';

  const logger = createLogger();

  try {
    const env = getEnv();

    // La firma se comprueba sobre el cuerpo crudo y antes de interpretarlo.
    if (!verifyKapsoSignature(rawBody, signature, env.kapsoWebhookSecret)) {
      return NextResponse.json({ error: 'invalid_signature' }, { status: 401 });
    }
    if (version !== 'v2') {
      return NextResponse.json({ error: 'unsupported_version' }, { status: 400 });
    }
    if (!eventId) {
      return NextResponse.json({ error: 'missing_idempotency_key' }, { status: 400 });
    }

    const payload = JSON.parse(rawBody) as unknown;
    if (typeof payload === 'object' && payload !== null && 'batch' in payload) {
      // Sin el formato del lote confirmado, agrupar sería inventarlo. Se
      // mantiene el rechazo y el buffering sigue desactivado en Kapso.
      return NextResponse.json({ error: 'buffering_must_be_disabled' }, { status: 422 });
    }

    const event = parseKapsoEvent({ eventName, eventId, payload });

    const deliveryConfigured = Boolean(env.kapsoApiKey && env.kapsoPhoneNumberId);
    const send: SendText = deliveryConfigured
      ? ({ to, body }) =>
          sendKapsoText({
            apiKey: env.kapsoApiKey as string,
            phoneNumberId: env.kapsoPhoneNumberId as string,
            to,
            body,
          })
      : () => Promise.reject(new Error('kapso_send_failed:not_configured'));

    const outcome = await processEvent(
      event,
      {
        store: createStore(env.supabaseUrl, env.supabaseServiceRoleKey),
        engine: resolveDecisionEngine({ timeoutMs: env.openaiTimeoutMs }),
        send,
        logger,
        knowledge: getBusinessKnowledge(),
        conversation: (phone) => conversationRef(phone, env.kapsoWebhookSecret),
      },
      {
        responsesEnabled: env.responsesEnabled,
        deliveryConfigured,
        disabledReason: env.disabledReason,
        humanPauseMinutes: env.humanPauseMinutes,
        contextWindowMessages: env.contextWindowMessages,
        contextWindowMinutes: env.contextWindowMinutes,
        leaseSeconds: PROCESSING_LEASE_SECONDS,
        purgeSampleRate: PURGE_SAMPLE_RATE,
      },
    );

    switch (outcome.kind) {
      case 'ignored':
        return NextResponse.json({ ok: true, ignored: true });
      case 'duplicate':
        return NextResponse.json({ ok: true, duplicate: true });
      case 'human_pause':
        return NextResponse.json({ ok: true, handled: 'human_pause' });
      case 'sent':
        return NextResponse.json({ ok: true, handled: outcome.action });
      default:
        // El motivo concreto queda en el registro y en webhook_events, no en
        // la respuesta a un tercero.
        return NextResponse.json({ ok: true, silent: true });
    }
  } catch (error) {
    logger.error('webhook_error', { eventName, code: normalizeError(error) });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
