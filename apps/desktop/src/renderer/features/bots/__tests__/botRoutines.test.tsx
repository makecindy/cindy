// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { Routine } from '@cindy/maker-scheduler';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
import { BotRoutines } from '../BotRoutines';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('saves the visible edited instructions before running, and preserves every trigger', async () => {
  const routine: Routine = {
    id: 'routine',
    botId: 'bot',
    name: 'Review',
    prompt: 'Old instructions',
    enabled: true,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    triggers: [
      { id: 'timer', kind: 'interval', intervalMs: 3600000 },
      { id: 'pr', kind: 'event', sourceId: 'plugin:git', eventType: 'pr', filters: [] },
    ],
  };
  const calls: string[] = [];
  const save = vi.fn(async (_bot, input) => {
    calls.push('save');
    return { ...routine, ...input };
  });
  const runNow = vi.fn(async () => {
    calls.push('run');
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      routines: {
        list: vi.fn(async () => [routine]),
        sources: vi.fn(async () => []),
        history: vi.fn(async () => []),
        onChanged: vi.fn(() => () => {}),
        save,
        runNow,
      },
    },
  });
  render(<BotRoutines botId="bot" />);
  fireEvent.click(await screen.findByText('Review'));
  fireEvent.change(screen.getByLabelText('routines.instructions'), {
    target: { value: 'Review the new PR only' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'routines.runNow' }));
  await waitFor(() => expect(runNow).toHaveBeenCalledWith('bot', 'routine'));
  expect(calls).toEqual(['save', 'run']);
  expect(save).toHaveBeenCalledWith(
    'bot',
    expect.objectContaining({ prompt: 'Review the new PR only', triggers: routine.triggers }),
    'routine',
  );
});
