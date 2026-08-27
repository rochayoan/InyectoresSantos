/**
 * Contratos de persistencia que implementará la Fase 2.
 *
 * Aquí solo viven las interfaces. Sirven para fijar ahora la forma del
 * historial corto, del arrendamiento de eventos, de la pausa humana y de la
 * barrera previa al envío, de modo que el motor de decisión y el pipeline se
 * puedan escribir y probar sin depender de Supabase.
 */

/** Un turno de la ventana corta de contexto. */
export interface HistoryTurn {
  readonly role: 'customer' | 'business';
  readonly body: string;
  /** ISO 8601 en UTC. */
  readonly at: string;
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
  appendTurn(input: {
    readonly phone: string;
    readonly role: HistoryTurn['role'];
    readonly body: string;
    readonly messageId: string | null;
  }): Promise<void>;

  /** Ventana corta: como máximo `limit` turnos y `maxAgeMinutes` de antigüedad. */
  recentTurns(input: {
    readonly phone: string;
    readonly limit: number;
    readonly maxAgeMinutes: number;
  }): Promise<readonly HistoryTurn[]>;
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

/** Lo que la Fase 2 debe implementar sobre Supabase. */
export type Store = EventLeaseStore & PauseStore & ConversationHistoryStore & DeliveryBarrier;
