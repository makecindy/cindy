import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assertTrusted, parent, showMessageBox, showOpenDialog } = vi.hoisted(() => ({
  assertTrusted: vi.fn(),
  parent: { isDestroyed: vi.fn(() => false) },
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => parent },
  dialog: { showMessageBox, showOpenDialog },
}));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: assertTrusted }));

import { selectReviewWorkspace } from '../reviewWorkspaceSelection.js';

beforeEach(() => {
  vi.clearAllMocks();
  parent.isDestroyed.mockReturnValue(false);
  assertTrusted.mockImplementation(() => {});
  showMessageBox.mockResolvedValue({ response: 1 });
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/repo/actual'] });
});

describe('Review directory selection', () => {
  const event = { sender: {} } as IpcMainInvokeEvent;

  it('uses the directory picked in a native dialog without changing the source task', async () => {
    expect(await selectReviewWorkspace(event, '/repo/main')).toBe('/repo/actual');
    expect(assertTrusted).toHaveBeenCalledWith(event);
    expect(showMessageBox).toHaveBeenCalledWith(parent, expect.objectContaining({ detail: '/repo/main' }));
    expect(showOpenDialog).toHaveBeenCalledWith(parent, expect.objectContaining({ properties: ['openDirectory'] }));
  });

  it('lets the user explicitly review the current tree even without a diff', async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    expect(await selectReviewWorkspace(event, '/repo/main')).toBe('/repo/main');
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it.each(['question', 'picker', 'closed-window'])('cancels cleanly at %s', async (stage) => {
    if (stage === 'question') showMessageBox.mockResolvedValue({ response: 2 });
    if (stage === 'picker') showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    if (stage === 'closed-window') parent.isDestroyed.mockReturnValue(true);
    expect(await selectReviewWorkspace(event, '/repo/main')).toBeNull();
  });

  it('rejects an untrusted caller before opening a directory picker', async () => {
    assertTrusted.mockImplementation(() => { throw new Error('untrusted renderer'); });
    await expect(selectReviewWorkspace(event, '/repo/main')).rejects.toThrow('untrusted renderer');
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});
