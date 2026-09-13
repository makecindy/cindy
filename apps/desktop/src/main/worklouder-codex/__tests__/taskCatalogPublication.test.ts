import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearRendererTaskCatalog,
  publishRendererTaskCatalog,
  readRendererTaskCatalog,
  subscribeRendererTaskCatalog,
} from '../taskCatalogPublication.js';

const row = { id: 'task', title: 'Task', pinnedAt: null, userSendAt: null };

describe('renderer task catalog publication', () => {
  beforeEach(() => clearRendererTaskCatalog());

  it('keeps the projection scoped to the publishing owner', () => {
    publishRendererTaskCatalog([row], 'owner-a');
    expect(readRendererTaskCatalog('owner-a')).toEqual([row]);
    expect(readRendererTaskCatalog('owner-b')).toBeNull();
    expect(readRendererTaskCatalog('owner-a')).toBeNull();
  });

  it('preserves an empty renderer projection and notifies subscribers on clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRendererTaskCatalog(listener);
    publishRendererTaskCatalog([], 'owner-a');
    expect(readRendererTaskCatalog('owner-a')).toEqual([]);
    clearRendererTaskCatalog();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
