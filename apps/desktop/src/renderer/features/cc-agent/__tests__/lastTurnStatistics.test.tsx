// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LastTurnStatistics, latestTurnStatistics } from '../LastTurnStatistics';
import { LastTurnStatisticsCell, LastTurnStatisticsSettings } from '@/components/settings/LastTurnStatisticsCell';
import { useLastTurnStatisticsPreference } from '@/hooks/useLastTurnStatisticsPreference';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { TurnUsageDetails } from '../../../../shared/turnUsageDetails';
import { SettingsSearchNavigationContext } from '@/components/settings/SettingsSearchNavigation';
import { additionalSettings } from '@/components/settings/AdditionalSettings.settings-search';
import en from '@/i18n/locales/en/common.json';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => {
  const text = key.split('.').reduce<unknown>((value, part) => (value as Record<string, unknown>)?.[part], en);
  return String(text ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''));
} }) }));

const details: TurnUsageDetails = { inputTokens: 9000, outputTokens: 1234, totalTokens: 10234,
  cacheReadTokens: 0, cacheCreateTokens: 0, cacheHitRate: 0, turnDurationMs: 123000 };
const user = { clientId: 'user', role: 'user', content: 'Test' } as ChatMessage;
const answer = { clientId: 'answer', role: 'assistant', content: 'Done', turnUsageDetails: details } as ChatMessage;

afterEach(() => {
  const preference = renderHook(useLastTurnStatisticsPreference);
  act(() => preference.result.current.setEnabled(false));
  cleanup();
});

// Unit: #13138 needs saved output/duration after switching away; no live counter or latest-user leak.
it('selects and aggregates only the current user turn', () => {
  const older = { ...answer, clientId: 'older', turnUsageDetails: { ...details, outputTokens: 8, totalTokens: 8 } };
  expect(latestTurnStatistics([user, older, { ...user, clientId: 'new-user' }])).toBeNull();
  expect(latestTurnStatistics([user, answer])?.details).toBe(details);
  const next = { ...answer, clientId: 'next', turnUsageDetails: { ...details, outputTokens: 20, totalTokens: 20 } };
  expect(latestTurnStatistics([user, answer, next])?.details.outputTokens).toBe(1254);
  expect(latestTurnStatistics([])).toBeNull();
});

it('shows saved output tokens rather than total tokens and opens details without a trace', () => {
  render(<LastTurnStatistics details={details} />);
  const button = screen.getByRole('button');
  expect(button.textContent).toContain('1.2k');
  expect(button.textContent).not.toContain('10.2k');
  fireEvent.click(button);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.queryByTestId('turn-generation-trace')).toBeNull();
});

it('uses the persisted speed trace when available', () => {
  render(<LastTurnStatistics details={{ ...details, trace: { durationMs: 20000, requests: 1,
    speed: [[10000, 50], [20000, 60]], marks: [[20000, 100, 1]], reportedOutputTokens: 1234 } }} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByTestId('turn-generation-trace')).toBeTruthy();
});

it('defaults off, synchronizes mounted controls and removes the override on reset', () => {
  const first = renderHook(useLastTurnStatisticsPreference);
  const second = renderHook(useLastTurnStatisticsPreference);
  expect(first.result.current.enabled).toBe(false);
  act(() => first.result.current.setEnabled(true));
  expect(second.result.current.enabled).toBe(true);
  expect(localStorage.getItem('chat.lastTurnStatistics.enabled')).toBe('true');
  act(() => second.result.current.setEnabled(false));
  expect(first.result.current.isCustomized).toBe(false);
  expect(localStorage.getItem('chat.lastTurnStatistics.enabled')).toBeNull();
});

it('follows cross-window changes and storage clearing', () => {
  const preference = renderHook(useLastTurnStatisticsPreference);
  act(() => {
    localStorage.setItem('chat.lastTurnStatistics.enabled', 'true');
    window.dispatchEvent(new StorageEvent('storage', { key: 'chat.lastTurnStatistics.enabled', newValue: 'true' }));
  });
  expect(preference.result.current.enabled).toBe(true);
  act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null })); });
  expect(preference.result.current.enabled).toBe(false);
});

it('the real settings control updates the live preference', () => {
  const preference = renderHook(useLastTurnStatisticsPreference);
  render(<LastTurnStatisticsCell />);
  fireEvent.click(screen.getByRole('switch'));
  expect(preference.result.current.enabled).toBe(true);
});

it('keeps the advanced group closed until opened or selected in settings search', () => {
  const { container, rerender } = render(<LastTurnStatisticsSettings />);
  expect(container.querySelector('details')?.open).toBe(false);
  rerender(<SettingsSearchNavigationContext.Provider value={{ entry: additionalSettings.lastTurnStatistics, activation: 1 }}>
    <LastTurnStatisticsSettings />
  </SettingsSearchNavigationContext.Provider>);
  expect(container.querySelector('details')?.open).toBe(true);
  expect(screen.getByRole('switch')).toBeTruthy();
});

it('reads changes made while there were no subscribers', () => {
  const preference = renderHook(useLastTurnStatisticsPreference);
  act(() => preference.result.current.setEnabled(true));
  preference.unmount();
  localStorage.removeItem('chat.lastTurnStatistics.enabled');
  const reopened = renderHook(useLastTurnStatisticsPreference);
  expect(reopened.result.current.enabled).toBe(false);
});

it('keeps a user selection usable when storage rejects a write', () => {
  const preference = renderHook(useLastTurnStatisticsPreference);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage unavailable'); });
  act(() => preference.result.current.setEnabled(true));
  expect(preference.result.current.enabled).toBe(true);
  write.mockRestore();
});
