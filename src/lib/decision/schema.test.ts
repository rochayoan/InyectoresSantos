import { describe, expect, it } from 'vitest';
import { MODEL_SILENT_REASONS } from '@/lib/decision/contract';
import { DECISION_JSON_SCHEMA, DECISION_SCHEMA_NAME } from '@/lib/decision/schema';
import { validateDecision } from '@/lib/decision/validate';

describe('DECISION_JSON_SCHEMA', () => {
  it('tiene nombre estable', () => {
    expect(DECISION_SCHEMA_NAME).toBe('business_decision');
  });

  it('exige las cuatro propiedades y prohíbe extras', () => {
    // El modo estricto de salidas estructuradas no admite campos opcionales:
    // todas las propiedades deben estar declaradas y presentes.
    expect(DECISION_JSON_SCHEMA.additionalProperties).toBe(false);
    expect([...DECISION_JSON_SCHEMA.required].sort()).toEqual([
      'action',
      'message',
      'reason',
      'sources',
    ]);
    expect(Object.keys(DECISION_JSON_SCHEMA.properties).sort()).toEqual([
      'action',
      'message',
      'reason',
      'sources',
    ]);
  });

  it('solo ofrece las tres acciones del contrato', () => {
    expect(DECISION_JSON_SCHEMA.properties.action.enum).toEqual(['reply', 'clarify', 'silent']);
  });

  it('no ofrece al modelo motivos de silencio reservados al backend', () => {
    expect(DECISION_JSON_SCHEMA.properties.reason.enum).toEqual([
      ...MODEL_SILENT_REASONS,
      'not_applicable',
    ]);
    expect(DECISION_JSON_SCHEMA.properties.reason.enum).not.toContain('human_pause');
    expect(DECISION_JSON_SCHEMA.properties.reason.enum).not.toContain('invalid_model_output');
  });
});

describe('esquema y validador', () => {
  const context = {
    authorizedIds: new Set(['loc-1']),
    authorizedText: 'Estamos en el tercer anillo.',
    clarifyAllowed: true,
  };

  it('una salida con la forma plana del esquema se traduce a la unión del contrato', () => {
    const fromModel = {
      action: 'reply',
      message: 'Estamos en el tercer anillo.',
      sources: ['loc-1'],
      reason: 'not_applicable',
    };
    expect(validateDecision(fromModel, context)).toEqual({
      ok: true,
      decision: { action: 'reply', message: 'Estamos en el tercer anillo.', sources: ['loc-1'] },
    });
  });

  it('el silencio ignora los campos que no aplican', () => {
    const fromModel = {
      action: 'silent',
      message: '',
      sources: [],
      reason: 'out_of_scope',
    };
    expect(validateDecision(fromModel, context)).toEqual({
      ok: true,
      decision: { action: 'silent', reason: 'out_of_scope' },
    });
  });
});
