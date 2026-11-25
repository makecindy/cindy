import { describe, expect, it } from 'vitest';
import { settingsWebResultSchema, settingsWebUpdateSchema } from '../settingsWeb.js';

// Same neutral wire fixtures are maintained in the client and CIS repositories.
function result(count: number, label = 'Model') {
  return { ok: true, settings: {
    status: 'ready', domain: 'modelVisibility', revision: 'fixture-revision',
    operationId: '00000000-0000-4000-8000-000000000001',
    customizedKeys: [], isCustomized: false, value: { entries: [] }, defaults: { entries: [] },
    choices: { entries: Array.from({ length: count }, (_, i) => ({ value: `model-${i}`, label })) },
  } };
}
describe('settings catalog choice capacity', () => {
  it.each([256, 267, 512])('accepts %i options without truncation', count => {
    const parsed = settingsWebResultSchema.parse(result(count));
    expect(parsed).toEqual(result(count));
  });
  it('rejects more than 512 options even within the byte budget', () => {
    expect(settingsWebResultSchema.safeParse(result(513)).success).toBe(false);
  });
  it('still rejects oversized UTF-8 responses below the option limit', () => {
    expect(settingsWebResultSchema.safeParse(result(100, '模'.repeat(256))).success).toBe(false);
  });
  it('still rejects oversized individual labels', () => {
    expect(settingsWebResultSchema.safeParse(result(1, 'x'.repeat(513))).success).toBe(false);
  });
  it('does not expand saved override capacity with the read-only catalog', () => {
    expect(settingsWebUpdateSchema.safeParse({ domain: 'modelVisibility', expectedRevision: 'fixture',
      operationId: '00000000-0000-4000-8000-000000000001', set: { entries: Array.from({ length: 257 }, (_, i) => ({
        providerId: 'fixture', modelId: `model-${i}`, harness: 'pi', enabled: true,
      })) },
    }).success).toBe(false);
  });
});
