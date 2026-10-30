// @vitest-environment jsdom
import { act, createElement, StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ request: vi.fn(), owner: 1, sessionId: 's', locale: 'zh-CN' }));
vi.mock('@/lib/makerTransport', () => ({ translateThinkingFor: h.request }));
vi.mock('@/components/chat/ChatSessionFileContext', () => ({
  useChatSessionFile: () => ({ sessionId: h.sessionId }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'o', generation: h.owner }),
  isDataOwnerGenerationCurrent: (owner: { generation: number }) => owner.generation === h.owner,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: h.locale } }),
}));
import { ThinkingCard } from '@/components/chat/ThinkingCard';
import { __test_internals as expansion } from '@/hooks/useExpandedBlockMemory';

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  expansion.reset();
  h.owner = 1;
  h.locale = 'zh-CN';
  h.request.mockResolvedValue({ text: '检查文件。' });
});
const card = (props = {}) =>
  createElement(ThinkingCard, { content: 'Inspect files.', blockKey: 'b', ...props });
const translate = () => screen.getByRole('button', { name: 'chat.thinking.translation.translate' });
const open = async () => {
  fireEvent.click(screen.getAllByRole('button')[0]);
  await screen.findByRole('button', { name: 'chat.thinking.translation.translate' });
};

it('does not request on render or expand; manually translates and switches without another call', async () => {
  render(createElement(StrictMode, {}, card()));
  expect(h.request).not.toHaveBeenCalled();
  await open();
  expect(h.request).not.toHaveBeenCalled();
  fireEvent.click(translate());
  await waitFor(() => expect(screen.getByText('检查文件。')).toBeTruthy());
  expect(screen.getByText('chat.thinking.translation.machineTranslated')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'chat.thinking.translation.showOriginal' }));
  expect(screen.getByText('Inspect files.')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 'chat.thinking.translation.showTranslation' }),
  );
  expect(screen.getByText('检查文件。')).toBeTruthy();
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.request).toHaveBeenCalledWith({
    sessionId: 's',
    text: 'Inspect files.',
    locale: 'zh-CN',
  });
});
it('keeps the original on failure, permits retry, and ignores repeated clicks while pending', async () => {
  let finish!: (value: unknown) => void;
  h.request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(card());
  await open();
  fireEvent.click(translate());
  await waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
  const busy = screen.getByRole('button', {
    name: 'chat.thinking.translation.loading',
  }) as HTMLButtonElement;
  expect(busy.disabled).toBe(true);
  fireEvent.click(busy);
  finish({ error: 'failed' });
  await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
  expect(screen.getByText('Inspect files.')).toBeTruthy();
  fireEvent.click(translate());
  await waitFor(() => expect(screen.getByText('检查文件。')).toBeTruthy());
  expect(h.request).toHaveBeenCalledTimes(2);
});
it.each([{ isStreaming: true }, { isRedacted: true }, { content: '' }])(
  'does not offer translation for unavailable content: %j',
  (props) => {
    render(card(props));
    const header = screen.queryByRole('button');
    if (header) fireEvent.click(header);
    expect(
      screen.queryByRole('button', { name: 'chat.thinking.translation.translate' }),
    ).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
  },
);
it('drops a late translation after the source or account changes', async () => {
  let finish!: (value: unknown) => void;
  h.request.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(card());
  await open();
  fireEvent.click(translate());
  await waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
  h.owner += 1;
  view.rerender(card({ content: 'Different source.' }));
  finish({ text: '旧译文' });
  await waitFor(() => expect(screen.getByText('Different source.')).toBeTruthy());
  expect(screen.queryByText('旧译文')).toBeNull();
});

it.each([true, false])(
  'allows manual retry after a language round trip (old reply first: %s)',
  async (oldReplyFirst) => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    h.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    );
    const view = render(card());
    await open();
    fireEvent.click(translate());
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(1));
    h.locale = 'en';
    view.rerender(card());
    if (oldReplyFirst) await act(async () => finishOld({ text: '失效译文' }));
    h.locale = 'zh-CN';
    view.rerender(card());
    expect((translate() as HTMLButtonElement).disabled).toBe(false);
    expect(h.request).toHaveBeenCalledTimes(1);
    h.request.mockReturnValueOnce(
      new Promise((resolve) => {
        finishNew = resolve;
      }),
    );
    fireEvent.click(translate());
    await waitFor(() => expect(h.request).toHaveBeenCalledTimes(2));
    if (!oldReplyFirst) await act(async () => finishOld({ text: '失效译文' }));
    expect(screen.queryByText('失效译文')).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'chat.thinking.translation.loading',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => finishNew({ text: '新译文' }));
    expect(screen.getByText('新译文')).toBeTruthy();
    expect(h.request).toHaveBeenCalledTimes(2);
  },
);
