import { describe, expect, it } from 'vitest';
import {
  conversationRef,
  createLogger,
  normalizeError,
  sanitizeFields,
  type LogRecord,
} from '@/lib/logger';

const PHONE = '59170000001';

describe('sanitizeFields', () => {
  it('deja pasar los campos permitidos', () => {
    expect(sanitizeFields({ stage: 'decide', attempts: 2, claimed: true })).toEqual({
      stage: 'decide',
      attempts: 2,
      claimed: true,
    });
  });

  it.each(['phone', 'to', 'body', 'text', 'message', 'apiKey', 'signature', 'payload', 'headers'])(
    'descarta el campo %s',
    (key) => {
      const safe = sanitizeFields({ [key]: 'valor sensible', stage: 'decide' });
      expect(safe[key]).toBeUndefined();
      expect(safe.droppedFields).toBe(1);
    },
  );

  it('recorta valores largos', () => {
    const safe = sanitizeFields({ reason: 'x'.repeat(200) });
    expect(String(safe.reason)).toHaveLength(64);
  });

  it('redacta secuencias largas de dígitos aunque vengan en un campo permitido', () => {
    expect(sanitizeFields({ reason: `fallo con ${PHONE}` }).reason).toBe('fallo con [num]');
  });

  it('descarta valores que no son primitivos', () => {
    const safe = sanitizeFields({ stage: { anidado: true } });
    expect(safe.stage).toBeUndefined();
    expect(safe.droppedFields).toBe(1);
  });
});

describe('conversationRef', () => {
  it('es estable para el mismo teléfono y secreto', () => {
    expect(conversationRef(PHONE, 'secreto')).toBe(conversationRef(PHONE, 'secreto'));
  });

  it('no contiene el teléfono', () => {
    expect(conversationRef(PHONE, 'secreto')).not.toContain(PHONE);
  });

  it('cambia con el secreto, así que no se puede recorrer por fuerza bruta sin él', () => {
    expect(conversationRef(PHONE, 'secreto-a')).not.toBe(conversationRef(PHONE, 'secreto-b'));
  });

  it('distingue teléfonos distintos', () => {
    expect(conversationRef(PHONE, 's')).not.toBe(conversationRef('59170000002', 's'));
  });
});

describe('normalizeError', () => {
  it('conserva el código técnico del proyecto', () => {
    expect(normalizeError(new Error('kapso_send_failed:409'))).toBe('kapso_send_failed:409');
  });

  it('descarta el resto del mensaje', () => {
    expect(normalizeError(new Error('pause_failed:23505 en el chat 59170000001'))).toBe(
      'pause_failed:23505',
    );
  });

  it('resiste valores que no son Error', () => {
    expect(normalizeError(undefined)).toBe('unknown');
    expect(normalizeError({})).toBe('object');
  });
});

describe('createLogger', () => {
  it('emite solo campos saneados', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ sink: (record) => records.push(record) });

    logger.info('decision_silent', { reason: 'out_of_scope', phone: PHONE, body: 'hola' });

    expect(records).toEqual([
      {
        level: 'info',
        event: 'decision_silent',
        fields: { reason: 'out_of_scope', droppedFields: 2 },
      },
    ]);
  });

  it('registra los tres niveles', () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ sink: (record) => records.push(record) });

    logger.info('a');
    logger.warn('b');
    logger.error('c');

    expect(records.map((record) => record.level)).toEqual(['info', 'warn', 'error']);
  });
});
