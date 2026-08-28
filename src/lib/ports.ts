/**
 * Contratos de persistencia.
 *
 * Aquí viven las interfaces; `store.ts` las implementa sobre Supabase y
 * `testing/fake-store.ts` las implementa en memoria. El pipeline solo conoce
 * estos contratos, así que se puede probar entero sin base de datos.
 */

/** Qué decisión produjo un turno del negocio. */
export type BusinessAction = 'reply' | 'clarify';

/** Un turno de la ventana corta de contexto. */
export interface HistoryTurn {
  readonly role: 'customer' | 'business';
  readonly body: string;
  /** ISO 8601 en UTC. */
  readonly at: string;
  /**
   * Solo en turnos del negocio. Permite saber si el último mensaje nuestro
   * fue una aclaración y, por tanto, si se puede pedir otra.
   */
  readonly action?: BusinessAction;
}

export type EventStatus = 'processing' | 'processed' | 'failed' | 'unknown';

/**
 * Resultado de intentar tomar un evento.
 *
 * `claimed: false` significa que otro proceso lo tiene arrendado o que ya se
 * completó. Un evento en `failed`, o en `processing` con el arrendamiento
 * vencido, sí se puede volver a tomar: es lo que evita que un fallo
 * transitorio convierta un mensaje en silencio permanente.
 */
export interface EventClaim {
  readonly claimed: boolean;
  /** Número de intento, empezando en 1. */
  readonly attempt: number;
  readonly currentStatus: EventStatus;
  /**
   * Id del mensaje ya entregado a Kapso, si lo hubo.
   *
   * Un evento con entrega confirmada nunca se vuelve a tomar, para no
   * escribirle dos veces al mismo cliente.
   */
  readonly deliveredMessageId: string | null;
}

export interface EventLeaseStore {
  claimEvent(input: {
    readonly eventId: string;
    readonly eventName: string;
    readonly messageId: string;
    readonly leaseSeconds: number;
  }): Promise<EventClaim>;

  /** Se llama en cuanto Kapso confirma la entrega, antes de cerrar el evento. */
  markDelivered(eventId: string, sentMessageId: string): Promise<void>;

  completeEvent(eventId: string, outcome: string): Promise<void>;

  /** Deja el evento reclamable por el siguiente reintento de Kapso. */
  failEvent(eventId: string, outcome: string): Promise<void>;
}

export interface PauseStore {
  /**
   * Renueva la pausa del dueño en un solo chat.
   *
   * Conserva el instante de inicio si la pausa seguía vigente y nunca acorta
   * el vencimiento, aunque los eventos lleguen fuera de orden.
   */
  renewHumanPause(input: {
    readonly phone: string;
    readonly ownerMessageId: string;
    readonly minutes: number;
  }): Promise<string>;

  isPaused(phone: string, now?: Date): Promise<boolean>;
}

export interface ConversationHistoryStore {
  /**
   * Guarda un turno. Si `messageId` ya existe, no duplica: reprocesar un
   * evento no puede ensuciar el historial.
   */
  appendTurn(input: {
    readonly phone: string;
    readonly role: HistoryTurn['role'];
    readonly body: string;
    readonly messageId: string | null;
    readonly action?: BusinessAction;
  }): Promise<void>;

  /**
   * Ventana corta: como máximo `limit` turnos, ninguno con más de
   * `maxAgeMinutes` de antigüedad, solo de ese teléfono y en orden
   * cronológico (del más antiguo al más reciente).
   */
  recentTurns(input: {
    readonly phone: string;
    readonly limit: number;
    readonly maxAgeMinutes: number;
  }): Promise<readonly HistoryTurn[]>;
}

export interface PurgeStore {
  /**
   * Borra historial e eventos vencidos.
   *
   * Su programación no vive aquí: el pipeline la invoca de forma muestreada y
   * cualquier fallo se traga, porque una purga nunca debe impedir atender un
   * mensaje.
   */
  purgeExpiredData(): Promise<void>;
}

/**
 * Última comprobación obligatoria, inmediatamente antes de llamar a Kapso.
 *
 * Existe por una carrera concreta: llega el mensaje del cliente, el motor
 * tarda unos segundos en decidir y mientras tanto el dueño contesta a mano
 * desde WhatsApp Business. Sin esta comprobación, el sistema hablaría encima
 * de él.
 */
export interface DeliveryBarrier {
  canDeliver(phone: string): Promise<boolean>;
}

export type Store = EventLeaseStore &
  PauseStore &
  ConversationHistoryStore &
  DeliveryBarrier &
  PurgeStore;

/**
 * Política de agrupación de mensajes seguidos del mismo cliente.
 *
 * Declarada, no implementada. El buffering de Kapso sigue rechazado en el
 * webhook porque no tenemos el formato exacto del lote demostrado con
 * documentación o fixture, y no vamos a suponerlo. Estos valores son los
 * acordados para cuando ese contrato esté confirmado.
 *
 * Un lote debe producir como máximo una decisión y una respuesta. La
 * agrupación la hace Kapso antes de entregarnos el evento: no se implementa
 * con temporizadores dentro de una función de Vercel, que se congela en
 * cuanto responde.
 */
export interface BatchPolicy {
  readonly windowSeconds: number;
  readonly maxMessages: number;
}

export const PROPOSED_BATCH_POLICY: BatchPolicy = { windowSeconds: 3, maxMessages: 10 };
