import { describe, expect, it, vi } from 'vitest';

import type { GhostManifest } from '../../../shared/ghost';
import {
  createForgeOidcInstallMainWindowSender,
  ForgeOidcInstallConfirmBridge,
  forgeOidcInstallConfirmFacts,
  forgeInstallOriginForMembership,
  type ForgeOidcInstallConfirmPush,
} from '../forgeOidcInstallConfirmBridge';

function manifest(secrets: NonNullable<GhostManifest['network']>['secrets']): GhostManifest {
  return {
    schemaVersion: 2,
    id: 'acme-tool',
    name: 'Acme Tool',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['network'],
    network: { hosts: ['api.acme.test'], secrets },
  };
}

const OIDC = manifest([
  {
    key: 'identity',
    label: 'Identity',
    source: 'oidc-token',
    inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.acme.test'] },
  },
]);

const CONFIRM_PUSH: ForgeOidcInstallConfirmPush = {
  requestId: 'request-1',
  ghostId: 'acme-tool',
  ghostName: 'Acme Tool',
  hosts: ['api.acme.test'],
};

describe('createForgeOidcInstallMainWindowSender', () => {
  it('辅助 sidebar 聚焦时仍只把确认投给主 App 窗口', () => {
    const mainWindow = { kind: 'main' };
    const focusedSidebar = { kind: 'sidebar' };
    const send = vi.fn();
    const sender = createForgeOidcInstallMainWindowSender({
      getMainWindow: () => mainWindow,
      isTrustedMainWindow: () => true,
      send,
    });

    expect(sender(CONFIRM_PUSH)).toBe(true);
    expect(send).toHaveBeenCalledWith(mainWindow, CONFIRM_PUSH);
    expect(send).not.toHaveBeenCalledWith(focusedSidebar, CONFIRM_PUSH);
  });

  it('只有受信辅助窗口、没有主 App 窗口时失败关闭', () => {
    const trustedAuxiliaryWindow = { kind: 'resource-usage' };
    const isTrustedMainWindow = vi.fn((window: typeof trustedAuxiliaryWindow) =>
      Boolean(window),
    );
    const send = vi.fn();
    const sender = createForgeOidcInstallMainWindowSender<typeof trustedAuxiliaryWindow>({
      getMainWindow: () => null,
      isTrustedMainWindow,
      send,
    });

    expect(sender(CONFIRM_PUSH)).toBe(false);
    expect(isTrustedMainWindow).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('forgeInstallOriginForMembership', () => {
  it('只给本次企业身份的 Forge 安装写作者自测来源', () => {
    expect(forgeInstallOriginForMembership('org')).toBe('agent-forge');
    expect(forgeInstallOriginForMembership('personal')).toBeUndefined();
  });
});

describe('forgeOidcInstallConfirmFacts', () => {
  it('requires confirmation only for organization installs that declare oidc-token', () => {
    expect(forgeOidcInstallConfirmFacts(OIDC, 'org')).toEqual({
      ghostId: 'acme-tool',
      ghostName: 'Acme Tool',
      hosts: ['api.acme.test'],
    });
    expect(forgeOidcInstallConfirmFacts(OIDC, 'personal')).toBeNull();
    expect(
      forgeOidcInstallConfirmFacts(
        manifest([
          {
            key: 'oauth',
            label: 'OAuth',
            source: 'oauth',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
            oauth: {
              authorizeUrl: 'https://accounts.acme.test/authorize',
              tokenUrl: 'https://accounts.acme.test/token',
              clientId: 'client',
              redirectPort: 53684,
              tokenBroker: 'jira',
            },
          },
        ]),
        'org',
      ),
    ).toBeNull();
  });
});

describe('ForgeOidcInstallConfirmBridge', () => {
  it('round-trips one answer and fails closed on duplicate or malformed replies', async () => {
    const sent: ForgeOidcInstallConfirmPush[] = [];
    const bridge = new ForgeOidcInstallConfirmBridge({
      sendToWindow: (payload) => {
        sent.push(payload);
        return true;
      },
      timeoutMs: 1_000,
    });
    const pending = bridge.request({
      ghostId: 'acme-tool',
      ghostName: 'Acme Tool',
      hosts: ['api.acme.test'],
    });
    expect(sent).toHaveLength(1);
    expect(bridge.resolve(sent[0].requestId, 'true')).toBe(true);
    expect(await pending).toBe(false);
    expect(bridge.resolve(sent[0].requestId, true)).toBe(false);
  });

  it('cancelAll releases every pending install as declined', async () => {
    const bridge = new ForgeOidcInstallConfirmBridge({
      sendToWindow: () => true,
      timeoutMs: 60_000,
    });
    const pending = bridge.request({
      ghostId: 'acme-tool',
      ghostName: 'Acme Tool',
      hosts: ['api.acme.test'],
    });
    bridge.cancelAll();
    await expect(pending).resolves.toBe(false);
    expect(bridge.pendingCount).toBe(0);
  });
});
