// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SshKeySetupDialog } from '../SshKeySetupDialog';

const api = vi.hoisted(() => ({
  listLocalKeys: vi.fn(),
  addKeyToAgent: vi.fn(),
}));
const translate = (key: string) => key;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
}));

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const key = {
  privateKeyPath: '/home/user/.ssh/id_ed25519',
  pubkeyPath: '/home/user/.ssh/id_ed25519.pub',
  type: 'ed25519',
  comment: 'user@example.com',
  fingerprintSha256: 'SHA256:abc123=',
  inAgent: false,
  mtimeIso: null,
};

describe('SshKeySetupDialog unlock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listLocalKeys.mockResolvedValue({ keys: [key] });
    api.addKeyToAgent.mockResolvedValue({
      result: { success: true, failureReason: null, errorHint: null, stderr: '' },
    });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      platform: 'win32',
      remoteSsh: {
        listLocalKeys: api.listLocalKeys,
        addKeyToAgent: api.addKeyToAgent,
      },
    };
  });

  afterEach(cleanup);

  async function openUnlockDialog() {
    render(<SshKeySetupDialog hostId={null} open onOpenChange={vi.fn()} />);
    await waitFor(() => expect(api.listLocalKeys).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'settings.remote.keys.unlockButton' }));
    return screen.findByLabelText('settings.remote.keys.passLabel');
  }

  it('lets the user click Unlock with an empty passphrase', async () => {
    await openUnlockDialog();
    const unlock = screen.getByRole('button', { name: 'settings.remote.keys.unlockSubmit' });

    expect((unlock as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(unlock);

    await waitFor(() =>
      expect(api.addKeyToAgent).toHaveBeenCalledWith({
        privateKeyPath: key.privateKeyPath,
        passphrase: '',
      }),
    );
  });

  it.each(['', 'secret'])(
    'does not submit from Enter with passphrase %j',
    async (value) => {
      const passphrase = await openUnlockDialog();
      if (value) fireEvent.change(passphrase, { target: { value } });

      fireEvent.keyDown(passphrase, { key: 'Enter' });

      expect(api.addKeyToAgent).not.toHaveBeenCalled();
    },
  );
});
