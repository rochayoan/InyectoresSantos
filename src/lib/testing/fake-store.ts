import type { BusinessAction, EventStatus, HistoryTurn, Store } from '@/lib/ports';

/**
 * Implementación en memoria de los puertos, SOLO para pruebas.
 *
 * Reproduce a mano la semántica de las funciones SQL de la migración: el
 * arrendamiento, el bloqueo por `sent_message_id`, el GREATEST de la pausa y
 * las ventanas del historial.
 *
 * Importante: esto NO verifica el SQL. Codifica el comportamiento que
 * esperamos de él, de modo que el pipeline se pueda probar entero sin base de
 * datos. Que la función de Postgres se comporte igual se comprueba contra
 * Supabase en la fase de infraestructura.
 */

export interface FakeEventRow {
  eventId: string;
  eventName: string;
  messageId: string;
  status: Exclude<EventStatus, 'unknown'>;
  attempts: number;
  leaseExpiresAt: number;
  sentMessageId: string | null;
  outcome: string | null;
  createdAt: number;
}

export interface FakePauseRow {
  phone: string;
  startedAt: number;
  expiresAt: number;
  lastOwnerMessageId: string;
}

export interface FakeTurnRow {
  phone: string;
  role: HistoryTurn['role'];
  body: string;
  messageId: string | null;
  action?: BusinessAction;
  at: number;
  seq: number;
}

export interface FakeStore extends Store {
  readonly events: Map<string, FakeEventRow>;
  readonly pauses: Map<string, FakePauseRow>;
  readonly turns: FakeTurnRow[];
  now(): number;
  advance(ms: number): void;
  /** Hace fallar la próxima purga, para comprobar que no rompe nada. */
  failNextPurge(error?: Error): void;
  purgeCalls: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function createFakeStore(options: { now?: number } = {}): FakeStore {
  let clock = options.now ?? Date.parse('2026-08-28T10:00:00.000Z');
  let seq = 0;
  let purgeError: Error | null = null;

  const events = new Map<string, FakeEventRow>();
  const pauses = new Map<string, FakePauseRow>();
  const turns: FakeTurnRow[] = [];

  const requireEvent = (eventId: string): FakeEventRow => {
    const row = events.get(eventId);
    if (!row) throw new Error(`event_update_failed:missing:${eventId}`);
    return row;
  };

  async function isPaused(phone: string, now?: Date): Promise<boolean> {
    const at = now ? now.getTime() : clock;
    const row = pauses.get(phone);
    return row ? row.expiresAt > at : false;
  }

  const store: FakeStore = {
    events,
    pauses,
    turns,
    purgeCalls: 0,

    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    failNextPurge: (error) => {
      purgeError = error ?? new Error('purge_failed:57014');
    },

    async claimEvent({ eventId, eventName, messageId, leaseSeconds }) {
      const existing = events.get(eventId);

      if (!existing) {
        events.set(eventId, {
          eventId,
          eventName,
          messageId,
          status: 'processing',
          attempts: 1,
          leaseExpiresAt: clock + leaseSeconds * 1_000,
          sentMessageId: null,
          outcome: null,
          createdAt: clock,
        });
        return { claimed: true, attempt: 1, currentStatus: 'processing', deliveredMessageId: null };
      }

      // Un evento con entrega registrada no se vuelve a tomar jamás: es lo
      // que impide escribirle dos veces al mismo cliente.
      const recoverable =
        existing.sentMessageId === null &&
        (existing.status === 'failed' ||
          (existing.status === 'processing' && existing.leaseExpiresAt < clock));

      if (!recoverable) {
        return {
          claimed: false,
          attempt: existing.attempts,
          currentStatus: existing.status,
          deliveredMessageId: existing.sentMessageId,
        };
      }

      existing.status = 'processing';
      existing.attempts += 1;
      existing.leaseExpiresAt = clock + leaseSeconds * 1_000;
      existing.outcome = null;
      return {
        claimed: true,
        attempt: existing.attempts,
        currentStatus: 'processing',
        deliveredMessageId: null,
      };
    },

    async markDelivered(eventId, sentMessageId) {
      const row = requireEvent(eventId);
      if (row.sentMessageId === null) row.sentMessageId = sentMessageId;
    },

    async completeEvent(eventId, outcome) {
      const row = requireEvent(eventId);
      row.status = 'processed';
      row.outcome = outcome;
    },

    async failEvent(eventId, outcome) {
      const row = requireEvent(eventId);
      row.status = 'failed';
      row.outcome = outcome;
    },

    async renewHumanPause({ phone, ownerMessageId, minutes }) {
      const until = clock + minutes * MINUTE;
      const row = pauses.get(phone);

      if (!row) {
        pauses.set(phone, {
          phone,
          startedAt: clock,
          expiresAt: until,
          lastOwnerMessageId: ownerMessageId,
        });
        return new Date(until).toISOString();
      }

      // Conserva el inicio si la pausa seguía viva; GREATEST sobre el
      // vencimiento, para que un evento atrasado nunca la acorte.
      row.startedAt = row.expiresAt > clock ? row.startedAt : clock;
      row.expiresAt = Math.max(row.expiresAt, until);
      row.lastOwnerMessageId = ownerMessageId;
      return new Date(row.expiresAt).toISOString();
    },

    isPaused,

    async canDeliver(phone) {
      return !(await isPaused(phone));
    },

    async appendTurn({ phone, role, body, messageId, action }) {
      if (messageId !== null && turns.some((turn) => turn.messageId === messageId)) return;
      seq += 1;
      turns.push({ phone, role, body, messageId, at: clock, seq, ...(action ? { action } : {}) });
    },

    async recentTurns({ phone, limit, maxAgeMinutes }) {
      if (limit <= 0) return [];
      const since = clock - maxAgeMinutes * MINUTE;

      return turns
        .filter((turn) => turn.phone === phone && turn.at >= since)
        .sort((a, b) => b.at - a.at || b.seq - a.seq)
        .slice(0, limit)
        .reverse()
        .map((turn) => ({
          role: turn.role,
          body: turn.body,
          at: new Date(turn.at).toISOString(),
          ...(turn.action ? { action: turn.action } : {}),
        }));
    },

    async purgeExpiredData() {
      store.purgeCalls += 1;
      if (purgeError) {
        const error = purgeError;
        purgeError = null;
        throw error;
      }

      for (let index = turns.length - 1; index >= 0; index -= 1) {
        if (turns[index]!.at < clock - 24 * HOUR) turns.splice(index, 1);
      }
      for (const [id, row] of events) {
        if (row.createdAt < clock - 7 * DAY) events.delete(id);
      }
      for (const [phone, row] of pauses) {
        if (row.expiresAt < clock - DAY) pauses.delete(phone);
      }
    },
  };

  return store;
}
