// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { CompanionProfileArtifacts } from '@/session/CompanionProfileArtifacts';

const state = vi.hoisted(() => ({ value: null as unknown, error: false, refresh: vi.fn() }));
vi.mock('@/session/useRemoteCompanionQuery', () => ({ useRemoteCompanionQuery: () => state }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  return { View: ({ children }: any) => createElement('div', {}, children), StyleSheet: { create: (s: unknown) => s } };
});
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/components/MobilePrimitives', () => ({ MainWindowActionButton: ({ action }: any) => createElement('button', { disabled: action.disabled, onClick: action.onPress }, action.label) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useThemedStyles: (make: any) => make(tokens.lightColors) };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const host = document.createElement('div');
let root = createRoot(host);
afterEach(() => { act(() => root.unmount()); root = createRoot(host); state.value = null; state.error = false; vi.clearAllMocks(); });
const render = (online = true) => act(async () => root.render(<CompanionProfileArtifacts deviceId="d" botId="b" sessionId="s" online={online} onOpenTask={() => {}} />));

it('never presents a blank loading, offline, empty, or failed state', async () => {
  await render(); expect(host.textContent).toContain('devices.resources.loading');
  await render(false); expect(host.textContent).toContain('devices.resources.hostOffline');
  expect(host.textContent).not.toContain('devices.resources.loading');
  state.value = { ok: true, delegations: [] };
  await render(); expect(host.textContent).toContain('devices.companionProfile.artifactsEmpty');
  state.error = true;
  await render(); expect(host.textContent).toContain('devices.companionProfile.readFailed');
  await act(async () => host.querySelector('button')!.click());
  expect(state.refresh).toHaveBeenCalledOnce();
  await render(false); expect(host.querySelector('button')!.disabled).toBe(true);
});
