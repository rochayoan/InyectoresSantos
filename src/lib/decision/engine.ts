import { assessKnowledge, type BusinessKnowledge } from '@/config/business';
import type { HistoryTurn } from '@/lib/ports';
import { type Decision, type SilentDecision, type SilentReason, silent } from './contract';

/**
 * Lo que necesita el motor para decidir. No incluye teléfonos, ids de Kapso
 * ni payloads del proveedor: solo texto de conversación e información
 * autorizada.
 */
export interface DecisionRequest {
  readonly incomingText: string;
  /** Ventana corta, del más antiguo al más reciente. */
  readonly history: readonly HistoryTurn[];
  readonly knowledge: BusinessKnowledge;
  /** Falso cuando ya se pidió una aclaración sin respuesta suficiente. */
  readonly clarifyAllowed: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Frontera entre el pipeline y el modelo.
 *
 * El pipeline solo conoce esta interfaz, así que la Fase 3 puede enchufar el
 * SDK de OpenAI sin tocar el webhook, y las pruebas pueden usar dobles sin
 * red ni claves.
 */
export interface DecisionEngine {
  readonly name: string;
  decide(request: DecisionRequest): Promise<Decision>;
}

/**
 * Motor temporal: calla siempre.
 *
 * Es el motor activo hasta que la Fase 3 integre OpenAI. Mantiene el sistema
 * completo y desplegable sin ninguna posibilidad de escribirle a un cliente.
 */
export function createSilentEngine(
  reason: SilentReason = 'engine_not_configured',
): DecisionEngine {
  return {
    name: 'silent',
    decide: async () => silent(reason),
  };
}

/**
 * Envuelve un motor para que jamás lance ni tarde de más.
 *
 * Un fallo, una excepción o un tiempo agotado se convierten en silencio, que
 * es el comportamiento seguro acordado. Aquí no hay reintentos: reintentar
 * una decisión ya tardía es hablar tarde.
 */
export function withSafeFallback(engine: DecisionEngine, timeoutMs: number): DecisionEngine {
  return {
    name: `safe(${engine.name})`,
    async decide(request: DecisionRequest): Promise<Decision> {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const timeout = new Promise<Decision>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(silent('engine_timeout'));
        }, timeoutMs);
      });

      try {
        return await Promise.race([
          engine.decide({ ...request, signal: controller.signal }),
          timeout,
        ]);
      } catch {
        return silent('engine_unavailable');
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/**
 * Comprobaciones baratas anteriores a cualquier llamada al modelo.
 *
 * Devuelve la decisión de silencio que corresponda, o `null` si se puede
 * seguir. Con la información autorizada vacía siempre devuelve silencio,
 * incluso con el flag encendido: es lo que impide que una configuración a
 * medio llenar llegue a un cliente.
 */
export function preflight(input: {
  readonly responsesEnabled: boolean;
  readonly knowledge: BusinessKnowledge;
  readonly incomingText: string;
}): SilentDecision | null {
  if (input.incomingText.trim() === '') return silent('empty_message');
  if (!input.responsesEnabled) return silent('responses_disabled');
  if (!assessKnowledge(input.knowledge).ready) return silent('knowledge_not_ready');
  return null;
}

/**
 * Motor activo del sistema.
 *
 * La Fase 3 sustituye `createSilentEngine()` por el motor OpenAI y deja el
 * resto igual: la envoltura de seguridad y el contrato no cambian.
 */
export function resolveDecisionEngine(input: { readonly timeoutMs: number }): DecisionEngine {
  return withSafeFallback(createSilentEngine('engine_not_configured'), input.timeoutMs);
}
