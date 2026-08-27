import { normalizePhone } from '@/lib/text';

export type ParsedKapsoEvent =
  | { kind: 'customer'; eventId: string; messageId: string; phone: string; text: string }
  | { kind: 'owner'; eventId: string; messageId: string; phone: string }
  | { kind: 'ignore'; eventId: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseKapsoEvent(input: {
  eventName: string;
  eventId: string;
  payload: unknown;
}): ParsedKapsoEvent {
  const root = record(input.payload);
  const message = record(root?.message);
  const conversation = record(root?.conversation);
  const kapso = record(message?.kapso);
  const eventId = input.eventId;

  if (!root || !message || !eventId) return { kind: 'ignore', eventId };

  const messageId = string(message.id);
  const conversationPhone = normalizePhone(string(conversation?.phone_number));

  if (
    input.eventName === 'whatsapp.message.sent' &&
    string(kapso?.direction) === 'outbound' &&
    string(kapso?.origin) === 'business_app'
  ) {
    const phone = conversationPhone || normalizePhone(string(message.to));
    return messageId && phone
      ? { kind: 'owner', eventId, messageId, phone }
      : { kind: 'ignore', eventId };
  }

  if (input.eventName === 'whatsapp.message.received') {
    const type = string(message.type);
    const text = type === 'text' ? string(record(message.text)?.body) : '';
    const phone = conversationPhone || normalizePhone(string(message.from));
    return messageId && phone && text
      ? { kind: 'customer', eventId, messageId, phone, text }
      : { kind: 'ignore', eventId };
  }

  return { kind: 'ignore', eventId };
}
