import { NextResponse } from 'next/server';
import { getBusinessKnowledge } from '@/config/business';
import { decisionOutcome } from '@/lib/decision/contract';
import { preflight, resolveDecisionEngine } from '@/lib/decision/engine';
import { getEnv } from '@/lib/env';
import { sendKapsoText } from '@/lib/kapso';
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

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature') ?? '';
  const version = request.headers.get('x-webhook-payload-version') ?? '';
  const eventName = request.headers.get('x-webhook-event') ?? '';
  const eventId = request.headers.get('x-idempotency-key') ?? '';

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
      // El buffering se diseña en la Fase 2 y no se activa todavía.
      return NextResponse.json({ error: 'buffering_must_be_disabled' }, { status: 422 });
    }

    const event = parseKapsoEvent({ eventName, eventId, payload });
    if (event.kind === 'ignore') {
      // Entregas, lecturas, fallos y envíos propios: ni pausan ni responden.
      return NextResponse.json({ ok: true, ignored: true });
    }

    const store = createStore(env.supabaseUrl, env.supabaseServiceRoleKey);
    const claimed = await store.claimEvent(eventId, eventName, event.messageId);
    if (!claimed) return NextResponse.json({ ok: true, duplicate: true });

    try {
      if (event.kind === 'owner') {
        const pauseUntil = new Date(Date.now() + env.humanPauseMinutes * 60_000).toISOString();
        await store.pauseChat(event.phone, pauseUntil, event.messageId);
        await store.completeEvent(eventId, 'human_pause');
        return NextResponse.json({ ok: true, handled: 'human_pause' });
      }

      // Comprobaciones baratas y sin red antes de tocar Supabase o el motor.
      const knowledge = getBusinessKnowledge();
      const blocked = preflight({
        responsesEnabled: env.responsesEnabled,
        knowledge,
        incomingText: event.text,
      });
      if (blocked) {
        const detail = blocked.reason === 'responses_disabled' && env.disabledReason
          ? `${decisionOutcome(blocked)}:${env.disabledReason}`
          : decisionOutcome(blocked);
        await store.completeEvent(eventId, detail);
        return NextResponse.json({ ok: true, silent: true });
      }

      if (await store.isPaused(event.phone)) {
        await store.completeEvent(eventId, 'silent:human_pause');
        return NextResponse.json({ ok: true, silent: true });
      }

      const engine = resolveDecisionEngine({ timeoutMs: env.openaiTimeoutMs });
      const decision = await engine.decide({
        incomingText: event.text,
        history: [], // Fase 2: ventana corta leída de Supabase.
        knowledge,
        clarifyAllowed: true, // Fase 2: depende del historial reciente.
      });

      if (decision.action === 'silent') {
        await store.completeEvent(eventId, decisionOutcome(decision));
        return NextResponse.json({ ok: true, silent: true });
      }

      // Barrera obligatoria: el dueño pudo contestar mientras el motor decidía.
      if (await store.isPaused(event.phone)) {
        await store.completeEvent(eventId, 'silent:human_pause');
        return NextResponse.json({ ok: true, silent: true });
      }

      if (!env.kapsoApiKey || !env.kapsoPhoneNumberId) {
        await store.completeEvent(eventId, 'silent:responses_disabled');
        return NextResponse.json({ ok: true, silent: true });
      }

      await sendKapsoText({
        apiKey: env.kapsoApiKey,
        phoneNumberId: env.kapsoPhoneNumberId,
        to: event.phone,
        body: decision.message,
      });
      await store.completeEvent(eventId, decisionOutcome(decision));
      return NextResponse.json({ ok: true, handled: decision.action });
    } catch (error) {
      // Deja el evento reclamable por el siguiente reintento de Kapso.
      await store.failEvent(eventId);
      throw error;
    }
  } catch (error) {
    console.error('webhook_error', {
      event: eventName,
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }
}
