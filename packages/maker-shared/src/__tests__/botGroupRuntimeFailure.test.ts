import { describe, expect, it } from 'vitest';
import { readImportedBotGroupRuntimeFailureCode } from '../botGroupChat.js';

const card = { type: 'card', namespace: 'cindy.local-history', schemaRevision: 1,
  fallback: 'group activity', data: { kind: 'notice', authorKind: 'system', runtimeFailureCode: 'AUTH_REQUIRED' } };
const imported = { origin: 'import', deleted: false, content: [card] };

describe('imported group runtime notices', () => {
  it('reads only the public category, without returning private metadata', () => {
    expect(readImportedBotGroupRuntimeFailureCode({ ...imported, content: [{ ...card,
      data: { ...card.data, message: 'private diagnostic' } }] })).toBe('AUTH_REQUIRED');
  });
  it.each(['chat', 'system', 'integration', undefined])('rejects spoofed origin %s', origin => {
    expect(readImportedBotGroupRuntimeFailureCode({ ...imported, origin })).toBeUndefined();
  });
  it.each([
    { ...card, type: 'text' }, { ...card, namespace: 'custom.history' }, { ...card, schemaRevision: 2 },
    { ...card, data: { ...card.data, kind: 'message' } }, { ...card, data: { ...card.data, authorKind: 'user' } },
    { ...card, data: { ...card.data, runtimeFailureCode: 'private diagnostic' } }, { ...card, data: null },
  ])('ignores malformed or ordinary history %j', block => {
    expect(readImportedBotGroupRuntimeFailureCode({ ...imported, content: [block] })).toBeUndefined();
  });
  it('ignores a deleted imported notice', () => {
    expect(readImportedBotGroupRuntimeFailureCode({ ...imported, deleted: true })).toBeUndefined();
  });
  it.each(['text', 'fallback'])('recovers an older exact marker in %s', field => {
    const oldCard = { ...card, data: { kind: 'notice', authorKind: 'system' },
      ...(field === 'fallback' ? { fallback: 'cindy-runtime-error:RUNTIME_TIMEOUT' } : {}) };
    expect(readImportedBotGroupRuntimeFailureCode({ ...imported, content: [oldCard,
      ...(field === 'text' ? [{ type: 'text', text: 'cindy-runtime-error:RUNTIME_TIMEOUT' }] : [])] })).toBe('RUNTIME_TIMEOUT');
  });
  it('rejects arbitrary or partial old markers', () => {
    const oldCard = { ...card, data: { kind: 'notice', authorKind: 'system' } };
    for (const text of ['cindy-runtime-error:AUTH_REQUIRED private diagnostic', 'cindy-runtime-error:private diagnostic']) {
      expect(readImportedBotGroupRuntimeFailureCode({ ...imported, content: [oldCard, { type: 'text', text }] })).toBeUndefined();
    }
  });
});
