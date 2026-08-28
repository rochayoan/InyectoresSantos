import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBusinessKnowledge, type BusinessKnowledge } from '@/config/business';
import { silent, type Decision } from '@/lib/decision/contract';
import { resolveDecisionEngine, type DecisionEngine, type DecisionRequest } from '@/lib/decision/engine';
import { createLogger, type LogRecord } from '@/lib/logger';
import { processEvent, type PipelineConfig, type PipelineDeps } from '@/lib/pipeline';
import type { ParsedKapsoEvent } from '@/lib/provenance';
import { createFakeStore, type FakeStore } from '@/lib/testing/fake-store';

const CUSTOMER = '59170000001';
const OTHER_CUSTOMER = '59170000002';

const READY_KNOWLEDGE: BusinessKnowledge = {
  blocks: [
    { id: 'info-1', kind: 'info', label: 'info 1', content: 'texto', order: 1 },
    { id: 'info-2', kind: 'info', label: 'info 2', content: 'texto', order: 2 },
    { id: 'loc-1', kind: 'location', label: 'sucursal 1', content: 'texto', order: 1 },
    { id: 'loc-2', kind: 'location', label: 'sucursal 2', content: 'texto', order: 2 },
    { id: 'horarios', kind: 'hours', label: 'horarios', content: 'texto', order: 1 },
    { id: 'servicio', kind: 'service', label: 'servicio', content: 'texto', order: 1 },
  ],
  voice: [{ id: 'voz-1', text: 'asi escribe el dueno' }],
  rules: [],
};

const REPLY: Decision = { action: 'reply', message: 'Estamos en el tercer anillo.', sources: ['loc-1'] };
const CLARIFY: Decision = { action: 'clarify', message: 'Cual de las dos?', sources: ['loc-1', 'loc-2'] };

function customerEvent(overrides: Partial<Extract<ParsedKapsoEvent, { kind: 'customer' }>> = {}) {
  return {
    kind: 'customer' as const,
    eventId: 'evt-1',
    messageId: 'wamid.c1',
    phone: CUSTOMER,
    text: 'donde quedan?',
    ...overrides,
  };
}

function ownerEvent(overrides: Partial<Extract<ParsedKapsoEvent, { kind: 'owner' }>> = {}) {
  return {
    kind: 'owner' as const,
    eventId: 'evt-owner-1',
    messageId: 'wamid.o1',
    phone: CUSTOMER,
    ...overrides,
  };
}

function engineReturning(decision: Decision): DecisionEngine {
  return { name: 'doble', decide: async () => decision };
}

const CONFIG: PipelineConfig = {
  responsesEnabled: true,
  deliveryConfigured: true,
  disabledReason: null,
  humanPauseMinutes: 30,
  contextWindowMessages: 6,
  contextWindowMinutes: 30,
  leaseSeconds: 45,
  purgeSampleRate: 0,
};

let store: FakeStore;
let send: ReturnType<typeof vi.fn>;
let records: LogRecord[];

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    store,
    engine: engineReturning(silent('out_of_scope')),
    send: send as unknown as PipelineDeps['send'],
    logger: createLogger({ sink: (record) => records.push(record) }),
    knowledge: READY_KNOWLEDGE,
    conversation: () => 'chat-ref',
    ...overrides,
  };
}

function config(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return { ...CONFIG, ...overrides };
}

beforeEach(() => {
  store = createFakeStore();
  send = vi.fn(async () => 'wamid.sent');
  records = [];
});

