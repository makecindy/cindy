// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { RemoteMessage } from '../session/types';
const h = vi.hoisted(() => ({ activity: { phase: 'running', workingPhase: 'reading-memory' } as Record<string, string>, invoke: vi.fn(), listener: () => {} }));
vi.mock('react-native', () => ({ ActivityIndicator: () => null, View: 'div', StyleSheet: { create: (v: unknown) => v } }));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/theme', () => ({ spacing: {}, typeScale: {}, useTheme: () => ({ colors: {} }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1 }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke }) }));
vi.mock('../session/remoteSessionStore', () => ({ remoteSessionStore: {
  getSessionLiveActivity: () => h.activity,
  subscribe: (listener: () => void) => { h.listener = listener; return () => {}; },
} }));
import { useCompanionWorkingLabel } from '../session/CompanionWorkingStatus';
const messages: RemoteMessage[] = [];
function Probe() {
  return useCompanionWorkingLabel({ sessionId: 'chat', deviceId: 'host', botId: 'bot', active: true, messages, reconnectAttempt: null });
}
it('uses the host public phase without messages and immediately drops terminal, error or interaction status', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const node = document.createElement('div'); const root = createRoot(node);
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  try {
    await act(async () => root.render(createElement(Probe)));
    expect(node.textContent).toBe('devices.companions.working.reading-memory');
    for (const phase of ['completed', 'error', 'needs-interaction']) {
      await act(async () => { h.activity = { phase }; h.listener(); });
      expect(node.textContent).toBe('');
    }
    await act(async () => finish({ blocks: [{ id: 'working', primitive: 'status', fallbackMarkdown: 'Late caption' }] }));
    expect(node.textContent).toBe('');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); }
});


it('uses host compaction for an unopened chat, ignores old copy, and clears on resume/stop/failure', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.invoke.mockReset();
  h.activity = { phase: 'running', workingPhase: 'reading-memory' };
  let finish!: (value: unknown) => void;
  h.invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => { h.activity = { phase: 'running', workingPhase: 'compacting' }; h.listener(); });
    await act(async () => finish({ blocks: [{ id: 'working', primitive: 'status', fallbackMarkdown: 'Old copy' }] }));
    expect(node.textContent).toBe('devices.companions.working.compacting');
    expect(h.invoke).toHaveBeenCalledTimes(1);
    await act(async () => { h.activity = { phase: 'running', workingPhase: 'replying' }; h.listener(); });
    expect(node.textContent).toBe('devices.companions.working.replying');
    for (const phase of ['completed', 'error', 'needs-interaction']) {
      await act(async () => { h.activity = { phase, workingPhase: 'compacting' }; h.listener(); });
      expect(node.textContent).toBe('');
    }
    await act(async () => { h.activity = { phase: 'running', compactDetail: 'Compacting context…' }; h.listener(); });
    expect(node.textContent).toBe('devices.companions.working.compacting');
  } finally { await act(async () => root.unmount()); }
});
