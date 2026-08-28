import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createStoreFrom } from '@/lib/store';

/**
 * Doble del cliente de Supabase.
 *
 * Registra qué se llamó y devuelve resultados preparados. No comprueba el
 * comportamiento de Postgres —eso solo se puede verificar contra la base
 * real—, sino que el adaptador use las funciones RPC y construya bien las
 * consultas.
 */
interface Recorded {
  readonly table?: string;
  readonly rpc?: string;
  readonly args?: unknown;
  readonly chain: Array<[string, unknown[]]>;
}

interface Result {
  readonly data?: unknown;
  readonly error?: { code?: string } | null;
}

const CHAIN_METHODS = [
  'select',
  'insert',
  'update',
  'upsert',
  'eq',
  'gte',
  'is',
  'order',
  'limit',
  'maybeSingle',
] as const;

function createDbDouble(results: Result[] = []) {
  const recorded: Recorded[] = [];
  let index = 0;

  const next = (): Result => results[index++] ?? { data: null, error: null };

  const builder = (entry: Recorded) => {
    const chain: Record<string, unknown> = {
      then: (resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(next()).then(resolve, reject),
    };
    for (const method of CHAIN_METHODS) {
      chain[method] = (...args: unknown[]) => {
        entry.chain.push([method, args]);
        return chain;
      };
    }
    return chain;
  };

  const db = {
    from(table: string) {
      const entry: Recorded = { table, chain: [] };
      recorded.push(entry);
      return builder(entry);
    },
    rpc(rpc: string, args: unknown) {
      const entry: Recorded = { rpc, args, chain: [] };
      recorded.push(entry);
      return builder(entry);
    },
  };

  return { db: db as unknown as SupabaseClient, recorded };
}

function chainArgs(entry: Recorded, method: string): unknown[] | undefined {
  return entry.chain.find(([name]) => name === method)?.[1];
}

const CLAIM_INPUT = {
  eventId: 'evt-1',
  eventName: 'whatsapp.message.received',
  messageId: 'wamid.1',
  leaseSeconds: 45,
};

describe('claimEvent', () => {
  it('usa la función RPC atómica, no un SELECT seguido de INSERT', async () => {
    const { db, recorded } = createDbDouble([
      {
        data: [
          {
            claimed: true,
            attempt_count: 1,
            current_status: 'processing',
            delivered_message_id: null,
          },
        ],
      },
    ]);

    const claim = await createStoreFrom(db).claimEvent(CLAIM_INPUT);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.rpc).toBe('claim_webhook_event');
    expect(recorded[0]?.table).toBeUndefined();
    expect(recorded[0]?.args).toEqual({
      p_event_id: 'evt-1',
      p_event_name: 'whatsapp.message.received',
      p_message_id: 'wamid.1',
      p_lease_seconds: 45,
    });
    expect(claim).toEqual({
      claimed: true,
      attempt: 1,
      currentStatus: 'processing',
      deliveredMessageId: null,
    });
  });

  it('traduce el rechazo de un evento ya entregado', async () => {
    const { db } = createDbDouble([
      {
        data: [
          {
            claimed: false,
            attempt_count: 3,
            current_status: 'processed',
            delivered_message_id: 'wamid.sent',
          },
        ],
      },
    ]);

    expect(await createStoreFrom(db).claimEvent(CLAIM_INPUT)).toEqual({
      claimed: false,
      attempt: 3,
      currentStatus: 'processed',
      deliveredMessageId: 'wamid.sent',
    });
  });

  it('normaliza un estado desconocido', async () => {
    const { db } = createDbDouble([
      { data: [{ claimed: false, attempt_count: 0, current_status: 'unknown', delivered_message_id: null }] },
    ]);
    expect((await createStoreFrom(db).claimEvent(CLAIM_INPUT)).currentStatus).toBe('unknown');
  });

  it('falla con el código de Postgres', async () => {
    const { db } = createDbDouble([{ error: { code: '42883' } }]);
    await expect(createStoreFrom(db).claimEvent(CLAIM_INPUT)).rejects.toThrow(
      'event_claim_failed:42883',
    );
  });

  it('falla si la función no devuelve fila', async () => {
    const { db } = createDbDouble([{ data: [] }]);
    await expect(createStoreFrom(db).claimEvent(CLAIM_INPUT)).rejects.toThrow(
      'event_claim_failed:empty_result',
    );
  });
});

describe('markDelivered', () => {
  it('solo escribe si todavía no había entrega registrada', async () => {
    const { db, recorded } = createDbDouble([{}]);
    await createStoreFrom(db).markDelivered('evt-1', 'wamid.sent');

    expect(recorded[0]?.table).toBe('webhook_events');
    expect(chainArgs(recorded[0]!, 'is')).toEqual(['sent_message_id', null]);
    expect(chainArgs(recorded[0]!, 'eq')).toEqual(['event_id', 'evt-1']);
  });
});

describe('completeEvent y failEvent', () => {
  it('cierra el evento como procesado', async () => {
    const { db, recorded } = createDbDouble([{}]);
    await createStoreFrom(db).completeEvent('evt-1', 'silent:out_of_scope');

    const [values] = chainArgs(recorded[0]!, 'update') as [Record<string, unknown>];
    expect(values.status).toBe('processed');
    expect(values.outcome).toBe('silent:out_of_scope');
  });

  it('deja el evento en failed para que se pueda recuperar', async () => {
    const { db, recorded } = createDbDouble([{}]);
    await createStoreFrom(db).failEvent('evt-1', 'error');

    const [values] = chainArgs(recorded[0]!, 'update') as [Record<string, unknown>];
    expect(values.status).toBe('failed');
    expect(values.sent_message_id).toBeUndefined();
  });
});

