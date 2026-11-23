// @vitest-environment jsdom
// Unit: live title-route warnings must show the actual backup outcome, offer settings,
// and ignore another owner's delayed push. A model-health store test cannot exercise the UI.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import zh from '@/i18n/locales/zh-CN/common.json';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { AuxiliaryModelHealthBanner } from '../AuxiliaryModelHealthBanner';
import type { AuxiliaryModelHealthEvent } from '../../../../shared/auxiliaryModelHealth';

const notifications = vi.hoisted(() => ({
  warning: vi.fn(() => 'test-toast'), dismiss: vi.fn(), success: vi.fn(() => 'recovery-toast'),
}));
vi.mock('@/lib/toast', () => ({ toast: notifications }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ dataOwnerId: 'a', dataOwnerGeneration: 1 }),
}));

it('shows the localized cause and actual counts, excludes other owners, and links to settings', async () => {
  const i18n = i18next.createInstance();
  await i18n.init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zh } } });
  setDataOwnerGeneration('a', 1);
  let push!: (event: AuxiliaryModelHealthEvent) => void;
  const event: AuxiliaryModelHealthEvent = {
    providerId: 'provider', model: 'Example', sessionId: 'chat', status: 'isolated', operation: 'auto-title', noticeId: 1,
    reason: 'permission_denied', httpStatus: 403, attemptCount: 1, failureCount: 1, failureRate: 1,
    switchedToBackup: false, lastErrorAt: 1, ownerStamp: { dataOwnerId: 'a', ownerGeneration: 1 },
  };
  let snapshot = [{ ...event, upstreamMessage: 'Denied today.' }];
  const dismiss = vi.fn(async () => {});
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
    auxiliaryModelHealthDismiss: dismiss,
    auxiliaryModelHealthGet: async (sessionId: string) => sessionId === 'chat' ? snapshot : [],
    onAuxiliaryModelHealthChanged: (fn: typeof push) => { push = fn; return () => {}; },
  } } });
  render(<I18nextProvider i18n={i18n}><MemoryRouter><Routes>
    <Route path="/" element={<AuxiliaryModelHealthBanner sessionId="chat" />} />
    <Route path="/settings" element={<h1>设置</h1>} />
  </Routes></MemoryRouter></I18nextProvider>);
  const banner = await screen.findByRole('status');
  const copy = zh.settings.auxiliaryModels.notice;
  expect(banner.textContent).toContain('未能自动生成对话标题');
  expect(banner.textContent).toContain(copy.unavailableBody);
  const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  await act(async () => push({ ...event, notify: true }));
  expect(notifications.warning).toHaveBeenCalledWith('未能自动生成对话标题');
  const details = screen.getByRole('button', { name: '详情' });
  const diagnostics = document.getElementById(details.getAttribute('aria-controls')!)!;
  expect(diagnostics.hidden).toBe(true);
  expect(banner.textContent).not.toContain('HTTP');
  fireEvent.click(details);
  expect(details.getAttribute('aria-expanded')).toBe('true');
  expect(diagnostics.hidden).toBe(false);
  expect(diagnostics.textContent).toContain('HTTP 403 · 访问被拒绝');
  expect(diagnostics.textContent).toContain('Denied today.');
  expect(diagnostics.textContent).toContain('最近 1 次请求中有 1 次失败');

  act(() => push({ ...event, model: 'PRIVATE', ownerStamp: { dataOwnerId: 'b', ownerGeneration: 2 } }));
  expect(diagnostics.textContent).not.toContain('PRIVATE');
  snapshot = [{ ...event, switchedToBackup: true, upstreamMessage: 'Denied today.' }];
  await act(async () => push(snapshot[0]));
  expect(screen.queryByRole('status')).toBeNull();
  snapshot = [{ ...event, status: 'warning', operation: 'prompt-prediction', upstreamMessage: 'Denied today.' }];
  await act(async () => push(snapshot[0]));
  expect(screen.getByRole('status').textContent).toContain('未能生成输入建议');
  expect(notifications.dismiss).toHaveBeenCalledWith('test-toast');
  await act(async () => push({ ...event, status: 'warning', notify: true }));
  expect(notifications.warning).toHaveBeenCalledTimes(1);
  focused.mockRestore();
  fireEvent.click(screen.getByRole('button', { name: '详情' }));
  const longMessage = '<em>Access denied</em>\n' + 'x'.repeat(700);
  snapshot = [...snapshot, { ...snapshot[0], model: 'Other', lastErrorAt: 2, upstreamMessage: longMessage }];
  await act(async () => push(snapshot[1]));
  expect(screen.getByRole('status').textContent).toContain('未能生成输入建议');
  const currentDetails = screen.getByText('Other').closest('[id]')!;
  expect(currentDetails.textContent).toContain('Other');
  expect(currentDetails.textContent).toContain('Example');
  expect(currentDetails.textContent).toContain(longMessage);
  expect(currentDetails.querySelector('em')).toBeNull();
  snapshot = [];
  act(() => push({ ...event, removed: true, conversationOnly: true }));
  await act(async () => push({ ...event, notify: true }));
  expect(screen.queryByRole('status')).toBeNull();
  snapshot = [{ ...event, upstreamMessage: 'Denied today.' }];
  await act(async () => push(event));
  snapshot = [{ ...event, status: 'recovered', upstreamMessage: 'Denied today.' }];
  await act(async () => push(snapshot[0]));
  expect(screen.getByRole('status').textContent).toContain(copy.recovered);
  expect(screen.queryByRole('button', { name: '详情' })).toBeNull();
  snapshot = [{ ...event, upstreamMessage: 'Denied today.' }];
  await act(async () => push(event));
  fireEvent.click(screen.getByRole('button', { name: '关闭提示' }));
  expect(dismiss).toHaveBeenCalledWith('chat', 1);
  expect(screen.queryByRole('status')).toBeNull();
  snapshot = [{ ...event, noticeId: 2, upstreamMessage: 'Denied again.' }];
  await act(async () => push(snapshot[0]));
  fireEvent.click(screen.getByRole('button', { name: copy.settings }));
  expect(await screen.findByRole('heading', { name: '设置' })).toBeTruthy();
});
