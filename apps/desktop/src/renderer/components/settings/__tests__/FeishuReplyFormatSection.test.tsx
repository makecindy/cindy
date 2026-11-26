// @vitest-environment jsdom
/**
 * 个人飞书机器人设置页「回复格式」开关。
 *
 * 依据: 回答形态存在渠道设置(channels.feishu.replyFormat), 传输层每轮现读;
 * 设置页只负责读写它。缺省必须是卡片(存量行为不变), 切到纯文本后写设置并显示
 * 新值, 切回卡片同样立刻写回; 保存失败回滚到原值并提示。
 *
 * 生产入口: FeishuReplyFormatSection 经 preload 的 imDefaultSettingsGet / Set 读写。
 * 缺口: 主进程侧的即时生效(下一轮走纯文本)由 @cindy/im 的 textReply 用例覆盖,
 * 这里只验证界面契约。
 * 最小失败输入: 设置值为 text 时点了「卡片」却没有写设置, 或保存失败后仍显示 text。
 * tier: unit(jsdom; 设置读写用替身)。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  get: vi.fn<(channel?: string) => Promise<{ replyFormat: 'card' | 'text' }>>(),
  set: vi.fn<(patch: { replyFormat?: 'card' | 'text' }, channel?: string) => Promise<{ replyFormat: 'card' | 'text' }>>(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => true } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: state.toastError, success: vi.fn() } }));

import { FeishuReplyFormatSection } from '../FeishuReplyFormatSection';

const CARD = 'settings.feishuBot.replyFormat.card';
const TEXT = 'settings.feishuBot.replyFormat.text';

function option(name: string): HTMLButtonElement {
  return screen.getByRole('radio', { name }) as HTMLButtonElement;
}

function checked(name: string): string | null {
  return option(name).getAttribute('aria-checked');
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        imDefaultSettingsGet: state.get,
        imDefaultSettingsSet: state.set,
      },
    },
  });
});

afterEach(cleanup);

it('shows the card format by default without writing settings', async () => {
  state.get.mockResolvedValue({ replyFormat: 'card' });
  render(<FeishuReplyFormatSection />);

  await waitFor(() => expect(option(CARD).disabled).toBe(false));
  expect(checked(CARD)).toBe('true');
  expect(checked(TEXT)).toBe('false');
  expect(state.get).toHaveBeenCalledWith('feishu');
  expect(state.set).not.toHaveBeenCalled();
});

it('switches to plain text and back to cards, each write taking effect immediately', async () => {
  state.get.mockResolvedValue({ replyFormat: 'card' });
  state.set.mockImplementation(async (patch) => ({ replyFormat: patch.replyFormat ?? 'card' }));
  render(<FeishuReplyFormatSection />);

  await waitFor(() => expect(option(TEXT).disabled).toBe(false));
  fireEvent.click(option(TEXT));
  await waitFor(() => expect(state.set).toHaveBeenCalledWith({ replyFormat: 'text' }, 'feishu'));
  await waitFor(() => expect(checked(TEXT)).toBe('true'));

  fireEvent.click(option(CARD));
  await waitFor(() => expect(state.set).toHaveBeenLastCalledWith({ replyFormat: 'card' }, 'feishu'));
  await waitFor(() => expect(checked(CARD)).toBe('true'));
});

it('reverts and reports when the write fails', async () => {
  state.get.mockResolvedValue({ replyFormat: 'card' });
  state.set.mockRejectedValue(new Error('save failed'));
  render(<FeishuReplyFormatSection />);

  await waitFor(() => expect(option(TEXT).disabled).toBe(false));
  fireEvent.click(option(TEXT));
  await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('save failed'));
  await waitFor(() => expect(checked(CARD)).toBe('true'));
  expect(checked(TEXT)).toBe('false');
});

it('stays disabled until the stored value is known', async () => {
  state.get.mockReturnValue(new Promise(() => undefined));
  render(<FeishuReplyFormatSection />);

  expect(option(CARD).disabled).toBe(true);
  expect(option(TEXT).disabled).toBe(true);
  fireEvent.click(option(TEXT));
  expect(state.set).not.toHaveBeenCalled();
});
