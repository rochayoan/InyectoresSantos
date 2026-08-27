import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export function createStore(url: string, serviceRoleKey: string) {
  const db = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    async claimEvent(eventId: string, eventName: string, messageId: string): Promise<boolean> {
      const { error } = await db.from('webhook_events').insert({
        event_id: eventId,
        event_name: eventName,
        message_id: messageId,
        status: 'processing',
      });
      if (!error) return true;
      if (error.code === '23505') return false;
      throw new Error(`event_claim_failed:${error.code ?? 'unknown'}`);
    },

    async completeEvent(eventId: string, outcome: string): Promise<void> {
      await updateEvent(db, eventId, { status: 'processed', outcome, processed_at: new Date().toISOString() });
    },

    async failEvent(eventId: string): Promise<void> {
      await updateEvent(db, eventId, { status: 'failed', outcome: 'error' });
    },

    async pauseChat(phone: string, until: string, ownerMessageId: string): Promise<void> {
      const { error } = await db.from('chat_control').upsert(
        {
          customer_phone: phone,
          pause_expires_at: until,
          last_owner_message_id: ownerMessageId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'customer_phone' },
      );
      if (error) throw new Error(`pause_failed:${error.code ?? 'unknown'}`);
    },

    async isPaused(phone: string, now = new Date()): Promise<boolean> {
      const { data, error } = await db
        .from('chat_control')
        .select('pause_expires_at')
        .eq('customer_phone', phone)
        .maybeSingle<{ pause_expires_at: string }>();
      if (error) throw new Error(`pause_read_failed:${error.code ?? 'unknown'}`);
      return data ? new Date(data.pause_expires_at).getTime() > now.getTime() : false;
    },
  };
}

async function updateEvent(
  db: SupabaseClient,
  eventId: string,
  values: Record<string, unknown>,
): Promise<void> {
  const { error } = await db.from('webhook_events').update(values).eq('event_id', eventId);
  if (error) throw new Error(`event_update_failed:${error.code ?? 'unknown'}`);
}
