// @vitest-environment jsdom
/**
 * Unit, provider-groups.md §6.2：原有 mock 只验证发送入口，无法验证真实单选控件与确认框接线。
 * 最小输入为同一提议下选择仅本次/自动/关闭/暂不切换；经真实 Provider 验证最终写入的协议与发送结果。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { i18n } from '@/i18n';
import { ConfirmDialogProvider, useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { offerSessionRebalance, prefetchSessionRebalance } from '../sessionRebalancePrompt';

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

afterEach(() => {
  cleanup();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

it.each(['once', 'auto', 'off', 'cancel'] as const)('sends with the selected task preference: %s', async (choice) => {
  const sessionId = `radio-${choice}`;
  const command = vi.fn(async (request: { action: string }) => request.action === 'rebalance-suggestion'
    ? { kind: 'ask', memberKey: 'device:mini:anthropic', label: 'Mini', quota: { usedPercent: 20, resetAtMs: Date.now() + 86_400_000, windowMs: 604_800_000 } }
    : { ok: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { providerGroup: { command } } });
  await prefetchSessionRebalance(sessionId);
  const sent = vi.fn();
  function Consumer() {
    const { confirm } = useConfirmDialog();
    return <button onClick={async () => {
      const record = await offerSessionRebalance({ sessionId, confirm, t: i18n.t.bind(i18n) });
      await record?.('message-a');
      sent();
    }}>Send</button>;
  }
  render(<ConfirmDialogProvider><Consumer /></ConfirmDialogProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(screen.getAllByRole('radio')).toHaveLength(3);
  expect((screen.getByRole('radio', { name: i18n.t('providerGroup.rebalance.confirm') }) as HTMLInputElement).checked).toBe(true);
  if (choice !== 'cancel') {
    const key = choice === 'auto' ? 'remember' : choice === 'off' ? 'disable' : 'confirm';
    fireEvent.click(screen.getByRole('radio', { name: i18n.t(`providerGroup.rebalance.${key}`) }));
  }
  fireEvent.click(screen.getByRole('button', { name: i18n.t(`providerGroup.rebalance.${choice === 'cancel' ? 'cancel' : 'send'}`) }));
  await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));
  const writes = command.mock.calls.map(([request]) => request).filter((request) => request.action !== 'rebalance-suggestion');
  expect(writes).toEqual(choice === 'cancel' ? [] : choice === 'off'
    ? [{ action: 'rebalance-preference', sessionId, enabled: false }]
    : [{ action: 'rebalance-decision', sessionId, clientId: 'message-a', memberKey: 'device:mini:anthropic', remember: choice === 'auto' }]);
});
