import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assertRendererSessionSourceAllowed } from '../sessionSourceGuard';

const userData = path.resolve('C:\\Users\\me\\AppData\\Roaming\\Cindy');
const worktree = path.join(userData, 'cindy-make', 'worktrees', 'run-1');
const checkout = path.join(userData, 'cindy-make', 'source');

describe('assertRendererSessionSourceAllowed', () => {
  it('lets ordinary creates through without a source', () => {
    expect(() =>
      assertRendererSessionSourceAllowed({
        source: undefined,
        workingDir: 'C:\\repo',
        remoteHostId: null,
        userData,
      }),
    ).not.toThrow();
  });

  it('accepts the Cindy Make purpose only for a managed task worktree', () => {
    expect(() =>
      assertRendererSessionSourceAllowed({
        source: 'cindy-make',
        workingDir: worktree,
        remoteHostId: null,
        userData,
      }),
    ).not.toThrow();
    for (const workingDir of [
      checkout,
      'C:\\repo',
      undefined,
      path.join(userData, 'cindy-make', 'worktrees'),
      path.join(worktree, 'apps'),
      path.join(userData, 'cindy-make', 'worktrees', '..', 'source'),
    ]) {
      expect(() =>
        assertRendererSessionSourceAllowed({
          source: 'cindy-make',
          workingDir,
          remoteHostId: null,
          userData,
        }),
      ).toThrow(/\[INVALID_PARAMS\]/);
    }
  });

  it('rejects remote hosts and every other renderer-requested source', () => {
    expect(() =>
      assertRendererSessionSourceAllowed({
        source: 'cindy-make',
        workingDir: worktree,
        remoteHostId: 'build-box',
        userData,
      }),
    ).toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    for (const source of ['bot', 'review', 'desktop']) {
      expect(() =>
        assertRendererSessionSourceAllowed({
          source,
          workingDir: worktree,
          remoteHostId: null,
          userData,
        }),
      ).toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    }
  });
});
