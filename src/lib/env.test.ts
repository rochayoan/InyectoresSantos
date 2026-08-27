import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnv } from '@/lib/env';

const KEYS = [
  'KAPSO_API_KEY',
  'KAPSO_PHONE_NUMBER_ID',
  'KAPSO_WEBHOOK_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_TIMEOUT_MS',
  'OPENAI_MAX_OUTPUT_TOKENS',
  'CONTEXT_WINDOW_MESSAGES',
  'CONTEXT_WINDOW_MINUTES',
  'BUSINESS_RESPONSES_ENABLED',
  'HUMAN_PAUSE_MINUTES',
] as const;

const snapshot = new Map<string, string | undefined>();

// Valores de prueba, no secretos: solo cadenas que hagan pasar la validación.
function setAll(values: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const key of KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

const BASE = {
  KAPSO_WEBHOOK_SECRET: 'secreto-de-prueba',
  SUPABASE_URL: 'https://proyecto.example',
  SUPABASE_SERVICE_ROLE_KEY: 'clave-de-prueba',
} as const;

const DELIVERY = {
  ...BASE,
  KAPSO_API_KEY: 'api-de-prueba',
  KAPSO_PHONE_NUMBER_ID: '1234567890',
  OPENAI_API_KEY: 'openai-de-prueba',
  OPENAI_MODEL: 'modelo-de-prueba',
} as const;

beforeEach(() => {
  for (const key of KEYS) snapshot.set(key, process.env[key]);
});

afterEach(() => {
  for (const key of KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('getEnv — obligatorias siempre', () => {
  it.each(['KAPSO_WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])(
    'falla sin %s',
    (missing) => {
      const values: Record<string, string> = { ...BASE };
      delete values[missing];
      setAll(values);
      expect(() => getEnv()).toThrow(`missing_env:${missing}`);
    },
  );

  it('arranca sin claves de envío para poder recibir y validar', () => {
    setAll(BASE);
    const env = getEnv();
    expect(env.responsesEnabled).toBe(false);
    expect(env.kapsoApiKey).toBeNull();
  });
});

describe('getEnv — flag de respuestas', () => {
  it('permanece apagado sin el flag', () => {
    setAll(DELIVERY);
    expect(getEnv()).toMatchObject({ responsesEnabled: false, disabledReason: 'flag_off' });
  });

  it.each(['TRUE', 'True', '1', 'si', ''])('no acepta el valor %s', (value) => {
    setAll({ ...DELIVERY, BUSINESS_RESPONSES_ENABLED: value });
    expect(getEnv().responsesEnabled).toBe(false);
  });

  it('se enciende con el flag exacto y toda la configuración', () => {
    setAll({ ...DELIVERY, BUSINESS_RESPONSES_ENABLED: 'true' });
    expect(getEnv()).toMatchObject({ responsesEnabled: true, disabledReason: null });
  });

  it.each(['KAPSO_API_KEY', 'KAPSO_PHONE_NUMBER_ID', 'OPENAI_API_KEY', 'OPENAI_MODEL'])(
    'se apaga hacia el silencio si falta %s',
    (missing) => {
      const values: Record<string, string> = { ...DELIVERY, BUSINESS_RESPONSES_ENABLED: 'true' };
      delete values[missing];
      setAll(values);
      const env = getEnv();
      expect(env.responsesEnabled).toBe(false);
      expect(env.disabledReason).toContain(missing);
    },
  );
});

describe('getEnv — valores numéricos', () => {
  it('usa los acordados por defecto', () => {
    setAll(BASE);
    expect(getEnv()).toMatchObject({
      contextWindowMessages: 6,
      contextWindowMinutes: 30,
      humanPauseMinutes: 30,
      openaiTimeoutMs: 8_000,
      openaiMaxOutputTokens: 400,
    });
  });

  it('no fija ningún modelo por defecto', () => {
    setAll(BASE);
    expect(getEnv().openaiModel).toBeNull();
  });

  it.each([
    ['HUMAN_PAUSE_MINUTES', '0'],
    ['HUMAN_PAUSE_MINUTES', '1441'],
    ['HUMAN_PAUSE_MINUTES', 'treinta'],
    ['CONTEXT_WINDOW_MESSAGES', '21'],
    ['CONTEXT_WINDOW_MINUTES', '0'],
    ['OPENAI_TIMEOUT_MS', '999'],
    ['OPENAI_TIMEOUT_MS', '2.5'],
    ['OPENAI_MAX_OUTPUT_TOKENS', '63'],
  ])('rechaza %s = %s', (key, value) => {
    setAll({ ...BASE, [key]: value });
    expect(() => getEnv()).toThrow(`invalid_env:${key}`);
  });
});
