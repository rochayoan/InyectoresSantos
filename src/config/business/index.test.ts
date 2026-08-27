import { describe, expect, it } from 'vitest';
import {
  assessKnowledge,
  authorizedIds,
  authorizedText,
  getBusinessKnowledge,
  type BusinessKnowledge,
  type KnowledgeBlock,
} from '@/config/business';

function block(overrides: Partial<KnowledgeBlock> & Pick<KnowledgeBlock, 'id' | 'kind'>): KnowledgeBlock {
  return {
    label: overrides.id,
    content: `contenido de ${overrides.id}`,
    order: 1,
    ...overrides,
  };
}

function completeKnowledge(overrides: Partial<BusinessKnowledge> = {}): BusinessKnowledge {
  return {
    blocks: [
      block({ id: 'info-1', kind: 'info', order: 1 }),
      block({ id: 'info-2', kind: 'info', order: 2 }),
      block({ id: 'sucursal-1', kind: 'location', order: 1 }),
      block({ id: 'sucursal-2', kind: 'location', order: 2 }),
      block({ id: 'horarios', kind: 'hours' }),
      block({ id: 'servicio-1', kind: 'service' }),
    ],
    voice: [{ id: 'voz-1', text: 'asi escribe el dueno' }],
    rules: [],
    ...overrides,
  };
}

describe('assessKnowledge', () => {
  it('la configuración real del repositorio no está lista', () => {
    // Garantía central: mientras nadie escriba la información autorizada, el
    // sistema no puede responder aunque el flag esté encendido.
    const readiness = assessKnowledge(getBusinessKnowledge());
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.length).toBeGreaterThan(0);
  });

  it('acepta una configuración completa', () => {
    expect(assessKnowledge(completeKnowledge())).toEqual({ ready: true, issues: [] });
  });

  it.each([
    ['un solo mensaje informativo', 'info'],
    ['una sola ubicación', 'location'],
  ])('rechaza %s', (_label, kind) => {
    const full = completeKnowledge();
    const blocks = full.blocks.filter((item) => item.kind !== kind).concat(
      full.blocks.filter((item) => item.kind === kind)[0]!,
    );
    expect(assessKnowledge({ ...full, blocks }).ready).toBe(false);
  });

  it('rechaza bloques sin contenido', () => {
    const full = completeKnowledge();
    const blocks = full.blocks.map((item) =>
      item.id === 'horarios' ? { ...item, content: '   ' } : item,
    );
    const readiness = assessKnowledge({ ...full, blocks });
    expect(readiness.ready).toBe(false);
    expect(readiness.issues.join(' ')).toContain('sin id o sin contenido');
  });

  it('rechaza ids duplicados', () => {
    const full = completeKnowledge();
    const blocks = full.blocks.map((item) =>
      item.id === 'info-2' ? { ...item, id: 'info-1' } : item,
    );
    expect(assessKnowledge({ ...full, blocks }).issues.join(' ')).toContain('ids duplicados');
  });

  it('exige ejemplos de la voz del dueño', () => {
    expect(assessKnowledge(completeKnowledge({ voice: [] })).ready).toBe(false);
  });
});

describe('authorizedIds', () => {
  it('solo expone bloques utilizables', () => {
    const full = completeKnowledge();
    const blocks = full.blocks.concat(block({ id: 'vacio', kind: 'link', content: '' }));
    const ids = authorizedIds({ ...full, blocks });
    expect(ids.has('sucursal-2')).toBe(true);
    expect(ids.has('vacio')).toBe(false);
  });

  it('está vacío en la configuración real', () => {
    expect(authorizedIds().size).toBe(0);
  });
});

describe('authorizedText', () => {
  it('incluye contenido y enlaces autorizados', () => {
    const full = completeKnowledge();
    const blocks = full.blocks.map((item) =>
      item.id === 'sucursal-1' ? { ...item, url: 'https://maps.example/uno' } : item,
    );
    const text = authorizedText({ ...full, blocks });
    expect(text).toContain('contenido de sucursal-1');
    expect(text).toContain('https://maps.example/uno');
  });
});
