import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BusinessAction, EventClaim, EventStatus, HistoryTurn, Store } from '@/lib/ports';

/**
 * Implementación de los puertos sobre Supabase.
 *
 * Las dos operaciones con carrera —tomar un evento y renovar la pausa— no se
 * hacen leyendo y escribiendo por separado, sino llamando a las funciones SQL
 * de la migración, que resuelven el conflicto dentro de una sola sentencia.
 */

interface PostgrestFailure {
  readonly code?: string;
}

const DUPLICATE_KEY = '23505';

function failure(prefix: string, error: PostgrestFailure | null): Error {
  return new Error(`${prefix}:${error?.code ?? 'unknown'}`);
}

function toStatus(value: unknown): EventStatus {
  return value === 'processing' || value === 'processed' || value === 'failed'
    ? value
    : 'unknown';
}

function toAction(value: unknown): BusinessAction | undefined {
  return value === 'reply' || value === 'clarify' ? value : undefined;
}

interface HistoryRow {
  readonly role: string;
  readonly body: string;
  readonly created_at: string;
  readonly business_action: string | null;
}

function toTurn(row: HistoryRow): HistoryTurn {
  const action = toAction(row.business_action);
  return {
    role: row.role === 'business' ? 'business' : 'customer',
    body: row.body,
    at: row.created_at,
    ...(action ? { action } : {}),
  };
}

export function createStore(url: string, serviceRoleKey: string): Store {
  return createStoreFrom(
    createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    }),
  );
}

/**
 * Separado de `createStore` para poder ejercitar el adaptador contra un doble
 * del cliente de Supabase, sin red ni claves.
 */
export function createStoreFrom(db: SupabaseClient): Store {
  async function isPaused(phone: string, now = new Date()): Promise<boolean> {
    const { data, error } = await db
      .from('chat_control')
      .select('pause_expires_at')
      .eq('customer_phone', phone)
      .maybeSingle<{ pause_expires_at: string }>();
    if (error) throw failure('pause_read_failed', error);
    return data ? new Date(data.pause_expires_at).getTime() > now.getTime() : false;
  }

  async function updateEvent(eventId: string, values: Record<string, unknown>): Promise<void> {
    const { error } = await db
      .from('webhook_events')
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq('event_id', eventId);
    if (error) throw failure('event_update_failed', error);
  }

  return {
    async claimEvent({ eventId, eventName, messageId, leaseSeconds }) {
      // Atómica por diseño: insertar-o-recuperar en una sola sentencia. Un
      // SELECT seguido de INSERT dejaría una ventana en la que dos entregas
      // del mismo evento pasarían las dos.
      const { data, error } = await db.rpc('claim_webhook_event', {
        p_event_id: eventId,
        p_event_name: eventName,
        p_message_id: messageId,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw failure('event_claim_failed', error);

      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (!row) throw new Error('event_claim_failed:empty_result');

      const claim: EventClaim = {
        claimed: row.claimed === true,
        attempt: Number(row.attempt_count) || 0,
        currentStatus: toStatus(row.current_status),
        deliveredMessageId: (row.delivered_message_id as string | null) ?? null,
      };
      return claim;
    },

    async markDelivered(eventId, sentMessageId) {
      // Solo escribe si todavía no había entrega registrada. A partir de aquí
      // `claim_webhook_event` no volverá a tomar este evento nunca.
      const { error } = await db
        .from('webhook_events')
        .update({ sent_message_id: sentMessageId, updated_at: new Date().toISOString() })
        .eq('event_id', eventId)
        .is('sent_message_id', null);
      if (error) throw failure('event_delivery_failed', error);
    },

    async completeEvent(eventId, outcome) {
      await updateEvent(eventId, {
        status: 'processed',
        outcome,
        processed_at: new Date().toISOString(),
      });
    },

    async failEvent(eventId, outcome) {
      // Deja el evento reclamable por el siguiente reintento de Kapso, salvo
      // que ya tenga `sent_message_id`, en cuyo caso el reclamo lo rechaza.
      await updateEvent(eventId, { status: 'failed', outcome });
    },

    async renewHumanPause({ phone, ownerMessageId, minutes }) {
      const { data, error } = await db.rpc('renew_human_pause', {
        p_customer_phone: phone,
        p_owner_message_id: ownerMessageId,
        p_minutes: minutes,
      });
      if (error) throw failure('pause_failed', error);
      if (typeof data !== 'string') throw new Error('pause_failed:empty_result');
      return data;
    },

    isPaused,

    async canDeliver(phone) {
      return !(await isPaused(phone));
    },

    async appendTurn({ phone, role, body, messageId, action }) {
      const { error } = await db.from('conversation_messages').insert({
        customer_phone: phone,
        role,
        body,
        message_id: messageId,
        business_action: action ?? null,
      });
      if (!error) return;
      // Mismo `message_id`: el turno ya estaba guardado por una entrega
      // anterior del mismo evento. No es un fallo.
      if (error.code === DUPLICATE_KEY) return;
      throw failure('history_append_failed', error);
    },

    async recentTurns({ phone, limit, maxAgeMinutes }) {
      if (limit <= 0) return [];

      const since = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
      const { data, error } = await db
        .from('conversation_messages')
        .select('role, body, created_at, business_action')
        .eq('customer_phone', phone)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
      if (error) throw failure('history_read_failed', error);

      // La consulta trae los más recientes; el motor los quiere en orden
      // cronológico.
      return ((data ?? []) as HistoryRow[]).map(toTurn).reverse();
    },

    async purgeExpiredData() {
      const { error } = await db.rpc('purge_expired_data', {});
      if (error) throw failure('purge_failed', error);
    },
  };
}
