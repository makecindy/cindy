import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CINDY_MAKE_VENDOR_OPTION_KEY } from '../../../shared/cindyMakeSession';
import { applyPersistedCindyMakeMarker } from '../cindyMakeSessionStart';

const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock('@cindy/maker-shared/cindy-make-feature', async (importOriginal) => ({
  ...await importOriginal<typeof import('@cindy/maker-shared/cindy-make-feature')>(),
  get CINDY_MAKE_ENABLED() { return feature.enabled; },
}));
beforeEach(() => { feature.enabled = true; });

describe('applyPersistedCindyMakeMarker', () => {
  it.each(['cindy-make', 'cindy-make-merge'])('refuses to resume a persisted %s task while disabled', async (source) => {
    feature.enabled = false;
    const options = { id: 'old-task', vendorOptions: { source: 'draft' } };
    await expect(applyPersistedCindyMakeMarker(options, async () => source)).rejects.toThrow(
      /\[UNSUPPORTED_CAPABILITY\]/,
    );
    expect(options.vendorOptions).toEqual({ source: 'draft' });
  });

  it('still allows ordinary tasks while disabled', async () => {
    feature.enabled = false;
    await expect(applyPersistedCindyMakeMarker({ id: 'ordinary' }, async () => 'desktop')).resolves.toBe(false);
  });
  it('does not give an upstream merge task the personal-build harness', async () => {
    const options: { id: string; vendorOptions?: Record<string, unknown> } = { id: 'merge' };
    expect(await applyPersistedCindyMakeMarker(options, async () => 'cindy-make-merge')).toBe(false);
    expect(options.vendorOptions?.[CINDY_MAKE_VENDOR_OPTION_KEY]).not.toBe(true);
  });
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
