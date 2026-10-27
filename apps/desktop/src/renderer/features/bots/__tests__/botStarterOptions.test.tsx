// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionQuickSendProvider } from '@/components/chat/SessionQuickSendContext';
import { BotStarterOptions } from '../BotStarterOptions';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const options = ['审计一个模块', '复查最近合并的改动'];
const view = (send: (text: string) => Promise<boolean>, locked = false) => render(
  <SessionQuickSendProvider value={{ send }}><BotStarterOptions options={options} locked={locked} /></SessionQuickSendProvider>);

it('sends a choice once through the session send path, then retires the row', async () => {
  let accept!: (value: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(resolve => { accept = resolve; }));
  view(send);
  const choice = screen.getByRole('button', { name: options[0]! });
  fireEvent.click(choice); fireEvent.click(choice);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith(options[0]);
  await act(async () => accept(true));
  expect(screen.queryByRole('group')).toBeNull();
});

it('keeps the choices when the session refuses the message', async () => {
  const send = vi.fn(async () => false);
  view(send);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: options[1]! })));
  expect(screen.getByRole('group')).toBeTruthy();
  await act(async () => fireEvent.click(screen.getByRole('button', { name: options[1]! })));
  expect(send).toHaveBeenCalledTimes(2);
});

it('is still there after a remount until the user has written in the task, and never without a send path', () => {
  const send = vi.fn(async () => true);
  const first = view(send);
  expect(screen.getAllByRole('button')).toHaveLength(2);
  first.unmount();
  const second = view(send);
  expect(screen.getAllByRole('button')).toHaveLength(2);
  second.unmount();
  view(send, true);
  expect(screen.queryByRole('group')).toBeNull();
  cleanup();
  render(<BotStarterOptions options={options} locked={false} />);
  expect(screen.queryByRole('group')).toBeNull();
});
