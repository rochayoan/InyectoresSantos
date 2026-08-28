import type { BusinessKnowledge } from '@/config/business';
import { computeClarifyAllowed } from '@/lib/decision/clarify';
import { decisionOutcome } from '@/lib/decision/contract';
import { preflight, type DecisionEngine } from '@/lib/decision/engine';
import { normalizeError, type Logger } from '@/lib/logger';
import type { Store } from '@/lib/ports';
import type { ParsedKapsoEvent } from '@/lib/provenance';

/**
 * Procesamiento de un evento de Kapso, sin nada de HTTP.
 *
 * Vive fuera de la ruta para poder ejercitar entero el flujo —reclamo,
 * pausa, historial, decisión y barrera— con dobles en memoria.
 */

export type SendText = (input: { to: string; body: string }) => Promise<string>;

export interface PipelineConfig {
  readonly responsesEnabled: boolean;
  /** Falso si faltan claves de envío, aunque el flag esté encendido. */
  readonly deliveryConfigured: boolean;
  readonly disabledReason: string | null;
  readonly humanPauseMinutes: number;
  readonly contextWindowMessages: number;
  readonly contextWindowMinutes: number;
  readonly leaseSeconds: number;
  /** Fracción de eventos tras los que se intenta purgar. 0 la desactiva. */
  readonly purgeSampleRate: number;
}

export interface PipelineDeps {
  readonly store: Store;
  readonly engine: DecisionEngine;
  readonly send: SendText;
  readonly logger: Logger;
  /**
   * Información autorizada. Se recibe en vez de leerse del módulo para que el
   * pipeline se pueda ejercitar con un conjunto completo sin tocar la
   * configuración real, que debe seguir vacía.
   */
  readonly knowledge: BusinessKnowledge;
  /** Referencia irreversible del chat, para los registros. */
  readonly conversation: (phone: string) => string;
  readonly random?: () => number;
}

export type PipelineOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'human_pause' }
  | { readonly kind: 'silent'; readonly reason: string }
  | { readonly kind: 'sent'; readonly action: 'reply' | 'clarify' };

export async function processEvent(
  event: ParsedKapsoEvent,
  deps: PipelineDeps,
  config: PipelineConfig,
): Promise<PipelineOutcome> {
  // Entregas, lecturas, fallos y envíos propios (`cloud_api`) llegan aquí como
  // 'ignore'. Ni pausan ni responden ni consumen una toma de evento.
  if (event.kind === 'ignore') {
    deps.logger.info('event_ignored', { stage: 'parse' });
    return { kind: 'ignored' };
  }

  const conversation = deps.conversation(event.phone);
  const claim = await deps.store.claimEvent({
    eventId: event.eventId,
    eventName: event.kind === 'owner' ? 'whatsapp.message.sent' : 'whatsapp.message.received',
    messageId: event.messageId,
    leaseSeconds: config.leaseSeconds,
  });

  if (!claim.claimed) {
    deps.logger.info('event_duplicate', {
      conversation,
      status: claim.currentStatus,
      attempts: claim.attempt,
      claimed: false,
    });
    return { kind: 'duplicate' };
  }

  let outcome: PipelineOutcome;
  try {
    outcome = await handleClaimed(event, deps, config, conversation, claim.attempt);
  } catch (error) {
    // Deja el evento en 'failed', que sí es reclamable por el siguiente
    // reintento de Kapso, salvo que ya se hubiera enviado algo.
    await deps.store.failEvent(event.eventId, 'error');
    deps.logger.error('event_failed', { conversation, code: normalizeError(error) });
    throw error;
  }

  await maybePurge(deps, config);
  return outcome;
}