// --------------------------------------------------------------------------
// Reclamo recuperable
// --------------------------------------------------------------------------
describe('reclamo de eventos', () => {
  it('reclama un evento nuevo', async () => {
    const result = await processEvent(customerEvent(), deps(), config());
    expect(result).toEqual({ kind: 'silent', reason: 'out_of_scope' });
    expect(store.events.get('evt-1')).toMatchObject({ attempts: 1, status: 'processed' });
  });

  it('rechaza un duplicado ya procesado sin volver a decidir', async () => {
    const decide = vi.fn(async () => silent('out_of_scope'));
    const engine: DecisionEngine = { name: 'doble', decide };

    await processEvent(customerEvent(), deps({ engine }), config());
    const second = await processEvent(customerEvent(), deps({ engine }), config());

    expect(second).toEqual({ kind: 'duplicate' });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('recupera un evento que quedó en failed', async () => {
    const boom: DecisionEngine = {
      name: 'roto',
      decide: async () => {
        throw new Error('supabase_down');
      },
    };

    await expect(processEvent(customerEvent(), deps({ engine: boom }), config())).rejects.toThrow();
    expect(store.events.get('evt-1')).toMatchObject({ status: 'failed', attempts: 1 });

    const retry = await processEvent(customerEvent(), deps(), config());
    expect(retry).toEqual({ kind: 'silent', reason: 'out_of_scope' });
    expect(store.events.get('evt-1')).toMatchObject({ status: 'processed', attempts: 2 });
  });

  it('recupera un processing cuyo lease venció', async () => {
    await store.claimEvent({
      eventId: 'evt-1',
      eventName: 'whatsapp.message.received',
      messageId: 'wamid.c1',
      leaseSeconds: 45,
    });
    store.advance(46_000);

    const result = await processEvent(customerEvent(), deps(), config());
    expect(result).toEqual({ kind: 'silent', reason: 'out_of_scope' });
    expect(store.events.get('evt-1')?.attempts).toBe(2);
  });

  it('no recupera un processing con lease vigente', async () => {
    await store.claimEvent({
      eventId: 'evt-1',
      eventName: 'whatsapp.message.received',
      messageId: 'wamid.c1',
      leaseSeconds: 45,
    });
    store.advance(44_000);

    expect(await processEvent(customerEvent(), deps(), config())).toEqual({ kind: 'duplicate' });
    expect(store.events.get('evt-1')?.attempts).toBe(1);
  });

  it('nunca recupera un evento que ya tiene sent_message_id', async () => {
    await processEvent(customerEvent(), deps({ engine: engineReturning(REPLY) }), config());
    expect(send).toHaveBeenCalledTimes(1);
    expect(store.events.get('evt-1')?.sentMessageId).toBe('wamid.sent');

    // Aunque el evento se marque failed y venza el lease, no vuelve a salir.
    await store.failEvent('evt-1', 'error');
    store.advance(10 * 60_000);

    const retry = await processEvent(customerEvent(), deps({ engine: engineReturning(REPLY) }), config());
    expect(retry).toEqual({ kind: 'duplicate' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('completa el evento cuando la decisión es silencio, sin llamar a Kapso', async () => {
    await processEvent(customerEvent(), deps(), config());
    expect(store.events.get('evt-1')).toMatchObject({
      status: 'processed',
      outcome: 'silent:out_of_scope',
    });
    expect(send).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Pausa humana
// --------------------------------------------------------------------------
describe('pausa humana', () => {
  it('un mensaje manual del dueño activa la pausa', async () => {
    const result = await processEvent(ownerEvent(), deps(), config());
    expect(result).toEqual({ kind: 'human_pause' });
    expect(await store.isPaused(CUSTOMER)).toBe(true);
  });

  it('un evento ignorado no activa la pausa ni toma el evento', async () => {
    // cloud_api, delivered, read y failed llegan aquí ya clasificados así.
    const result = await processEvent({ kind: 'ignore', eventId: 'evt-x' }, deps(), config());
    expect(result).toEqual({ kind: 'ignored' });
    expect(store.pauses.size).toBe(0);
    expect(store.events.size).toBe(0);
  });

  it('una nueva intervención del dueño extiende la pausa', async () => {
    await processEvent(ownerEvent(), deps(), config());
    const first = store.pauses.get(CUSTOMER)!;
    const startedAt = first.startedAt;
    const firstExpiry = first.expiresAt;

    store.advance(10 * 60_000);
    await processEvent(ownerEvent({ eventId: 'evt-owner-2', messageId: 'wamid.o2' }), deps(), config());

    const second = store.pauses.get(CUSTOMER)!;
    expect(second.expiresAt).toBeGreaterThan(firstExpiry);
    // La pausa seguía viva, así que su inicio se conserva.
    expect(second.startedAt).toBe(startedAt);
  });

  it('empieza una pausa nueva cuando la anterior ya había vencido', async () => {
    await processEvent(ownerEvent(), deps(), config());
    const startedAt = store.pauses.get(CUSTOMER)!.startedAt;

    store.advance(31 * 60_000);
    await processEvent(ownerEvent({ eventId: 'evt-owner-2', messageId: 'wamid.o2' }), deps(), config());

    expect(store.pauses.get(CUSTOMER)!.startedAt).toBeGreaterThan(startedAt);
  });

  it('un evento atrasado nunca acorta una pausa', async () => {
    await store.renewHumanPause({ phone: CUSTOMER, ownerMessageId: 'wamid.o1', minutes: 30 });
    const expiry = store.pauses.get(CUSTOMER)!.expiresAt;

    // Un evento del dueño que se procesa tarde y solo pediría 5 minutos.
    await processEvent(
      ownerEvent({ eventId: 'evt-owner-late', messageId: 'wamid.late' }),
      deps(),
      config({ humanPauseMinutes: 5 }),
    );

    expect(store.pauses.get(CUSTOMER)!.expiresAt).toBe(expiry);
  });

  it('la pausa de un teléfono no afecta a otro', async () => {
    await processEvent(ownerEvent(), deps(), config());

    const result = await processEvent(
      customerEvent({ eventId: 'evt-otro', messageId: 'wamid.otro', phone: OTHER_CUSTOMER }),
      deps({ engine: engineReturning(REPLY) }),
      config(),
    );

    expect(result).toEqual({ kind: 'sent', action: 'reply' });
    expect(await store.isPaused(CUSTOMER)).toBe(true);
    expect(await store.isPaused(OTHER_CUSTOMER)).toBe(false);
  });

  it('la primera comprobación calla si el chat ya estaba pausado', async () => {
    await store.renewHumanPause({ phone: CUSTOMER, ownerMessageId: 'wamid.o1', minutes: 30 });
    const decide = vi.fn(async () => REPLY);

    const result = await processEvent(
      customerEvent(),
      deps({ engine: { name: 'doble', decide } }),
      config(),
    );

    expect(result).toEqual({ kind: 'silent', reason: 'human_pause' });
    expect(decide).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Barrera previa al envío
// --------------------------------------------------------------------------
describe('barrera previa al envío', () => {
  it('el dueño que contesta mientras el motor decide gana la carrera', async () => {
    // El motor tarda, y en ese hueco entra el mensaje manual del dueño.
    const engine: DecisionEngine = {
      name: 'lento',
      decide: async () => {
        await store.renewHumanPause({
          phone: CUSTOMER,
          ownerMessageId: 'wamid.durante',
          minutes: 30,
        });
        return REPLY;
      },
    };

    const result = await processEvent(customerEvent(), deps({ engine }), config());

    expect(result).toEqual({ kind: 'silent', reason: 'human_pause' });
    expect(send).not.toHaveBeenCalled();
    expect(store.events.get('evt-1')).toMatchObject({
      status: 'processed',
      outcome: 'silent:human_pause',
      sentMessageId: null,
    });
  });

  it('sin configuración de envío no llama a Kapso aunque la decisión sea reply', async () => {
    const result = await processEvent(
      customerEvent(),
      deps({ engine: engineReturning(REPLY) }),
      config({ deliveryConfigured: false }),
    );

    expect(result).toEqual({ kind: 'silent', reason: 'responses_disabled' });
    expect(send).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Historial corto
// --------------------------------------------------------------------------
describe('historial corto', () => {
  it('guarda el turno del cliente y el del negocio', async () => {
    await processEvent(customerEvent(), deps({ engine: engineReturning(REPLY) }), config());

    expect(store.turns.map((turn) => [turn.role, turn.action])).toEqual([
      ['customer', undefined],
      ['business', 'reply'],
    ]);
  });

  it('no guarda nada mientras las respuestas están apagadas', async () => {
    await processEvent(customerEvent(), deps(), config({ responsesEnabled: false }));
    expect(store.turns).toHaveLength(0);
  });

  it('un message_id repetido no duplica el historial', async () => {
    await store.appendTurn({
      phone: CUSTOMER,
      role: 'customer',
      body: 'donde quedan?',
      messageId: 'wamid.c1',
    });
    await processEvent(customerEvent(), deps(), config());

    expect(store.turns.filter((turn) => turn.messageId === 'wamid.c1')).toHaveLength(1);
  });

  it('entrega al motor solo el historial de ese teléfono', async () => {
    await store.appendTurn({
      phone: OTHER_CUSTOMER,
      role: 'customer',
      body: 'mensaje de otro cliente',
      messageId: 'wamid.otro',
    });

    let seen: DecisionRequest | null = null;
    const engine: DecisionEngine = {
      name: 'espia',
      decide: async (request) => {
        seen = request;
        return silent('out_of_scope');
      },
    };

    await processEvent(customerEvent(), deps({ engine }), config());

    const history = seen!.history;
    expect(history).toHaveLength(1);
    expect(history[0]?.body).toBe('donde quedan?');
  });

  it('limita el historial por cantidad y lo entrega en orden cronológico', async () => {
    for (let index = 0; index < 8; index += 1) {
      await store.appendTurn({
        phone: CUSTOMER,
        role: 'customer',
        body: `mensaje ${index}`,
        messageId: `wamid.old.${index}`,
      });
      store.advance(1_000);
    }

    let seen: DecisionRequest | null = null;
    const engine: DecisionEngine = {
      name: 'espia',
      decide: async (request) => {
        seen = request;
        return silent('out_of_scope');
      },
    };

    await processEvent(customerEvent(), deps({ engine }), config({ contextWindowMessages: 3 }));

    const bodies = seen!.history.map((turn) => turn.body);
    expect(bodies).toEqual(['mensaje 6', 'mensaje 7', 'donde quedan?']);
  });

  it('excluye del historial lo anterior a la ventana de tiempo', async () => {
    await store.appendTurn({
      phone: CUSTOMER,
      role: 'customer',
      body: 'mensaje viejo',
      messageId: 'wamid.viejo',
    });
    store.advance(31 * 60_000);

    let seen: DecisionRequest | null = null;
    const engine: DecisionEngine = {
      name: 'espia',
      decide: async (request) => {
        seen = request;
        return silent('out_of_scope');
      },
    };

    await processEvent(customerEvent(), deps({ engine }), config());

    expect(seen!.history.map((turn) => turn.body)).toEqual(['donde quedan?']);
  });
});

// --------------------------------------------------------------------------
// Aclaraciones
// --------------------------------------------------------------------------
describe('clarifyAllowed', () => {
  it('deja de ser fijo: sale del historial persistido', async () => {
    const seen: boolean[] = [];
    const engine: DecisionEngine = {
      name: 'espia',
      decide: async (request) => {
        seen.push(request.clarifyAllowed);
        return CLARIFY;
      },
    };

    await processEvent(customerEvent(), deps({ engine }), config());
    store.advance(1_000);
    await processEvent(
      customerEvent({ eventId: 'evt-2', messageId: 'wamid.c2', text: 'la de mas alla' }),
      deps({ engine }),
      config(),
    );

    expect(seen).toEqual([true, false]);
  });

  it('no permite dos aclaraciones consecutivas', async () => {
    const engine: DecisionEngine = {
      name: 'insistente',
      decide: async (request) => (request.clarifyAllowed ? CLARIFY : silent('no_authorized_information')),
    };

    const first = await processEvent(customerEvent(), deps({ engine }), config());
    expect(first).toEqual({ kind: 'sent', action: 'clarify' });

    store.advance(1_000);
    const second = await processEvent(
      customerEvent({ eventId: 'evt-2', messageId: 'wamid.c2', text: 'no se' }),
      deps({ engine }),
      config(),
    );

    expect(second).toEqual({ kind: 'silent', reason: 'no_authorized_information' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------------
// Purga
// --------------------------------------------------------------------------
describe('purga muestreada', () => {
  it('no se ejecuta cuando el muestreo no la selecciona', async () => {
    await processEvent(customerEvent(), deps({ random: () => 0.9 }), config({ purgeSampleRate: 0.02 }));
    expect(store.purgeCalls).toBe(0);
  });

  it('se ejecuta cuando el muestreo la selecciona', async () => {
    await processEvent(customerEvent(), deps({ random: () => 0 }), config({ purgeSampleRate: 0.02 }));
    expect(store.purgeCalls).toBe(1);
  });

  it('un fallo de purga no rompe el procesamiento', async () => {
    store.failNextPurge();

    const result = await processEvent(
      customerEvent(),
      deps({ random: () => 0 }),
      config({ purgeSampleRate: 1 }),
    );

    expect(result).toEqual({ kind: 'silent', reason: 'out_of_scope' });
    expect(store.events.get('evt-1')?.status).toBe('processed');
    expect(records.some((record) => record.event === 'purge_failed')).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Silencio estructural
// --------------------------------------------------------------------------
describe('silencio estructural', () => {
  it('con el motor real de esta fase nunca se llama a Kapso', async () => {
    const result = await processEvent(
      customerEvent(),
      deps({ engine: resolveDecisionEngine({ timeoutMs: 1_000 }) }),
      config(),
    );

    expect(result).toEqual({ kind: 'silent', reason: 'engine_not_configured' });
    expect(send).not.toHaveBeenCalled();
  });

  it('con la información autorizada real calla antes de decidir', async () => {
    const decide = vi.fn(async () => REPLY);

    const result = await processEvent(
      customerEvent(),
      deps({ knowledge: getBusinessKnowledge(), engine: { name: 'doble', decide } }),
      config(),
    );

    expect(result).toEqual({ kind: 'silent', reason: 'knowledge_not_ready' });
    expect(decide).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('los registros no exponen teléfonos ni textos', async () => {
    await processEvent(customerEvent(), deps({ engine: engineReturning(REPLY) }), config());

    const dump = JSON.stringify(records);
    expect(dump).not.toContain(CUSTOMER);
    expect(dump).not.toContain('donde quedan?');
    expect(dump).not.toContain(REPLY.message);
  });
});
