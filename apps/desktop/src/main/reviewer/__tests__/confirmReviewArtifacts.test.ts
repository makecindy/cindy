import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ trust: vi.fn(), parent: vi.fn(), show: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: mocks.parent } }));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: mocks.trust }));
vi.mock('../../i18n', () => ({ t: (key: string) => key }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../reviewArtifactConfirmWindow', () => ({ showReviewArtifactConfirmWindow: mocks.show }));

import { confirmReviewArtifacts } from '../confirmReviewArtifacts';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.parent.mockReturnValue({ isDestroyed: () => false });
  mocks.show.mockResolvedValue(true);
});

describe('Review native confirmation sender boundary', () => {
  const event = { sender: { id: 42 } } as IpcMainInvokeEvent;
  const items = [{ kind: 'external-path' as const, label: 'external.md' }];

  it('uses the requesting app window and awaits its native decision', async () => {
    await expect(confirmReviewArtifacts(event, items)).resolves.toBe(true);
    expect(mocks.trust).toHaveBeenCalledWith(event);
    expect(mocks.parent).toHaveBeenCalledWith(event.sender);
    expect(mocks.show).toHaveBeenCalledOnce();
    mocks.show.mockResolvedValue(false);
    await expect(confirmReviewArtifacts(event, items)).resolves.toBe(false);
  });

  it('rejects an untrusted sender before opening any window', async () => {
    mocks.trust.mockImplementation(() => { throw new Error('untrusted'); });
    await expect(confirmReviewArtifacts(event, items)).rejects.toThrow('untrusted');
    expect(mocks.parent).not.toHaveBeenCalled();
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it.each([null, { isDestroyed: () => true }])('denies when the sender has no live app window', async (parent) => {
    mocks.parent.mockReturnValue(parent);
    await expect(confirmReviewArtifacts(event, items)).resolves.toBe(false);
    expect(mocks.show).not.toHaveBeenCalled();
  });
});
