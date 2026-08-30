import { describe, expect, it } from 'vitest';

import { validateGhostManifest, type GhostManifest } from '../../../shared/ghost.js';
import { ghostBrokerRedirectPortInstallError } from '../ghostBrokerRedirectPort.js';

function brokerManifest(redirectPort?: number): GhostManifest {
  const parsed = validateGhostManifest({
    schemaVersion: 2,
    id: 'broker-plugin',
    name: 'Broker plugin',
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    slots: ['network'],
    settingsHtml: 'settings.html',
    network: {
      hosts: ['accounts.example.com'],
      secrets: [
        {
          key: 'account',
          label: 'Account',
          source: 'oauth',
          inject: { header: 'Authorization', format: 'Bearer {value}' },
          oauth: {
            authorizeUrl: 'https://accounts.example.com/authorize',
            tokenUrl: 'https://accounts.example.com/token',
            clientId: 'builtin-client-id',
            tokenBroker: 'jira',
            ...(redirectPort === undefined ? {} : { redirectPort }),
          },
        },
      ],
    },
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.manifest;
}

describe('ghostBrokerRedirectPortInstallError', () => {
  it('classifies a new broker package without redirectPort on its own actionable IPC code', () => {
    expect(ghostBrokerRedirectPortInstallError(brokerManifest())).toEqual({
      code: 'GHOST_BROKER_REDIRECT_PORT_REQUIRED',
      reason: expect.stringContaining('同一项 oauth 中声明 redirectPort'),
    });
  });

  it('does not require one global port value or widen the rule to non-broker OAuth', () => {
    // 任意合法声明值都通过，排除“偷偷钉死某个 provider 端口”的错实现。
    expect(ghostBrokerRedirectPortInstallError(brokerManifest(17872))).toBeNull();

    const plain = brokerManifest(17872);
    const oauth = plain.network?.secrets?.[0]?.oauth;
    if (!oauth) throw new Error('expected OAuth fixture');
    delete oauth.tokenBroker;
    delete oauth.redirectPort;
    // 普通 OAuth 可用随机 loopback 端口，排除“所有 OAuth 都必须声明”的错实现。
    expect(ghostBrokerRedirectPortInstallError(plain)).toBeNull();
  });
});
