// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const resetSoundEnabled = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useNotificationSettings', () => ({
  useNotificationSettings: () => ({
    enabled: true,
    setEnabled: vi.fn(),
    soundEnabled: false,
    soundIsCustomized: true,
    setSoundEnabled: vi.fn(),
    resetSoundEnabled,
  }),
}));
vi.mock('@/components/ui/switch', () => ({
  Switch: ({ 'aria-label': ariaLabel }: { 'aria-label': string }) => (
    <button type="button" aria-label={ariaLabel} />
  ),
}));
vi.mock('../DefaultOverrideControls', () => ({
  DefaultOverrideControls: ({
    isCustomized,
    onReset,
  }: {
    isCustomized: boolean;
    onReset: () => void;
  }) => (isCustomized ? <button onClick={onReset}>restore-sound-default</button> : null),
}));

import { NotificationSection } from '../NotificationSection';

describe('NotificationSection', () => {
  it('offers a restore-default action for a customized sound preference', () => {
    render(<NotificationSection />);
    fireEvent.click(screen.getByText('restore-sound-default'));
    expect(resetSoundEnabled).toHaveBeenCalledOnce();
  });
});
