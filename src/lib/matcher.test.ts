import { describe, expect, it, vi } from 'vitest';

vi.mock('@/config/business', () => ({
  BUSINESS_RESPONSES: {
    services: 'SERVICIOS',
    hours: 'HORARIOS',
    location: 'UBICACION',
    information: 'INFORMACION',
  },
}));

import { matchPredeterminedResponse } from '@/lib/matcher';

describe('matchPredeterminedResponse', () => {
  it.each([
    ['¿Qué servicios ofrecen?', 'services'],
    ['Hasta qué hora atienden', 'hours'],
    ['Me pasa su ubicación por favor', 'location'],
    ['Hola, buen día', 'information'],
  ])('clasifica %s', (text, intent) => {
    expect(matchPredeterminedResponse(text)?.intent).toBe(intent);
  });

  it('no responde cuando no reconoce la consulta', () => {
    expect(matchPredeterminedResponse('Tengo un Toyota azul')).toBeNull();
  });
});
