import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

describe('inactive session list subscriptions', () => {
  it('gates both mounted list routes by navigation focus', () => {
    for (const path of ['app/devices/index.tsx', 'app/devices/[deviceId].tsx']) {
      const screen = source(path);
      expect(screen).toContain('const screenFocused = useIsFocused();');
      expect(screen).toContain(
        '<RemoteSessionStoreSubscriptionGate enabled={screenFocused}>',
      );
    }
  });

  it('pauses list and row subscriptions while their route is covered', () => {
    const store = source('src/session/remoteSessionStore.ts');
    expect(store).toContain(
      'enabled ? subscribe : INACTIVE_REMOTE_SESSION_STORE_SUBSCRIBE',
    );
    expect(store).toContain(
      "usePausableRemoteSessionStoreSnapshot('sessions', remoteSessionStore.getSessions)",
    );
    const previewHook = store.slice(
      store.indexOf('export function useRemoteSessionMessagePreview'),
      store.indexOf('// 本地「最近消息」缓存持久化'),
    );
    expect(previewHook).toContain('usePausableRemoteSessionStoreSnapshot(');
    expect(previewHook).toContain('remoteSessionStore.subscribeSessionMessagePreview(sessionId, cb)');
    const messageVersionHook = store.slice(
      store.indexOf('export function useRemoteMessageVersion'),
      store.indexOf('/** Home-list invalidation'),
    );
    expect(messageVersionHook).toContain('usePausableRemoteSessionStoreSnapshot(');
    expect(messageVersionHook).toContain('remoteSessionStore.getMessageVersion()');
    const storeVersionHook = store.slice(
      store.indexOf('export function useRemoteSessionStoreVersion'),
      store.indexOf('export function useRemoteNewMakerWorktreePreference'),
    );
    expect(storeVersionHook).toContain('usePausableRemoteSessionStoreSnapshot(');
    expect(storeVersionHook).toContain('remoteSessionStore.getStoreVersion');
    const runningHook = store.slice(
      store.indexOf('export function useSessionRunning'),
      store.indexOf('export function useSessionRunStatus'),
    );
    expect(runningHook).toContain('usePausableRemoteSessionStoreSnapshot(');
    expect(runningHook).toContain('() => remoteSessionStore.isSessionRunning(sessionId)');
    expect(runningHook).toContain('remoteSessionStore.subscribeHomeStatus');
  });
});
