// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY,
  confirmAgentSwitchRisk,
  relocationDescriptionKey,
} from '@/components/new-chat/agentSwitchConfirmation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const STORAGE_KEY = `confirm-dialog.skip:${AGENT_SWITCH_CONFIRMATION_OVERRIDE_KEY}`;
const COPY = {
  title: 'Switch Agent?',
  description: 'Switching agents has handoff costs.',
  confirmText: 'Switch Agent',
  cancelText: 'Keep Current Agent',
  dontShowAgainLabel: 'Don’t remind me again',
};

function Harness({
  hasSwitchIntent = false,
  onBrowse,
}: {
  hasSwitchIntent?: boolean;
  onBrowse: () => void;
}) {
  const { confirm } = useConfirmDialog();
  return (
    <button
      type="button"
      onClick={() => {
        void confirmAgentSwitchRisk({
          hasSwitchIntent,
          confirm,
          copy: COPY,
        }).then((proceed) => {
          if (proceed) onBrowse();
        });
      }}
    >
      Browse Target Agent
    </button>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0]) {
  return render(
    <ConfirmDialogProvider>
      <Harness {...props} />
    </ConfirmDialogProvider>,
  );
}

describe('Agent switch confirmation', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('prompts before browsing another Agent and cancel leaves the tab untouched', async () => {
    const onBrowse = vi.fn();
    renderHarness({ onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    const title = await screen.findByText(COPY.title);
    expect(title.className).toContain('select-none');
    expect(screen.getByText(COPY.description).className).toContain('select-none');

    fireEvent.click(screen.getByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.cancelText }));
    await waitFor(() => expect(screen.queryByText(COPY.title)).toBeNull());
    expect(onBrowse).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('does not prompt again when an Agent switch intent already exists', async () => {
    const onBrowse = vi.fn();
    renderHarness({ hasSwitchIntent: true, onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });

  it('persists the explicit skip override only after checked confirmation', async () => {
    const onBrowse = vi.fn();
    const first = renderHarness({ onBrowse });

    fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: COPY.dontShowAgainLabel }));
    fireEvent.click(screen.getByRole('button', { name: COPY.confirmText }));
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(1));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');

    first.unmount();
    renderHarness({ onBrowse });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Browse Target Agent' }));
    });
    await waitFor(() => expect(onBrowse).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(COPY.title)).toBeNull();
  });
});

// #7573 后同引擎换电脑会复制完整原生记录;跨引擎、分享来源仍只能走摘要,文案不能说成记录已带过去。
// ChatInput 体量过大无法在 unit 里挂载;判定与文案 key 收在此函数,这里连同真实 locale 文本一起断言。
describe('relocationDescriptionKey', () => {
  const base = {
    fromAgent: 'claude-code',
    toAgent: 'claude-code',
    fromAgentDeviceId: null,
    toAgentDeviceId: 'mini',
  };
  const locale = (name: string) =>
    JSON.parse(readFileSync(resolve(__dirname, `../i18n/locales/${name}/common.json`), 'utf8'))
      .newChat.chatInput.agentRelocation;
  const NATIVE = 'newChat.chatInput.agentRelocation.descriptionNativeHistory';
  const SUMMARY = 'newChat.chatInput.agentRelocation.description';

  it.each([
    ['same engine between own computers', {}, NATIVE],
    ['back to this computer', { fromAgentDeviceId: 'mini', toAgentDeviceId: null }, NATIVE],
    ['different engine', { toAgent: 'codex' }, SUMMARY],
    ['shared target', { toAgentDeviceId: 'share:abc' }, SUMMARY],
    ['shared source', { fromAgentDeviceId: 'share:abc' }, SUMMARY],
  ])('%s', (_name, override, expected) => {
    expect(relocationDescriptionKey({ ...base, ...override })).toBe(expected);
  });

  it('keys resolve to the native-history and summary-only copy', () => {
    expect(locale('zh-CN').descriptionNativeHistory).toContain('完整对话记录会复制过去');
    expect(locale('zh-CN').description).toContain('带不过来');
  });
});
