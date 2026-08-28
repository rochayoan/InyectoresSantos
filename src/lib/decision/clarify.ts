import type { HistoryTurn } from '@/lib/ports';

/**
 * Decide si se puede pedir una aclaración, a partir del historial persistido.
 *
 * Regla: no dos aclaraciones seguidas. Si nuestro último mensaje fue una
 * aclaración y el cliente sigue sin darnos lo que falta, el resultado seguro
 * es el silencio, no otra pregunta. Una respuesta normal sí sigue permitida:
 * lo que se agota es la paciencia del cliente, no la información.
 *
 * El historial llega en orden cronológico, así que el último turno del
 * negocio es el que manda.
 */
export function computeClarifyAllowed(history: readonly HistoryTurn[]): boolean {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const turn = history[index];
    if (turn?.role === 'business') return turn.action !== 'clarify';
  }
  return true;
}
