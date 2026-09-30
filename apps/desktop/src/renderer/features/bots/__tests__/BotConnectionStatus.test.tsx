// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotConnectionStatus } from '../BotConnectionStatus';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('local online stays green; only known remote offline is red; unknown stays neutral', () => {
  const view = render(<BotConnectionStatus />);
  const dot = () => view.container.firstElementChild!;
  expect(dot().className).toContain('--remote-status-ready');
  expect(dot().getAttribute('title')).toBe('bots.remote.online');
  view.rerender(<BotConnectionStatus online={false} />);
  expect(dot().className).toContain('--remote-status-failed');
  view.rerender(<BotConnectionStatus online={null} />);
  expect(dot().className).toContain('--text-tertiary');
  expect(dot().getAttribute('title')).toBe('bots.remote.unknown');
});
