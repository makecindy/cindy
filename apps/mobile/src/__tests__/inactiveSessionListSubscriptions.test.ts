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
      'enabled ? remoteSessionStore.subscribe : INACTIVE_REMOTE_SESSION_STORE_SUBSCRIBE',
    );
    expect(store).toContain(
      "usePausableRemoteSessionStoreSnapshot('sessions', remoteSessionStore.getSessions)",
    );
    expect(store).toContain("'message-version',\n    remoteSessionStore.getMessageVersion");
    expect(store).toContain("'store-version',\n    remoteSessionStore.getStoreVersion");
    expect(store).toContain(
      '() => remoteSessionStore.isSessionRunning(sessionId)',
    );
  });
});
