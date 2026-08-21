// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { shortcut?: string }) => {
      const translations: Record<string, string> = {
        'settings.composer.title': 'Message input',
        'settings.composer.sendShortcut.label': 'Send shortcut',
        'settings.composer.sendShortcut.hint':
          'Choose when Enter sends the message and when it inserts a new line. Shift+Enter always inserts a new line.',
        'settings.composer.sendShortcut.ariaLabel': 'Send shortcut',
        'settings.composer.sendShortcut.options.enter': 'Enter',
        'settings.composer.sendShortcut.options.modifier-enter-multiline':
          '{{shortcut}} for multiline messages',
        'settings.composer.sendShortcut.options.modifier-enter': '{{shortcut}} always',
        'settings.defaults.customizedBadge': 'Customized',
        'settings.defaults.restore': 'Restore default',
        'settings.defaults.restored': 'Restored default',
        'settings.shortcuts.errors.composerVoiceConflict':
          'Conflicts with the voice input shortcut. Change either shortcut.',
      };
      return (translations[key] ?? key).replace('{{shortcut}}', options?.shortcut ?? '');
    },
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/lib/toast', () => ({
  toast: toastMocks,
}));

import {
  COMPOSER_SEND_SHORTCUT_STORAGE_KEY,
  _resetComposerSendShortcutPreferenceForTests,
} from '@/hooks/useComposerSendShortcutPreference';
import { ComposerSendShortcutSection } from '../ComposerSendShortcutSection';

function setPlatform(platform: string): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform },
  });
}

function setVoiceInputShortcut(shortcut: object | null): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      voiceInput: {
        getDataSnapshot: () => ({ settings: { shortcut } }),
      },
    },
  });
}

async function openSelect(trigger: HTMLElement): Promise<void> {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown', code: 'ArrowDown' });
  await waitFor(() => expect(screen.getByRole('listbox')).toBeTruthy());
}

describe('ComposerSendShortcutSection', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetComposerSendShortcutPreferenceForTests();
    toastMocks.error.mockReset();
    toastMocks.success.mockReset();
    setPlatform('win32');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('shows the default Enter mode and platform-specific option copy', async () => {
    setPlatform('darwin');

    render(<ComposerSendShortcutSection />);

    const trigger = screen.getByRole('combobox', { name: 'Send shortcut' });
    expect(trigger.textContent).toContain('Enter');
    expect(screen.queryByText('Customized')).toBeNull();

    await openSelect(trigger);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Enter',
      '⌘+Enter for multiline messages',
      '⌘+Enter always',
    ]);
  });

  it('persists mode B, synchronizes subscribers, and restores the default override', async () => {
    render(
      <>
        <ComposerSendShortcutSection />
        <ComposerSendShortcutSection />
      </>,
    );

    const triggers = screen.getAllByRole('combobox', { name: 'Send shortcut' });
    await openSelect(triggers[0]);
    fireEvent.click(screen.getByRole('option', { name: 'Ctrl+Enter always' }));

    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBe('modifier-enter');
    expect(triggers[0].textContent).toContain('Ctrl+Enter always');
    expect(triggers[1].textContent).toContain('Ctrl+Enter always');
    expect(screen.getAllByText('Customized')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Restore default' })[0]);

    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBeNull();
    expect(triggers[0].textContent).toContain('Enter');
    expect(triggers[1].textContent).toContain('Enter');
    expect(toastMocks.success).toHaveBeenCalledWith('Restored default');
  });

  it('persists the multiline mode', async () => {
    render(<ComposerSendShortcutSection />);

    const trigger = screen.getByRole('combobox', { name: 'Send shortcut' });
    await openSelect(trigger);
    fireEvent.click(screen.getByRole('option', { name: 'Ctrl+Enter for multiline messages' }));

    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBe(
      'modifier-enter-multiline',
    );
    expect(trigger.textContent).toContain('Ctrl+Enter for multiline messages');
  });

  it('rejects modifier modes when Voice Input already uses the shortcut', async () => {
    setVoiceInputShortcut({
      trigger: 'keyboard',
      code: 'Enter',
      key: 'Enter',
      modifiers: { meta: true, ctrl: false, alt: false, shift: false, fn: false },
    });

    render(<ComposerSendShortcutSection />);
    const trigger = screen.getByRole('combobox', { name: 'Send shortcut' });

    for (const optionName of ['⌘+Enter always', '⌘+Enter for multiline messages']) {
      await openSelect(trigger);
      fireEvent.click(screen.getByRole('option', { name: optionName }));

      expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBeNull();
      expect(trigger.textContent).toContain('Enter');
      expect(toastMocks.error).toHaveBeenCalledWith(
        'Conflicts with the voice input shortcut. Change either shortcut.',
      );
      toastMocks.error.mockReset();
    }
  });
});
