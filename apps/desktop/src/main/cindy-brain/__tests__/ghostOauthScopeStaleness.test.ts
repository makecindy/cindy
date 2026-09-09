import { describe, expect, it } from 'vitest';

import type { GhostManifest, GhostSetupAssessment } from '../../../shared/ghost.js';
import {
  appendReadyGhostOauthReauthSuggest,
  findGhostOauthReauthSuggest,
} from '../ghostOauthScopeStaleness.js';

const MANIFEST: GhostManifest = {
  schemaVersion: 2,
  id: 'xd-feishu',
  name: 'XD Feishu',
  version: '2.3.0',
  kind: 'chip',
  entry: 'main.js',
  network: {
    hosts: ['open.feishu.cn'],
    secrets: [
      {
        key: 'feishu_account',
        label: 'Feishu account',
        source: 'oauth',
        inject: { header: 'Authorization', format: 'Bearer {value}' },
        oauth: {
          authorizeUrl: 'https://accounts.feishu.cn/authorize',
          tokenUrl: 'https://open.feishu.cn/token',
          scopes: ['scope.old', 'scope.new'],
        },
      },
    ],
  },
};

const READY: GhostSetupAssessment = { state: 'ready', revision: 7, groups: [] };

describe('OAuth scope stale runtime assessment', () => {
  it('ready + 默认账号陈旧时附加非阻塞 reauthSuggest', () => {
    const suggest = findGhostOauthReauthSuggest(MANIFEST, () => ['scope.new']);

    expect(appendReadyGhostOauthReauthSuggest(READY, suggest)).toEqual({
      ...READY,
      reauthSuggest: {
        ghostId: 'xd-feishu',
        secretKey: 'feishu_account',
        missingScopes: ['scope.new'],
        missingScopeCount: 1,
        requirement: {
          ref: 'secret:feishu_account',
          kind: 'oauth',
          label: 'Feishu account',
          action: {
            id: 'oauth_connect:secret:feishu_account',
            kind: 'oauth_connect',
          },
        },
      },
    });
  });

  it('缺失面为空(非 stale / 老账号判不准)时不附建议', () => {
    const suggest = findGhostOauthReauthSuggest(MANIFEST, () => []);
    expect(appendReadyGhostOauthReauthSuggest(READY, suggest)).toBe(READY);
  });

  it('setup required 时不附建议，不改变既有 gate 语义', () => {
    const required: GhostSetupAssessment = {
      state: 'required',
      revision: 8,
      groups: [],
    };
    const suggest = findGhostOauthReauthSuggest(MANIFEST, () => ['scope.new']);

    expect(appendReadyGhostOauthReauthSuggest(required, suggest)).toBe(required);
  });
});
