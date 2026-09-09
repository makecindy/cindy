import { describe, expect, it, vi } from 'vitest';
import type { RemoteForward } from '@cindy/maker-remote-ssh';

import { createPiRemoteProviderForwardLease } from '../pi-remote-provider-forward';

describe('Pi remote provider forward lease', () => {
  it('gives overlapping transport wrappers independent handles for the same tunnel', async () => {
    const closeOld = vi.fn(async () => undefined);
    const closeReplacement = vi.fn(async () => undefined);
    const handles: RemoteForward[] = [
      { remotePort: 43121, close: closeOld },
      { remotePort: 43121, close: closeReplacement },
    ];
    const ensureRemoteForward = vi.fn(async () => handles.shift()!);
    const oldLease = createPiRemoteProviderForwardLease(ensureRemoteForward);
    const replacementLease = createPiRemoteProviderForwardLease(ensureRemoteForward);
    const spec = { localUrl: 'http://127.0.0.1:43120', remotePort: 43121 };

    await oldLease.ensure(spec);
    await replacementLease.ensure(spec);
    expect(ensureRemoteForward).toHaveBeenCalledTimes(2);

    await oldLease.releaseAll();
    expect(closeOld).toHaveBeenCalledTimes(1);
    expect(closeReplacement).not.toHaveBeenCalled();

    await replacementLease.ensure(spec);
    expect(ensureRemoteForward).toHaveBeenCalledTimes(2);
    await replacementLease.releaseAll();
    await replacementLease.releaseAll();
    expect(closeReplacement).toHaveBeenCalledTimes(1);
  });
});