async function handleClaimed(
  event: Extract<ParsedKapsoEvent, { kind: 'customer' | 'owner' }>,
  deps: PipelineDeps,
  config: PipelineConfig,
  conversation: string,
  attempts: number,
): Promise<PipelineOutcome> {
  const { store, engine, logger } = deps;

  if (event.kind === 'owner') {
    // La renovación la resuelve la función SQL con GREATEST: un evento que
    // llegue tarde extiende la pausa o la deja igual, nunca la acorta.
    await store.renewHumanPause({
      phone: event.phone,
      ownerMessageId: event.messageId,
      minutes: config.humanPauseMinutes,
    });
    await store.completeEvent(event.eventId, 'human_pause');
    logger.info('human_pause_renewed', { conversation, attempts });
    return { kind: 'human_pause' };
  }

  const silence = async (reason: string): Promise<PipelineOutcome> => {
    await store.completeEvent(event.eventId, `silent:${reason}`);
    logger.info('decision_silent', { conversation, reason, attempts });
    return { kind: 'silent', reason };
  };

  // Comprobaciones sin red antes de tocar la base o el motor.
  const blocked = preflight({
    responsesEnabled: config.responsesEnabled,
    knowledge: deps.knowledge,
    incomingText: event.text,
  });
  if (blocked) {
    const detail =
      blocked.reason === 'responses_disabled' && config.disabledReason
        ? `${blocked.reason}:${config.disabledReason}`
        : blocked.reason;
    return silence(detail);
  }

  // A partir de aquí el sistema está operativo, así que el turno del cliente
  // sí aporta contexto. Antes no se guarda nada: no tiene sentido acumular
  // mensajes de personas para un servicio que está apagado.
  await store.appendTurn({
    phone: event.phone,
    role: 'customer',
    body: event.text,
    messageId: event.messageId,
  });

  if (await store.isPaused(event.phone)) return silence('human_pause');

  const history = await store.recentTurns({
    phone: event.phone,
    limit: config.contextWindowMessages,
    maxAgeMinutes: config.contextWindowMinutes,
  });
  const clarifyAllowed = computeClarifyAllowed(history);

  const decision = await engine.decide({
    incomingText: event.text,
    history,
    knowledge: deps.knowledge,
    clarifyAllowed,
  });

  logger.info('decision_taken', {
    conversation,
    outcome: decisionOutcome(decision),
    turns: history.length,
    clarifyAllowed,
  });

  if (decision.action === 'silent') return silence(decision.reason);

  // Barrera obligatoria: el dueño pudo contestar mientras el motor decidía.
  // Es una lectura nueva, no el resultado cacheado de la comprobación previa.
  if (!(await store.canDeliver(event.phone))) return silence('human_pause');

  if (!config.deliveryConfigured) return silence('responses_disabled');

  const sentMessageId = await deps.send({ to: event.phone, body: decision.message });

  // Cuanto antes quede grabado, más corta es la ventana en la que un reclamo
  // posterior podría reenviar el mismo mensaje.
  await store.markDelivered(event.eventId, sentMessageId);
  await store.appendTurn({
    phone: event.phone,
    role: 'business',
    body: decision.message,
    messageId: sentMessageId,
    action: decision.action,
  });
  await store.completeEvent(event.eventId, decisionOutcome(decision));

  logger.info('message_sent', { conversation, action: decision.action, attempts });
  return { kind: 'sent', action: decision.action };
}

/**
 * Purga muestreada.
 *
 * No hay cron ni servicio externo: se aprovecha una fracción pequeña de los
 * eventos que ya terminaron. Cualquier fallo se traga, porque una purga nunca
 * puede impedir atender un mensaje.
 */
async function maybePurge(deps: PipelineDeps, config: PipelineConfig): Promise<void> {
  if (config.purgeSampleRate <= 0) return;
  if ((deps.random ?? Math.random)() >= config.purgeSampleRate) return;

  const started = Date.now();
  try {
    await deps.store.purgeExpiredData();
    deps.logger.info('purge_done', { durationMs: Date.now() - started });
  } catch (error) {
    deps.logger.warn('purge_failed', { code: normalizeError(error) });
  }
}
