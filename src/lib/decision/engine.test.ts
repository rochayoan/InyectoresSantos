import { describe, expect, it, vi } from 'vitest';
import type { BusinessKnowledge } from '@/config/business';
import { silent, type Decision } from '@/lib/decision/contract';
import {
  createSilentEngine,
  preflight,
  resolveDecisionEngine,
  withSafeFallback,
  type DecisionEngine,
  type DecisionRequest,
} from '@/lib/decision/engine';

const EMPTY_KNOWLEDGE: BusinessKnowledge = { blocks: [], voice: [], rules: [] };

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

function request(overrides: Partial<DecisionRequest> = {}): DecisionRequest {
  return {
    incomingText: 'donde quedan?',
    history: [],
    knowledge: READY_KNOWLEDGE,
    clarifyAllowed: true,
    ...overrides,
  };
}

function engineThat(decide: DecisionEngine['decide']): DecisionEngine {
  return { name: 'doble', decide };
}

describe('createSilentEngine', () => {
  it('calla siempre', async () => {
    const engine = createSilentEngine();
    await expect(engine.decide(request())).resolves.toEqual({
      action: 'silent',
      reason: 'engine_not_configured',
    });
  });
});

describe('withSafeFallback', () => {
  it('deja pasar una decisión normal', async () => {
    const decision: Decision = { action: 'reply', message: 'hola', sources: ['loc-1'] };
    const engine = withSafeFallback(engineThat(async () => decision), 1_000);
    await expect(engine.decide(request())).resolves.toEqual(decision);
  });

  it('convierte una excepción en silencio', async () => {
    const engine = withSafeFallback(
      engineThat(async () => {
        throw new Error('boom');
      }),
      1_000,
    );
    await expect(engine.decide(request())).resolves.toEqual(silent('engine_unavailable'));
  });

  it('convierte un rechazo sin Error en silencio', async () => {
    const engine = withSafeFallback(engineThat(() => Promise.reject('nope')), 1_000);
    await expect(engine.decide(request())).resolves.toEqual(silent('engine_unavailable'));
  });

  it('convierte un motor lento en silencio', async () => {
    const slow = engineThat(
      () => new Promise<Decision>((resolve) => setTimeout(() => resolve(silent('out_of_scope')), 200)),
    );
    const engine = withSafeFallback(slow, 10);
    await expect(engine.decide(request())).resolves.toEqual(silent('engine_timeout'));
  });

  it('avisa al motor de que debe abortar cuando se agota el tiempo', async () => {
    const seen: Array<boolean | undefined> = [];
    const slow = engineThat(
      (input) =>
        new Promise<Decision>((resolve) => {
          input.signal?.addEventListener('abort', () => seen.push(true));
          setTimeout(() => resolve(silent('out_of_scope')), 200);
        }),
    );
    await withSafeFallback(slow, 10).decide(request());
    await vi.waitFor(() => expect(seen).toEqual([true]));
  });
});

describe('preflight', () => {
  it('calla ante un mensaje vacío', () => {
    const blocked = preflight({
      responsesEnabled: true,
      knowledge: READY_KNOWLEDGE,
      incomingText: '   ',
    });
    expect(blocked).toEqual(silent('empty_message'));
  });

  it('calla mientras el flag está apagado', () => {
    const blocked = preflight({
      responsesEnabled: false,
      knowledge: READY_KNOWLEDGE,
      incomingText: 'hola',
    });
    expect(blocked).toEqual(silent('responses_disabled'));
  });

  it('calla con la información autorizada vacía aunque el flag esté encendido', () => {
    const blocked = preflight({
      responsesEnabled: true,
      knowledge: EMPTY_KNOWLEDGE,
      incomingText: 'hola',
    });
    expect(blocked).toEqual(silent('knowledge_not_ready'));
  });

  it('deja seguir cuando todo está en su sitio', () => {
    const blocked = preflight({
      responsesEnabled: true,
      knowledge: READY_KNOWLEDGE,
      incomingText: 'hola',
    });
    expect(blocked).toBeNull();
  });
});

describe('resolveDecisionEngine', () => {
  it('el motor activo de esta fase no puede responder nada', async () => {
    const decision = await resolveDecisionEngine({ timeoutMs: 1_000 }).decide(request());
    expect(decision).toEqual(silent('engine_not_configured'));
  });
});
