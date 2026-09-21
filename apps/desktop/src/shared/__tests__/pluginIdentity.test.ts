import { describe, expect, it } from 'vitest';
import {
  createPluginLogicalIdentity,
  parsePluginLogicalIdentityKey,
  pluginLogicalIdentityKey,
  resolvePluginNamespaceState,
} from '../pluginIdentity.js';

describe('plugin logical identity', () => {
  it('distinguishes root and enterprise instances with the same ghostId', () => {
    const root = createPluginLogicalIdentity(null, 'helper');
    const enterprise = createPluginLogicalIdentity('acme', 'helper');

    expect(pluginLogicalIdentityKey(root)).not.toBe(pluginLogicalIdentityKey(enterprise));
    expect(parsePluginLogicalIdentityKey(pluginLogicalIdentityKey(root))).toEqual(root);
    expect(parsePluginLogicalIdentityKey(pluginLogicalIdentityKey(enterprise))).toEqual(enterprise);
  });

  it('keeps missing namespace as legacy instead of silently mapping it to root', () => {
    expect(resolvePluginNamespaceState({})).toEqual({ kind: 'legacy' });
    expect(resolvePluginNamespaceState({ namespace: null })).toEqual({
      kind: 'known',
      namespace: null,
    });
  });

  it('rejects malformed identity components and ambiguous keys', () => {
    expect(() => createPluginLogicalIdentity('Bad Namespace', 'helper')).toThrow();
    expect(() => createPluginLogicalIdentity(null, 'Bad Ghost Id')).toThrow();
    expect(() => parsePluginLogicalIdentityKey('acme\u0000helper\u0000extra')).toThrow();
    expect(() => parsePluginLogicalIdentityKey('%E0%A4%A\u0000helper')).toThrow();
  });
});
