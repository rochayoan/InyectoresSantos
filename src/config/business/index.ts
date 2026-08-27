import { KNOWLEDGE_BLOCKS } from './knowledge';
import { BUSINESS_RULES } from './rules';
import type { BusinessKnowledge, KnowledgeKind, KnowledgeReadiness } from './types';
import { VOICE_EXAMPLES } from './voice';

export * from './types';

/** Mínimos que exige el alcance acordado para poder responder algo. */
const REQUIRED_BLOCKS: ReadonlyArray<{
  readonly kind: KnowledgeKind;
  readonly min: number;
  readonly label: string;
}> = [
  { kind: 'info', min: 2, label: 'mensajes informativos' },
  { kind: 'location', min: 2, label: 'ubicaciones' },
  { kind: 'hours', min: 1, label: 'horarios' },
  { kind: 'service', min: 1, label: 'servicios' },
];

/** Un bloque solo cuenta si tiene identificador y contenido reales. */
function isUsable(block: { id: string; content: string }): boolean {
  return block.id.trim() !== '' && block.content.trim() !== '';
}

export function getBusinessKnowledge(): BusinessKnowledge {
  return {
    blocks: KNOWLEDGE_BLOCKS,
    voice: VOICE_EXAMPLES,
    rules: BUSINESS_RULES,
  };
}

/**
 * Comprueba si la información autorizada permite responder.
 *
 * Es la barrera que impide que el sistema hable con la configuración a medio
 * llenar. Mientras devuelva `ready: false`, toda consulta termina en silencio.
 */
export function assessKnowledge(
  knowledge: BusinessKnowledge = getBusinessKnowledge(),
): KnowledgeReadiness {
  const issues: string[] = [];
  const usable = knowledge.blocks.filter(isUsable);

  const incomplete = knowledge.blocks.length - usable.length;
  if (incomplete > 0) {
    issues.push(`${incomplete} bloque(s) sin id o sin contenido`);
  }

  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const block of usable) {
    if (seen.has(block.id)) duplicated.add(block.id);
    seen.add(block.id);
  }
  if (duplicated.size > 0) {
    issues.push(`ids duplicados: ${[...duplicated].sort().join(', ')}`);
  }

  for (const requirement of REQUIRED_BLOCKS) {
    const count = usable.filter((block) => block.kind === requirement.kind).length;
    if (count < requirement.min) {
      issues.push(`faltan ${requirement.label}: ${count} de ${requirement.min}`);
    }
  }

  if (knowledge.voice.filter((example) => example.text.trim() !== '').length === 0) {
    issues.push('faltan ejemplos de cómo escribe el dueño');
  }

  return { ready: issues.length === 0, issues };
}

/** Identificadores citables. El validador rechaza cualquier otro. */
export function authorizedIds(
  knowledge: BusinessKnowledge = getBusinessKnowledge(),
): ReadonlySet<string> {
  return new Set(knowledge.blocks.filter(isUsable).map((block) => block.id));
}

/**
 * Todo el texto autorizado concatenado.
 *
 * Sirve para comprobar que los enlaces y los números largos que aparezcan en
 * una respuesta existan realmente en la información del negocio.
 */
export function authorizedText(
  knowledge: BusinessKnowledge = getBusinessKnowledge(),
): string {
  return knowledge.blocks
    .filter(isUsable)
    .flatMap((block) => (block.url ? [block.content, block.url] : [block.content]))
    .join('\n');
}
