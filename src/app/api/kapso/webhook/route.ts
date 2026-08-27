import { NextResponse } from 'next/server';
import { getEnv } from '@/lib/env';
import { sendKapsoText } from '@/lib/kapso';
import { matchPredeterminedResponse } from '@/lib/matcher';
import { parseKapsoEvent } from '@/lib/provenance';
import { verifyKapsoSignature } from '@/lib/security';
import { createStore } from '@/lib/store';

export const runtime = 'nodejs';

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature') ?? '';
  const version = request.headers.get('x-webhook-payload-version') ?? '';
  const eventName = request.headers.get('x-webhook-event') ?? '';
  const eventId = request.headers.get('x-idempotency-key') ?? '';

  try {
    const env = getEnv();

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
      return NextResponse.json({ error: 'buffering_must_be_disabled' }, { status: 422 });
    }

    const event = parseKapsoEvent({ eventName, eventId, payload });
    if (event.kind === 'ignore') {
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

      if (!env.responsesEnabled) {
        await store.completeEvent(eventId, 'responses_disabled');
        return NextResponse.json({ ok: true, silent: true });
      }

      if (await store.isPaused(event.phone)) {
        await store.completeEvent(eventId, 'paused');
        return NextResponse.json({ ok: true, silent: true, reason: 'human_takeover' });
      }

      const matched = matchPredeterminedResponse(event.text);
      if (!matched) {
        await store.completeEvent(eventId, 'unrecognized');
        return NextResponse.json({ ok: true, silent: true, reason: 'unrecognized' });
      }

      await sendKapsoText({
        apiKey: env.kapsoApiKey,
        phoneNumberId: env.kapsoPhoneNumberId,
        to: event.phone,
        body: matched.response,
      });
      await store.completeEvent(eventId, matched.intent);
      return NextResponse.json({ ok: true, handled: matched.intent });
    } catch (error) {
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
