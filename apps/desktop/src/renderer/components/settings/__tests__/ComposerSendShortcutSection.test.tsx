// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
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
        'settings.composer.sendShortcut.label': 'Use {{shortcut}} to send',
        'settings.composer.sendShortcut.hint':
          'When enabled, {{shortcut}} sends messages. When disabled, Enter sends messages and Shift+Enter inserts a new line.',
        'settings.composer.sendShortcut.ariaLabel': 'Use {{shortcut}} to send messages',
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

describe('ComposerSendShortcutSection', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetComposerSendShortcutPreferenceForTests();
    toastMocks.error.mockReset();
    toastMocks.success.mockReset();
    setPlatform('win32');
  });

  it('shows the default Enter mode and platform-specific shortcut copy', () => {
    setPlatform('darwin');

    render(<ComposerSendShortcutSection />);

    expect(
      screen.getByRole('switch', { name: 'Use ⌘+Enter to send messages' }).getAttribute('data-state'),
    ).toBe('unchecked');
    expect(screen.queryByText('Use ⌘+Enter to send')).not.toBeNull();
    expect(
      screen.queryByText(
        'When enabled, ⌘+Enter sends messages. When disabled, Enter sends messages and Shift+Enter inserts a new line.',
      ),
    ).not.toBeNull();
  });

  it('synchronizes mode B across subscribers and restores the default override', () => {
    render(
      <>
        <ComposerSendShortcutSection />
        <ComposerSendShortcutSection />
      </>,
    );

    const switches = screen.getAllByRole('switch', { name: 'Use Ctrl+Enter to send messages' });
    fireEvent.click(switches[0]);

    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBe('modifier-enter');
    expect(switches[0].getAttribute('data-state')).toBe('checked');
    expect(switches[1].getAttribute('data-state')).toBe('checked');
    expect(screen.getAllByText('Customized')).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: 'Restore default' })[0]);

    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBeNull();
    expect(switches[0].getAttribute('data-state')).toBe('unchecked');
    expect(switches[1].getAttribute('data-state')).toBe('unchecked');
    expect(toastMocks.success).toHaveBeenCalledWith('Restored default');
  });

  it('rejects a Composer shortcut that is already used by Voice Input', () => {
    setVoiceInputShortcut({
      trigger: 'keyboard',
      code: 'Enter',
      key: 'Enter',
      modifiers: { meta: true, ctrl: false, alt: false, shift: false, fn: false },
    });

    render(<ComposerSendShortcutSection />);

    const switchControl = screen.getByRole('switch', { name: 'Use ⌘+Enter to send messages' });
    fireEvent.click(switchControl);

    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBeNull();
    expect(switchControl.getAttribute('data-state')).toBe('unchecked');
    expect(toastMocks.error).toHaveBeenCalledWith(
      'Conflicts with the voice input shortcut. Change either shortcut.',
    );
  });
});
