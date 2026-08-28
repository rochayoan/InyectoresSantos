import { describe, expect, it, vi } from 'vitest';
import { sendKapsoText } from '@/lib/kapso';

const BASE = {
  apiKey: 'clave-de-prueba',
  phoneNumberId: '1234567890',
  to: '59170000001',
  body: 'texto',
};

function response(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const accepted = response(200, { messages: [{ id: 'wamid.sent' }] });

/** Sin esperas reales: el reintento del 409 no debe alargar las pruebas. */
const noSleep = async () => {};

describe('sendKapsoText', () => {
  it('devuelve el id del mensaje aceptado', async () => {
    const fetchImpl = vi.fn(async () => accepted);

    const id = await sendKapsoText({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(id).toBe('wamid.sent');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('envía la firma de petición esperada por Kapso', async () => {
    const fetchImpl = vi.fn(async () => accepted);
    await sendKapsoText({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/1234567890/messages');
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('clave-de-prueba');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toMatchObject({
      messaging_product: 'whatsapp',
      to: '59170000001',
      text: { body: 'texto', preview_url: false },
    });
  });

  it('falla si la respuesta no trae id', async () => {
    const fetchImpl = vi.fn(async () => response(200, { messages: [] }));
    await expect(
      sendKapsoText({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('kapso_missing_message_id');
  });

  it('reintenta el 409 y acepta el envío posterior', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(response(409))
      .mockResolvedValueOnce(accepted);

    const id = await sendKapsoText({
      ...BASE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });

    expect(id).toBe('wamid.sent');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('se rinde tras los reintentos autorizados del 409', async () => {
    const fetchImpl = vi.fn(async () => response(409));

    await expect(
      sendKapsoText({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toThrow('kapso_send_failed:409');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it.each([400, 401, 429, 500, 503])('no reintenta el %i', async (status) => {
    const fetchImpl = vi.fn(async () => response(status));

    await expect(
      sendKapsoText({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep }),
    ).rejects.toThrow(`kapso_send_failed:${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no reintenta un corte de red: podría duplicar el mensaje', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('socket hang up');
    });

    await expect(
      sendKapsoText({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('kapso_send_failed:network');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('distingue el tiempo agotado del corte de red', async () => {
    const fetchImpl = vi.fn(async () => {
      const error = new Error('agotado');
      error.name = 'TimeoutError';
      throw error;
    });

    await expect(
      sendKapsoText({ ...BASE, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow('kapso_send_failed:timeout');
  });

  it('no espera para reintentar si el presupuesto total no da', async () => {
    const fetchImpl = vi.fn(async () => response(409));

    await expect(
      sendKapsoText({
        ...BASE,
        totalTimeoutMs: 500,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: noSleep,
      }),
    ).rejects.toThrow('kapso_send_failed:budget_exhausted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
