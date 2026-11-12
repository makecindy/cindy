// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotConnectionStatus } from '../BotConnectionStatus';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
it('only known offline shows a status dot; online and unknown stay quiet', () => {
  const view = render(<BotConnectionStatus />);
  const dot = () => view.container.firstElementChild!;
  expect(dot()).toBeNull();
  view.rerender(<BotConnectionStatus online={false} />);
  expect(dot().className).toContain('--remote-status-failed');
  view.rerender(<BotConnectionStatus online={null} />);
  expect(dot()).toBeNull();
  view.rerender(<BotConnectionStatus inline />);
  expect(dot()).toBeNull();
  view.rerender(<BotConnectionStatus inline deviceName="Studio" />);
  expect(dot().textContent).toBe('Studio');
  view.rerender(<BotConnectionStatus inline online={false} deviceName="Studio" />);
  expect(dot().textContent).toBe('bots.remote.offline · Studio');
});
