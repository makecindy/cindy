// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { toast } from '@/lib/toast';
import { WindowControls } from '../WindowControls';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Unit: the first-run close dialog must release the window even when the main
// profile write is refused. The renderer may apply the chosen action once.
it('dismisses the first Windows close dialog and applies the unsaved choice once', async () => {
  const refuse = new Error('[PRECONDITION_FAILED] fixture refusal');
  const windowClose = vi.fn();
  const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
  const setWindowsCloseBehavior = vi.fn().mockRejectedValue(refuse);
  vi.stubGlobal('electronAPI', {
    platform: 'win32',
    windowClose,
    windowBehavior: {
      getWindowsCloseBehavior: vi.fn().mockResolvedValue(null),
      setWindowsCloseBehavior,
      onWindowsCloseBehaviorRequested: () => () => {},
      notifyWindowsCloseBehaviorPromptShown: vi.fn(),
    },
  });

  render(<WindowControls />);
  fireEvent.click(screen.getByRole('button', { name: 'titleBar.close' }));
  const tray = await screen.findByRole('button', { name: 'settings.windowBehavior.closeBehavior.tray' });
  fireEvent.click(tray);
  await waitFor(() => expect(windowClose).toHaveBeenCalledExactlyOnceWith('tray'));

  expect(setWindowsCloseBehavior).toHaveBeenCalledExactlyOnceWith('tray');
  expect(errorToast).toHaveBeenCalledExactlyOnceWith('ipcError.PRECONDITION_FAILED');
  expect(screen.queryByText('settings.windowBehavior.closePrompt.title')).toBeNull();
});
