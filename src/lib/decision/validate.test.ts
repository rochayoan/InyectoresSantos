import { describe, expect, it } from 'vitest';
import { toSafeDecision, validateDecision, type ValidationContext } from '@/lib/decision/validate';

const AUTHORIZED_TEXT = [
  'Estamos en el tercer anillo, frente a la plaza.',
  'https://maps.example/sucursal-uno',
  'Nuestro fijo es el 3 456789 y atendemos de lunes a sabado.',
].join('\n');

function context(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    authorizedIds: new Set(['info-1', 'sucursal-1', 'sucursal-2', 'horarios']),
    authorizedText: AUTHORIZED_TEXT,
    clarifyAllowed: true,
    ...overrides,
  };
}

function raw(overrides: Record<string, unknown> = {}) {
  return {
    action: 'reply',
    message: 'Estamos en el tercer anillo, frente a la plaza.',
    sources: ['sucursal-1'],
    reason: 'not_applicable',
    ...overrides,
  };
}

describe('validateDecision — forma', () => {
  it.each([null, undefined, 'texto', 42, []])('rechaza %s', (value) => {
    expect(validateDecision(value, context())).toEqual({ ok: false, failure: 'not_an_object' });
  });

  it('rechaza una acción desconocida', () => {
    expect(validateDecision(raw({ action: 'escalate' }), context())).toEqual({
      ok: false,
      failure: 'unknown_action',
    });
  });

  it('acepta una respuesta respaldada', () => {
    expect(validateDecision(raw(), context())).toEqual({
      ok: true,
      decision: {
        action: 'reply',
        message: 'Estamos en el tercer anillo, frente a la plaza.',
        sources: ['sucursal-1'],
      },
    });
  });

  it('elimina fuentes repetidas', () => {
    const result = validateDecision(raw({ sources: ['sucursal-1', 'sucursal-1'] }), context());
    expect(result.ok && result.decision.action === 'reply' && result.decision.sources).toEqual([
      'sucursal-1',
    ]);
  });
});

describe('validateDecision — silencio', () => {
  it.each(['out_of_scope', 'no_authorized_information'])('acepta el motivo %s', (reason) => {
    const input = { action: 'silent', message: '', sources: [], reason };
    expect(validateDecision(input, context())).toEqual({
      ok: true,
      decision: { action: 'silent', reason },
    });
  });

  it('rechaza un motivo de silencio que solo puede decidir el backend', () => {
    const input = { action: 'silent', message: '', sources: [], reason: 'human_pause' };
    expect(validateDecision(input, context())).toEqual({
      ok: false,
      failure: 'unknown_silent_reason',
    });
  });
});

describe('validateDecision — respaldo obligatorio', () => {
  it('rechaza una respuesta sin fuentes', () => {
    expect(validateDecision(raw({ sources: [] }), context())).toEqual({
      ok: false,
      failure: 'sources_empty',
    });
  });

  it('rechaza una fuente inventada', () => {
    expect(validateDecision(raw({ sources: ['sucursal-9'] }), context())).toEqual({
      ok: false,
      failure: 'sources_unknown',
    });
  });

  it('rechaza demasiadas fuentes', () => {
    const sources = Array.from({ length: 7 }, () => 'sucursal-1');
    expect(validateDecision(raw({ sources }), context())).toEqual({
      ok: false,
      failure: 'sources_too_many',
    });
  });

  it('no acepta ninguna fuente cuando la información autorizada está vacía', () => {
    const empty = context({ authorizedIds: new Set<string>(), authorizedText: '' });
    expect(validateDecision(raw(), empty)).toEqual({ ok: false, failure: 'sources_unknown' });
  });
});

describe('validateDecision — mensaje', () => {
  it('rechaza un mensaje vacío', () => {
    expect(validateDecision(raw({ message: '   ' }), context())).toEqual({
      ok: false,
      failure: 'message_empty',
    });
  });

  it('rechaza una respuesta demasiado larga', () => {
    expect(validateDecision(raw({ message: 'a'.repeat(1201) }), context())).toEqual({
      ok: false,
      failure: 'message_too_long',
    });
  });

  it('aplica un límite más corto a la aclaración', () => {
    const long = raw({ action: 'clarify', message: 'a'.repeat(201) });
    expect(validateDecision(long, context())).toEqual({ ok: false, failure: 'message_too_long' });
  });
});

describe('validateDecision — aclaración', () => {
  it('acepta una aclaración respaldada', () => {
    const clarify = raw({ action: 'clarify', message: 'Cual de las dos te queda mas cerca?' });
    expect(validateDecision(clarify, context()).ok).toBe(true);
  });

  it('rechaza una segunda aclaración consecutiva', () => {
    const clarify = raw({ action: 'clarify', message: 'Cual de las dos te queda mas cerca?' });
    expect(validateDecision(clarify, context({ clarifyAllowed: false }))).toEqual({
      ok: false,
      failure: 'clarify_not_allowed',
    });
  });
});

describe('validateDecision — frases prohibidas', () => {
  it.each([
    'Soy un asistente virtual del taller.',
    'Esta es una respuesta automatizada.',
    'Como inteligencia artificial, no puedo confirmarlo.',
    'Soy un bot, pero te ayudo igual.',
    'No soy humano.',
  ])('bloquea la revelación: %s', (message) => {
    expect(validateDecision(raw({ message }), context())).toEqual({
      ok: false,
      failure: 'ai_disclosure',
    });
  });

  it.each([
    'No tengo esa informacion.',
    'Un asesor te respondera en breve.',
    'En que puedo ayudarte?',
    'No entendi tu consulta.',
  ])('bloquea el relleno genérico: %s', (message) => {
    expect(validateDecision(raw({ message }), context())).toEqual({
      ok: false,
      failure: 'generic_filler',
    });
  });

  it('no bloquea vocabulario legítimo del rubro', () => {
    // «automática» aparece de forma natural en un taller y no revela nada.
    const message = 'Revisamos inyectores de caja automatica sin problema.';
    expect(validateDecision(raw({ message }), context()).ok).toBe(true);
  });
});

describe('validateDecision — datos inventados', () => {
  it('rechaza un enlace que no está autorizado', () => {
    const message = 'Aca nos ubicas: https://maps.example/sucursal-inventada';
    expect(validateDecision(raw({ message }), context())).toEqual({
      ok: false,
      failure: 'unauthorized_link',
    });
  });

  it('acepta un enlace que sí está autorizado', () => {
    const message = 'Aca nos ubicas: https://maps.example/sucursal-uno';
    expect(validateDecision(raw({ message }), context()).ok).toBe(true);
  });

  it('rechaza un número largo que no está autorizado', () => {
    expect(validateDecision(raw({ message: 'Llamanos al 76543210.' }), context())).toEqual({
      ok: false,
      failure: 'unauthorized_number',
    });
  });

  it('acepta un número autorizado aunque venga separado', () => {
    const message = 'Nuestro fijo es el 3-456-789.';
    expect(validateDecision(raw({ message }), context()).ok).toBe(true);
  });
});

describe('toSafeDecision', () => {
  it('convierte cualquier salida inválida en silencio', () => {
    expect(toSafeDecision({ action: 'reply' }, context())).toEqual({
      action: 'silent',
      reason: 'invalid_model_output',
    });
  });

  it('deja pasar una decisión válida', () => {
    expect(toSafeDecision(raw(), context()).action).toBe('reply');
  });
});
