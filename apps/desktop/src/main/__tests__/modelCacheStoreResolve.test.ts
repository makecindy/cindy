import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('electron', () => ({
  app: { getPath: () => path.join(os.tmpdir(), 'model-cache-resolve') },
}));

const { resolveSafe } = await import('../modelCacheStore');

describe('modelCacheStore.resolveSafe', () => {
  it('rejects malformed percent-encoding as a malformed URL', () => {
    expect(() => resolveSafe('xdt-model://mivo-3d-cache/%E0%A4%A.glb')).toThrow(
      /malformed url/i,
    );
  });
});
