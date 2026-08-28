import { describe, expect, it } from 'vitest';
import { computeClarifyAllowed } from '@/lib/decision/clarify';
import type { HistoryTurn } from '@/lib/ports';

function turn(partial: Partial<HistoryTurn> & Pick<HistoryTurn, 'role'>): HistoryTurn {
  return { body: 'texto', at: '2026-08-28T10:00:00.000Z', ...partial };
}

describe('computeClarifyAllowed', () => {
  it('permite aclarar cuando no hay historial', () => {
    expect(computeClarifyAllowed([])).toBe(true);
  });

  it('permite aclarar cuando el cliente todavía no recibió nada nuestro', () => {
    expect(computeClarifyAllowed([turn({ role: 'customer' })])).toBe(true);
  });

  it('no permite una segunda aclaración consecutiva', () => {
    const history = [
      turn({ role: 'customer' }),
      turn({ role: 'business', action: 'clarify' }),
      turn({ role: 'customer' }),
    ];
    expect(computeClarifyAllowed(history)).toBe(false);
  });

  it('vuelve a permitir aclarar después de una respuesta normal', () => {
    const history = [
      turn({ role: 'business', action: 'clarify' }),
      turn({ role: 'customer' }),
      turn({ role: 'business', action: 'reply' }),
      turn({ role: 'customer' }),
    ];
    expect(computeClarifyAllowed(history)).toBe(true);
  });

  it('mira solo el último turno del negocio, no el primero', () => {
    const history = [
      turn({ role: 'business', action: 'reply' }),
      turn({ role: 'business', action: 'clarify' }),
    ];
    expect(computeClarifyAllowed(history)).toBe(false);
  });
});
