// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { RemoteMessage } from '../session/types';
const h = vi.hoisted(() => ({ activity: { phase: 'running', workingPhase: 'reading-memory' } as Record<string, string>, invoke: vi.fn(), listener: () => {},
  epoch: 1, cachedBotId: '' }));
vi.mock('react-native', () => ({ ActivityIndicator: () => null, View: 'div', StyleSheet: { create: (v: unknown) => v } }));
vi.mock('@/components/AppText', () => ({ Text: 'span' }));
vi.mock('@/theme', () => ({ spacing: {}, typeScale: {}, lineHeight: {}, useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}) }));
vi.mock('../session/WorkingStatusText', () => ({ WorkingStatusText: ({ text }: { text: string }) => text }));
vi.mock('@/device-link/remoteResourceCache', () => ({
  cachedBotIdForSession: (_user: string, collection: string, device: string, session: string) =>
    collection === 'teammates' && device === 'host' && session === 'chat' ? h.cachedBotId : '',
  cachedBotItem: (_user: string, collection: string, device: string, botId: string) =>
    collection === 'teammates' && device === 'host' && botId === h.cachedBotId
      ? { ref: { collectionId: 'teammates', kind: 'bot', id: botId }, display: { title: { fallback: 'Mimi' } }, links: [], revision: 'r' } : null,
  readRemoteResourceSnapshot: async () => undefined,
  remoteResourceCacheRevision: () => 0,
  subscribeRemoteResourceCache: () => () => {},
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) }));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ accountGeneration: 1, user: { id: 'owner' } }) }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => ({ invoke: h.invoke, connectionEpoch: h.epoch }) }));
vi.mock('../session/remoteSessionStore', () => ({ remoteSessionStore: {
  getSessionLiveActivity: () => h.activity,
  subscribe: (listener: () => void) => { h.listener = listener; return () => {}; },
} }));
import { useCompanionDisplayResource, useCompanionWorkingLabel } from '../session/CompanionWorkingStatus';
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

function EntryProbe({ botId }: { botId: string }) {
  return useCompanionWorkingLabel({ sessionId: 'chat', deviceId: 'host', botId, active: true, messages, reconnectAttempt: null });
}

it('names the teammate from the cached roster link when an ordinary task route has no resource', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.invoke.mockReset().mockResolvedValue({ blocks: [{ id: 'working', primitive: 'status', fallbackMarkdown: 'Checking what you told me' }] });
  h.activity = { phase: 'running', workingPhase: 'reading-memory' };
  h.cachedBotId = 'mimi';
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(EntryProbe, { botId: '' })));
    expect(h.invoke).toHaveBeenCalledWith('host', expect.any(String), [expect.objectContaining({
      ref: { collectionId: 'teammates', kind: 'bot', id: 'working:mimi/reading-memory' },
    })]);
    expect(node.textContent).toBe('Checking what you told me');
    // The route's resource stays authoritative whenever it is available.
    h.invoke.mockClear();
    await act(async () => root.render(createElement(EntryProbe, { botId: 'resource-bot' })));
    expect(h.invoke).toHaveBeenCalledWith('host', expect.any(String), [expect.objectContaining({
      ref: expect.objectContaining({ id: 'working:resource-bot/reading-memory' }),
    })]);
  } finally { h.cachedBotId = ''; await act(async () => root.unmount()); }
});

it('names and pictures a chat opened from a task link from its cached roster row, only for teammate chats', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.cachedBotId = 'mimi';
  const seen: unknown[] = [];
  function DisplayProbe({ resource, enabled }: { resource: any; enabled: boolean }) {
    seen.push(useCompanionDisplayResource('host', 'chat', resource, enabled));
    return null;
  }
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(DisplayProbe, { resource: null, enabled: true })));
    expect(seen.at(-1)).toMatchObject({ ref: { id: 'mimi' }, display: { title: { fallback: 'Mimi' } } });
    // The route's resource stays authoritative; an ordinary task never borrows a teammate identity.
    const routed = { ref: { collectionId: 'teammates', kind: 'bot', id: 'resource-bot' }, display: { title: { fallback: 'Sora' } }, links: [], revision: 'r' };
    await act(async () => root.render(createElement(DisplayProbe, { resource: routed, enabled: true })));
    expect(seen.at(-1)).toBe(routed);
    await act(async () => root.render(createElement(DisplayProbe, { resource: null, enabled: false })));
    expect(seen.at(-1)).toBeNull();
  } finally { h.cachedBotId = ''; await act(async () => root.unmount()); }
});

it('retries a lost caption once per reconnect and keeps a delivered caption', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  h.activity = { phase: 'running', workingPhase: 'reading-file' };
  h.epoch = 1;
  h.invoke.mockReset().mockRejectedValueOnce(new Error('link lost'))
    .mockResolvedValue({ blocks: [{ id: 'working', primitive: 'status', fallbackMarkdown: 'Opening your notes' }] });
  const node = document.createElement('div'); const root = createRoot(node);
  try {
    await act(async () => root.render(createElement(EntryProbe, { botId: 'mimi' })));
    expect(node.textContent).toBe('devices.companions.working.reading-file');
    expect(h.invoke).toHaveBeenCalledTimes(1);
    // Same turn and phase: nothing re-requests until the link comes back.
    await act(async () => root.render(createElement(EntryProbe, { botId: 'mimi' })));
    expect(h.invoke).toHaveBeenCalledTimes(1);
    h.epoch = 2;
    await act(async () => root.render(createElement(EntryProbe, { botId: 'mimi' })));
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(node.textContent).toBe('Opening your notes');
    h.epoch = 3;
    await act(async () => root.render(createElement(EntryProbe, { botId: 'mimi' })));
    expect(h.invoke).toHaveBeenCalledTimes(2);
    expect(node.textContent).toBe('Opening your notes');
  } finally { h.epoch = 1; await act(async () => root.unmount()); }
});
