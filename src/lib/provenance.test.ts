import { describe, expect, it } from 'vitest';
import { parseKapsoEvent } from '@/lib/provenance';

const base = {
  message: {
    id: 'wamid.1',
    to: '59170000000',
    kapso: { direction: 'outbound', origin: 'business_app' },
  },
  conversation: { phone_number: '+591 70000000' },
};

describe('parseKapsoEvent', () => {
  it('reconoce únicamente el envío manual desde WhatsApp Business', () => {
    expect(parseKapsoEvent({ eventName: 'whatsapp.message.sent', eventId: 'evt.1', payload: base })).toMatchObject({
      kind: 'owner',
      phone: '59170000000',
    });
  });

  it('no confunde un envío del sistema con el dueño', () => {
    const payload = {
      ...base,
      message: { ...base.message, kapso: { direction: 'outbound', origin: 'cloud_api' } },
    };
    expect(parseKapsoEvent({ eventName: 'whatsapp.message.sent', eventId: 'evt.2', payload }).kind).toBe('ignore');
  });
});
