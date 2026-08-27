/**
 * Frases que nunca pueden salir hacia un cliente.
 *
 * Los patrones se evalúan sobre el texto normalizado por `normalizeText()`:
 * minúsculas, sin acentos y con la puntuación convertida en espacios. Por eso
 * se escriben sin tildes y apoyados en límites de palabra.
 *
 * Si una respuesta coincide con cualquiera de estos patrones, la decisión se
 * degrada a `silent`. Es una red de seguridad sobre el modelo, no un
 * sustituto del prompt.
 */

/**
 * Revelar que hay una automatización detrás.
 *
 * Cuidado con el rubro: «automática» aparece de forma legítima en un taller
 * (transmisión automática, bomba automática), así que solo se bloquean
 * «automatizado» y «automatización», que no tienen uso mecánico.
 */
export const AI_DISCLOSURE_PATTERNS: readonly RegExp[] = [
  /\binteligencia artificial\b/,
  /\bia\b/,
  /\bbot\b/,
  /\bchatbot\b/,
  /\bchat bot\b/,
  /\brobot\b/,
  /\basistente virtual\b/,
  /\basistente digital\b/,
  /\basistente automatizado\b/,
  /\bautomatizacion\b/,
  /\bautomatizad[oa]\b/,
  /\brespuesta automatizada\b/,
  /\bmodelo de lenguaje\b/,
  /\bopenai\b/,
  /\bchatgpt\b/,
  /\bgpt\b/,
  /\bsoy (un|una) (asistente|bot|programa|sistema|maquina)\b/,
  /\bno soy (humano|una persona|un humano)\b/,
];

/**
 * Rellenos genéricos prohibidos por el alcance.
 *
 * Cuando no hay información autorizada, la respuesta correcta es el silencio,
 * no una disculpa ni una derivación.
 */
export const GENERIC_FILLER_PATTERNS: readonly RegExp[] = [
  /\bno tengo esa informacion\b/,
  /\bno tengo informacion\b/,
  /\bno cuento con esa informacion\b/,
  /\bno dispongo de esa informacion\b/,
  /\bun asesor\b/,
  /\bun agente\b/,
  /\bun representante\b/,
  /\ben que puedo ayudarte\b/,
  /\ben que te puedo ayudar\b/,
  /\ben que podemos ayudarte\b/,
  /\bno entendi\b/,
  /\bno comprendi\b/,
  /\bno logre entender\b/,
  /\bno puedo ayudarte con eso\b/,
];

export function matchesAny(normalized: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(normalized));
}
