// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | null>) => {
      const translations: Record<string, string> = {
        'settings.composer.title': 'Message input',
        'settings.composer.sendShortcut.label': 'Use {{shortcut}} to send',
        'settings.composer.sendShortcut.hint': 'Enter sends. Shift+Enter inserts a new line.',
        'settings.composer.sendShortcut.hintModifierEnter': '{{shortcut}} sends. Enter inserts a new line.',
        'settings.composer.sendShortcut.ariaLabel': 'Use {{shortcut}} to send messages',
        'settings.composer.followUp.label': 'While a task is running',
        'settings.composer.followUp.hintQueue': 'Send button and {{send}} queue.',
        'settings.composer.followUp.hintSteer': 'Send button and {{send}} steer.',
        'settings.composer.followUp.ariaLabel': 'Delivery while a task is running',
        'settings.composer.followUp.options.queue': 'Queue',
        'settings.composer.followUp.options.steer': 'Steer',
        'settings.defaults.customizedBadge': 'Customized',
        'settings.defaults.restore': 'Restore default',
        'settings.defaults.restored': 'Restored default',
        'settings.shortcuts.errors.composerVoiceConflict':
          'Conflicts with the voice input shortcut. Change either shortcut.',
      };
      return (translations[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? ''));
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
  COMPOSER_FOLLOW_UP_STORAGE_KEY,
  _resetComposerFollowUpPreferenceForTests,
} from '@/hooks/useComposerFollowUpPreference';
import {
  COMPOSER_SEND_SHORTCUT_STORAGE_KEY,
  _resetComposerSendShortcutPreferenceForTests,
} from '@/hooks/useComposerSendShortcutPreference';
import { ComposerSendShortcutSection } from '../ComposerSendShortcutSection';

function setPlatform(platform: string): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { platform, voiceInput: { onDataChanged: () => () => {} } },
  });
}

function setVoiceInputShortcut(shortcut: object | null): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      voiceInput: {
        getDataSnapshot: () => ({ settings: { shortcut } }),
        onDataChanged: () => () => {},
      },
    },
  });
}

describe('ComposerSendShortcutSection', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetComposerSendShortcutPreferenceForTests();
    _resetComposerFollowUpPreferenceForTests();
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
    expect(screen.queryByText('Enter sends. Shift+Enter inserts a new line.')).not.toBeNull();
  });

  it('synchronizes mode B across subscribers and switches the copy to the modifier send key', () => {
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
    expect(screen.getAllByText('Ctrl+Enter sends. Enter inserts a new line.')).toHaveLength(2);

    fireEvent.click(switches[1]);

    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBeNull();
    expect(switches[0].getAttribute('data-state')).toBe('unchecked');
    expect(switches[1].getAttribute('data-state')).toBe('unchecked');
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

  it('shows only the Queue/Steer choice, with no override badge or restore control', () => {
    setPlatform('darwin');
    render(<ComposerSendShortcutSection />);

    expect(screen.getByRole('radiogroup', { name: 'Delivery while a task is running' })).not.toBeNull();
    expect(screen.getByText('While a task is running')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Queue' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Send button and Enter queue.')).not.toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Steer' }));
    expect(localStorage.getItem(COMPOSER_FOLLOW_UP_STORAGE_KEY)).toBe('steer');
    expect(localStorage.getItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY)).toBeNull();
    expect(screen.getByText('Send button and Enter steer.')).not.toBeNull();
    expect(screen.queryByText('Customized')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restore default' })).toBeNull();

    // Choosing the default removes the override, as before.
    fireEvent.click(screen.getByRole('radio', { name: 'Queue' }));
    expect(localStorage.getItem(COMPOSER_FOLLOW_UP_STORAGE_KEY)).toBeNull();
  });

  it('names the configured send key for the selected mode, never another key', () => {
    setPlatform('win32');
    localStorage.setItem(COMPOSER_SEND_SHORTCUT_STORAGE_KEY, 'modifier-enter');
    localStorage.setItem(COMPOSER_FOLLOW_UP_STORAGE_KEY, 'steer');
    _resetComposerSendShortcutPreferenceForTests();
    _resetComposerFollowUpPreferenceForTests();
    render(<ComposerSendShortcutSection />);

    expect(screen.getByText('Send button and Ctrl+Enter steer.')).not.toBeNull();
    expect(screen.queryByText(/Shift/)).toBeNull();
  });
});
