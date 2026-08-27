export async function sendKapsoText(input: {
  apiKey: string;
  phoneNumberId: string;
  to: string;
  body: string;
}): Promise<string> {
  const url = `https://api.kapso.ai/meta/whatsapp/v24.0/${encodeURIComponent(input.phoneNumberId)}/messages`;

  // Desde enero de 2026 Kapso devuelve 409 si ya existe otro envío en curso
  // para el mismo chat. Se reintenta dos veces con una espera corta.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': input.apiKey,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: input.to,
        type: 'text',
        text: { body: input.body, preview_url: false },
      }),
    });

    if (response.ok) {
      const data = (await response.json()) as { messages?: Array<{ id?: string }> };
      const messageId = data.messages?.[0]?.id;
      if (!messageId) throw new Error('kapso_missing_message_id');
      return messageId;
    }

    if (response.status === 409 && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      continue;
    }

    throw new Error(`kapso_send_failed:${response.status}`);
  }

  throw new Error('kapso_send_failed:retry_exhausted');
}
