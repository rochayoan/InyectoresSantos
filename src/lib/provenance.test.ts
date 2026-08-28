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

describe('parseKapsoEvent — eventos que nunca pausan', () => {
  it.each([
    'whatsapp.message.delivered',
    'whatsapp.message.read',
    'whatsapp.message.failed',
    'whatsapp.message.status',
  ])('ignora el evento de ciclo de vida %s', (eventName) => {
    expect(parseKapsoEvent({ eventName, eventId: 'evt.ciclo', payload: base }).kind).toBe('ignore');
  });

  it('ignora un envío outbound sin origen declarado', () => {
    const payload = {
      ...base,
      message: { ...base.message, kapso: { direction: 'outbound' } },
    };
    expect(
      parseKapsoEvent({ eventName: 'whatsapp.message.sent', eventId: 'evt.3', payload }).kind,
    ).toBe('ignore');
  });

  it('reconoce el mensaje entrante de un cliente', () => {
    const payload = {
      conversation: { phone_number: '+591 70000000' },
      message: { id: 'wamid.in', from: '59170000000', type: 'text', text: { body: 'hola' } },
    };
    expect(
      parseKapsoEvent({ eventName: 'whatsapp.message.received', eventId: 'evt.4', payload }),
    ).toMatchObject({ kind: 'customer', phone: '59170000000', text: 'hola' });
  });

  it('ignora un entrante que no es texto', () => {
    const payload = {
      conversation: { phone_number: '+591 70000000' },
      message: { id: 'wamid.audio', from: '59170000000', type: 'audio' },
    };
    expect(
      parseKapsoEvent({ eventName: 'whatsapp.message.received', eventId: 'evt.5', payload }).kind,
    ).toBe('ignore');
  });
});
