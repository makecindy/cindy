// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteSession } from '@/session/types';
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';
const h = vi.hoisted(() => ({ alert: vi.fn() }));
vi.mock('react-native', () => ({ StyleSheet: { create: (v: unknown) => v }, View: 'div', Alert: { alert: h.alert } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: { percent?: number; used?: string; total?: string }) => `${key}${opts ? JSON.stringify(opts) : ''}` }) }));
vi.mock('@/components/AppText', () => ({ Text: ({ children }: any) => createElement('span', null, children) }));
vi.mock('@/theme', () => ({ useThemedStyles: (make: any) => make({}) }));
vi.mock('@/device-link/remoteStatus', () => ({ formatRemoteError: (error: Error) => error.message }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => createElement('button', { 'data-testid': action.testID, disabled: action.disabled || action.busy, onClick: action.onPress }, action.label) }));
vi.mock('@/session/CompanionSheet', () => ({ CompanionSheet: ({ visible, children }: any) => visible ? createElement('section', null, children) : null }));
vi.mock('@/session/SettingsGroupRows', () => ({ ActionInfoRow: ({ label, disabled, onPress, testID }: any) => createElement('button', { 'data-testid': testID, disabled, onClick: onPress }, label), SettingsGroup: ({ children, footer, messages }: any) => createElement('div', null, children, footer, messages?.map((x: any) => x.text)) }));
import { CompanionContextControl } from '@/session/CompanionContextControl';
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.clearAllMocks(); host = document.createElement('div'); root = createRoot(host); });
afterEach(() => act(() => root.unmount()));
const base = { id: 'companion-session', agentKind: 'pi', contextTokens: 120_000, contextWindow: 1_000_000 } as RemoteSession;
function harness() {
  const reader = { input: { compact: vi.fn().mockResolvedValue({}) }, compactSession: vi.fn().mockResolvedValue({ tokensBefore: 120_000, estimatedTokensAfter: 30_000 }), getContextUsage: vi.fn() } as any;
  const refresh = vi.fn();
  const render = async (patch: { session?: Partial<RemoteSession>; capabilities?: MobileAgentCapabilities | null; running?: boolean; available?: boolean } = {}) => {
    await act(async () => root.render(createElement(CompanionContextControl, { session: { ...base, ...patch.session }, capabilities: { manualCompactSupported: true } as MobileAgentCapabilities, available: true, running: false, reader, onRefresh: refresh, ...patch, ...(patch.session ? { session: { ...base, ...patch.session } } : {}) })));
  };
  const click = async (id: string) => { await act(async () => (host.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement).click()); };
  const accept = async () => { await act(async () => h.alert.mock.calls.at(-1)![2][1].onPress()); };
  return { reader, refresh, render, click, accept };
}
// #8215: real component entry, snapshot/confirmation/routing outcomes. Older menu tests
// only inspect ordinary tasks via getContextUsage, which can bootstrap an engine.
it('opens the companion snapshot without requesting context or compacting', async () => {
  const x = harness(); await x.render(); await x.click('companion.context.open');
  expect(host.textContent).toContain('12'); expect(host.textContent).toContain('120.0k');
  expect(x.reader.getContextUsage).not.toHaveBeenCalled(); expect(x.reader.compactSession).not.toHaveBeenCalled();
});
it.each([{ contextTokens: undefined }, { contextTokens: 0 }, { contextWindow: 0 }, { contextWindow: NaN }])('keeps missing/unknown snapshot unavailable: %o', async session => {
  const x = harness(); await x.render({ session }); await x.click('companion.context.open');
  expect(host.textContent).toContain('session.contextControl.unknownHint');
  expect((host.querySelector('[data-testid="companion.context.compact"]') as HTMLButtonElement).disabled).toBe(true);
  expect(x.reader.getContextUsage).not.toHaveBeenCalled();
});
it.each(['cc', 'pi'] as const)('only submits %s after confirmation and refreshes the host snapshot', async agentKind => {
  const x = harness(); await x.render({ session: { agentKind } }); await x.click('companion.context.open'); await x.click('companion.context.compact');
  expect(x.reader.compactSession).not.toHaveBeenCalled(); expect(x.reader.input.compact).not.toHaveBeenCalled();
  await x.accept();
  expect(agentKind === 'cc' ? x.reader.input.compact : x.reader.compactSession).toHaveBeenCalledExactlyOnceWith(base.id);
  expect(agentKind === 'cc' ? x.reader.compactSession : x.reader.input.compact).not.toHaveBeenCalled();
  expect(x.refresh).toHaveBeenCalledOnce();
  expect(host.textContent).toContain(agentKind === 'cc' ? 'session.contextControl.requested' : 'session.contextControl.success');
});
it.each([{ session: { agentKind: 'codex' } }, { capabilities: null }, { session: { remoteHostId: 'ssh' } }])('does not offer unsupported compaction: %o', async patch => {
  const x = harness(); await x.render(patch as any); await x.click('companion.context.open');
  expect(host.querySelector('[data-testid="companion.context.compact"]')).toBeNull();
});
it('rechecks host availability after confirmation opens', async () => {
  const x = harness(); await x.render(); await x.click('companion.context.open'); await x.click('companion.context.compact');
  await x.render({ running: true }); await x.accept(); expect(x.reader.compactSession).not.toHaveBeenCalled();
});
it('shows a rejected request and leaves the previous snapshot intact', async () => {
  const x = harness(); x.reader.compactSession.mockRejectedValue(new Error('host rejected'));
  await x.render(); await x.click('companion.context.open'); await x.click('companion.context.compact'); await x.accept();
  expect(host.textContent).toContain('host rejected'); expect(host.textContent).toContain('120.0k'); expect(x.refresh).not.toHaveBeenCalled();
});
it.each([[{ noop: true }, 'nothing'], [null, 'requested']] as const)('does not label %o as completed compaction', async (result, status) => {
  const x = harness(); x.reader.compactSession.mockResolvedValue(result);
  await x.render(); await x.click('companion.context.open'); await x.click('companion.context.compact'); await x.accept();
  expect(host.textContent).toContain(`session.contextControl.${status}`);
  expect(host.textContent).not.toContain('session.contextControl.success');
});
it('keeps one request in flight and displays compaction until it settles', async () => {
  const x = harness(); let finish!: (result: unknown) => void;
  x.reader.compactSession.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await x.render(); await x.click('companion.context.open'); await x.click('companion.context.compact');
  await act(async () => { h.alert.mock.calls.at(-1)![2][1].onPress(); h.alert.mock.calls.at(-1)![2][1].onPress(); });
  expect(x.reader.compactSession).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('session.contextControl.compacting');
  expect(x.refresh).not.toHaveBeenCalled();
  await act(async () => finish({ estimatedTokensAfter: 30_000 }));
  expect(host.textContent).toContain('session.contextControl.success'); expect(x.refresh).toHaveBeenCalledOnce();
});
