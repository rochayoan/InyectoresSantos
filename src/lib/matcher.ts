import { BUSINESS_RESPONSES, type BusinessIntent } from '@/config/business';
import { normalizeText } from '@/lib/text';

const KEYWORDS: Record<BusinessIntent, readonly RegExp[]> = {
  services: [
    /\bservicios?\b/,
    /\bque (hacen|arreglan|reparan|ofrecen)\b/,
    /\b(reparan|limpian|calibran|revisan) inyectores?\b/,
    /\binyectores?\b/,
  ],
  hours: [
    /\bhorarios?\b/,
    /\ba que hora\b/,
    /\bhasta que hora\b/,
    /\bcuando (abren|atienden|cierran)\b/,
    /\b(abren|atienden|cierran) (hoy|mañana|los|el)\b/,
  ],
  location: [
    /\bubicacion\b/,
    /\bdireccion\b/,
    /\bdonde (estan|se encuentran|queda|quedan)\b/,
    /\bcomo llego\b/,
    /\bmapa\b/,
  ],
  information: [
    /^(hola|buen dia|buenas|buenas tardes|buenas noches|hola buen dia)$/,
    /\binformacion\b/,
    /\bquisiera saber\b/,
    /\bquiero saber mas\b/,
    /\ba que se dedican\b/,
  ],
};

/**
 * Devuelve una de las cuatro respuestas predeterminadas o null.
 * null significa silencio total: no se improvisa ni se deriva a una IA.
 */
export function matchPredeterminedResponse(input: string): {
  intent: BusinessIntent;
  response: string;
} | null {
  const text = normalizeText(input);
  if (!text) return null;

  for (const intent of ['services', 'hours', 'location', 'information'] as const) {
    if (KEYWORDS[intent].some((pattern) => pattern.test(text))) {
      const response = BUSINESS_RESPONSES[intent].trim();
      return response ? { intent, response } : null;
    }
  }

  return null;
}
