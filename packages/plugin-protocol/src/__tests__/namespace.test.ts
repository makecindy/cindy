import { describe, expect, it } from 'vitest';
import {
  AUTHOR_DECLARED_NAMESPACE_REASON,
  authorDeclaredNamespaceReason,
  authorManifestDeclaresNamespace,
} from '../delivery.js';

describe('author namespace reservation', () => {
  it.each([null, 'xd', '', 42])('rejects own namespace %s before v2 normalization', (namespace) => {
    expect(authorManifestDeclaresNamespace({ id: 'example', namespace })).toBe(true);
    expect(authorDeclaredNamespaceReason({ id: 'example', namespace })).toBe(
      AUTHOR_DECLARED_NAMESPACE_REASON,
    );
  });

  it('allows author packages that omit the field', () => {
    expect(authorManifestDeclaresNamespace({ id: 'example' })).toBe(false);
    expect(authorDeclaredNamespaceReason({ id: 'example' })).toBeNull();
  });
});
