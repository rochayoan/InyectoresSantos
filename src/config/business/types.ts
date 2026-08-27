/**
 * Tipos de la información autorizada del negocio.
 *
 * Regla central del proyecto: el sistema solo puede responder con el contenido
 * declarado en estos bloques. Si un bloque no existe, no hay respuesta posible
 * y la única decisión correcta es el silencio.
 */

/** Categoría de un bloque autorizado. */
export type KnowledgeKind = 'info' | 'location' | 'hours' | 'service' | 'link';

/**
 * Unidad mínima de información autorizada.
 *
 * El motor de decisión solo puede citar bloques por su `id`. El validador
 * rechaza cualquier respuesta que cite un `id` inexistente, de modo que una
 * respuesta sin respaldo nunca llega al cliente.
 */
export interface KnowledgeBlock {
  /** Identificador estable y corto. Es lo que el modelo devuelve en `sources`. */
  readonly id: string;
  readonly kind: KnowledgeKind;
  /** Nombre legible para el prompt. No se envía tal cual al cliente. */
  readonly label: string;
  /** Texto autorizado, literal, tal como lo escribió el dueño. */
  readonly content: string;
  /**
   * Orden de mención dentro de su categoría, empezando en 1.
   *
   * Permite resolver seguimientos como «¿y la segunda hasta qué hora atiende?»
   * sin inventar a qué sucursal se refiere el cliente.
   */
  readonly order: number;
  /** Enlace autorizado (por ejemplo Google Maps). Ausente si no aplica. */
  readonly url?: string;
}

/** Ejemplo real de cómo escribe el dueño. Fija el tono, no el contenido. */
export interface VoiceExample {
  readonly id: string;
  readonly text: string;
}

/** Conjunto completo de información autorizada. Única fuente de verdad. */
export interface BusinessKnowledge {
  readonly blocks: readonly KnowledgeBlock[];
  readonly voice: readonly VoiceExample[];
  /** Reglas de respuesta propias del dueño, en sus palabras. */
  readonly rules: readonly string[];
}

/** Resultado de comprobar si la información autorizada permite responder. */
export interface KnowledgeReadiness {
  readonly ready: boolean;
  /** Lista legible de lo que falta o está mal. Vacía cuando `ready` es true. */
  readonly issues: readonly string[];
}
