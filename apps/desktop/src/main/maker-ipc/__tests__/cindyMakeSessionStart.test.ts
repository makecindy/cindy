import { describe, expect, it, vi } from 'vitest';

import { CINDY_MAKE_VENDOR_OPTION_KEY } from '../../../shared/cindyMakeSession';
import { applyPersistedCindyMakeMarker } from '../cindyMakeSessionStart';

describe('applyPersistedCindyMakeMarker', () => {
  it('hydrates the marker only from a persisted cindy-make source', async () => {
    const readSource = vi.fn(async (id: string) => (id === 'make-1' ? 'cindy-make' : 'desktop'));

    const marked = { id: 'make-1', vendorOptions: { source: 'draft' } };
    await expect(applyPersistedCindyMakeMarker(marked, readSource)).resolves.toBe(true);
    expect(marked.vendorOptions).toEqual({ source: 'draft', [CINDY_MAKE_VENDOR_OPTION_KEY]: true });

    const ordinary: { id: string; vendorOptions?: Record<string, unknown> } = { id: 'plain-1' };
    await expect(applyPersistedCindyMakeMarker(ordinary, readSource)).resolves.toBe(false);
    expect(ordinary.vendorOptions).toBeUndefined();
  });

  it('ignores options without a session id and never trusts a caller-supplied marker', async () => {
    const readSource = vi.fn(async () => 'cindy-make');
    const anonymous = { vendorOptions: { [CINDY_MAKE_VENDOR_OPTION_KEY]: true } };
    await expect(applyPersistedCindyMakeMarker(anonymous, readSource)).resolves.toBe(false);
    expect(readSource).not.toHaveBeenCalled();
  });

  it('refuses remote Cindy Make tasks', async () => {
    await expect(
      applyPersistedCindyMakeMarker(
        { id: 'make-1', remoteHostId: 'build-box' },
        async () => 'cindy-make',
      ),
    ).rejects.toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
  });
});
