// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let registry: typeof import('../../../registry');

describe('resource usage compatibility plugin', () => {
  beforeEach(async () => {
    vi.resetModules();
    registry = await import('../../../registry');
    await import('../index');
  });

  afterEach(() => {
    registry._resetTabKindRegistry();
  });

  it('restores persisted resource usage tabs without exposing a new-tab entry', () => {
    const plugin = registry.getTabKind('resource-usage');

    expect(plugin).not.toBeNull();
    expect(plugin?.menu.hiddenFromMenu).toBe(true);
    expect(registry.listTabKindMenuMetas()).not.toContainEqual(
      expect.objectContaining({ kind: 'resource-usage' }),
    );
  });
});