describe('renewHumanPause', () => {
  it('delega en la función SQL con GREATEST', async () => {
    const { db, recorded } = createDbDouble([{ data: '2026-08-28T10:30:00.000Z' }]);

    const until = await createStoreFrom(db).renewHumanPause({
      phone: '59170000001',
      ownerMessageId: 'wamid.o1',
      minutes: 30,
    });

    expect(recorded[0]?.rpc).toBe('renew_human_pause');
    expect(recorded[0]?.args).toEqual({
      p_customer_phone: '59170000001',
      p_owner_message_id: 'wamid.o1',
      p_minutes: 30,
    });
    expect(until).toBe('2026-08-28T10:30:00.000Z');
  });
});

describe('isPaused y canDeliver', () => {
  it('una pausa vencida no pausa', async () => {
    const { db } = createDbDouble([{ data: { pause_expires_at: '2020-01-01T00:00:00.000Z' } }]);
    expect(await createStoreFrom(db).isPaused('59170000001')).toBe(false);
  });

  it('sin fila no hay pausa', async () => {
    const { db } = createDbDouble([{ data: null }]);
    expect(await createStoreFrom(db).isPaused('59170000001')).toBe(false);
  });

  it('canDeliver es lo contrario de isPaused', async () => {
    const { db } = createDbDouble([{ data: { pause_expires_at: '2999-01-01T00:00:00.000Z' } }]);
    expect(await createStoreFrom(db).canDeliver('59170000001')).toBe(false);
  });
});

describe('appendTurn', () => {
  it('guarda el turno con su acción', async () => {
    const { db, recorded } = createDbDouble([{}]);
    await createStoreFrom(db).appendTurn({
      phone: '59170000001',
      role: 'business',
      body: 'texto',
      messageId: 'wamid.sent',
      action: 'clarify',
    });

    const [values] = chainArgs(recorded[0]!, 'insert') as [Record<string, unknown>];
    expect(values).toEqual({
      customer_phone: '59170000001',
      role: 'business',
      body: 'texto',
      message_id: 'wamid.sent',
      business_action: 'clarify',
    });
  });

  it('un message_id repetido no es un fallo', async () => {
    const { db } = createDbDouble([{ error: { code: '23505' } }]);
    await expect(
      createStoreFrom(db).appendTurn({
        phone: '59170000001',
        role: 'customer',
        body: 'texto',
        messageId: 'wamid.1',
      }),
    ).resolves.toBeUndefined();
  });

  it('cualquier otro error sí lo es', async () => {
    const { db } = createDbDouble([{ error: { code: '23514' } }]);
    await expect(
      createStoreFrom(db).appendTurn({
        phone: '59170000001',
        role: 'customer',
        body: 'texto',
        messageId: null,
      }),
    ).rejects.toThrow('history_append_failed:23514');
  });
});

describe('recentTurns', () => {
  it('acota por teléfono, antigüedad y cantidad, y devuelve orden cronológico', async () => {
    const { db, recorded } = createDbDouble([
      {
        data: [
          { role: 'business', body: 'segundo', created_at: '2026-08-28T10:01:00.000Z', business_action: 'clarify' },
          { role: 'customer', body: 'primero', created_at: '2026-08-28T10:00:00.000Z', business_action: null },
        ],
      },
    ]);

    const turns = await createStoreFrom(db).recentTurns({
      phone: '59170000001',
      limit: 6,
      maxAgeMinutes: 30,
    });

    expect(recorded[0]?.table).toBe('conversation_messages');
    expect(chainArgs(recorded[0]!, 'eq')).toEqual(['customer_phone', '59170000001']);
    expect(chainArgs(recorded[0]!, 'gte')?.[0]).toBe('created_at');
    expect(chainArgs(recorded[0]!, 'order')).toEqual(['created_at', { ascending: false }]);
    expect(chainArgs(recorded[0]!, 'limit')).toEqual([6]);

    // La consulta trae los más recientes primero; el motor los recibe al revés.
    expect(turns).toEqual([
      { role: 'customer', body: 'primero', at: '2026-08-28T10:00:00.000Z' },
      { role: 'business', body: 'segundo', at: '2026-08-28T10:01:00.000Z', action: 'clarify' },
    ]);
  });

  it('no consulta nada si la ventana es cero', async () => {
    const { db, recorded } = createDbDouble([]);
    expect(
      await createStoreFrom(db).recentTurns({ phone: '59170000001', limit: 0, maxAgeMinutes: 30 }),
    ).toEqual([]);
    expect(recorded).toHaveLength(0);
  });
});

describe('purgeExpiredData', () => {
  it('delega en la función SQL', async () => {
    const { db, recorded } = createDbDouble([{}]);
    await createStoreFrom(db).purgeExpiredData();
    expect(recorded[0]?.rpc).toBe('purge_expired_data');
  });

  it('propaga el fallo para que el pipeline lo trague', async () => {
    const { db } = createDbDouble([{ error: { code: '57014' } }]);
    await expect(createStoreFrom(db).purgeExpiredData()).rejects.toThrow('purge_failed:57014');
  });
});
