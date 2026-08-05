/**
 * evaluateGhostSetup 判定纯函数 + ghosts:setup-status handler 主体测试
 * (使用前置检查,2026-07-21):启发式回落、setup 声明逐组判定、空 requires
 * opt-out、oauth 过期 reauth 分支、kv 存在性口径、IPC 参数与错误路径。
 */

import { describe, expect, it, vi } from 'vitest';

import { validateGhostManifest, type GhostManifest } from '../../../shared/ghost';
import {
  evaluateGhostSetup,
  evaluateGhostSetupAssessment,
  GhostSetupAssessmentError,
  handleGhostSetupStatusRequest,
  type GhostSetupProbes,
} from '../ghostSetupStatus';

/** 全部探针缺省「什么都没配」,单测按需覆写。 */
function probes(overrides: Partial<GhostSetupProbes> = {}): GhostSetupProbes {
  return {
    secretSaved: () => false,
    oauthStatus: () => ({ clientConfigured: false, connected: 0, expired: 0 }),
    connectionCount: () => 0,
    kvValue: () => undefined,
    ...overrides,
  };
}

/** 经真实校验器生成清单(避免手捏结构与归一化产物漂移)。 */
function manifest(raw: Record<string, unknown>): GhostManifest {
  const result = validateGhostManifest({
    schemaVersion: 2,
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    entry: 'main.js',
    ...raw,
  });
  if (!result.ok) throw new Error(`fixture 清单不合法: ${result.reason}`);
  return result.manifest;
}

const INJECT = { header: 'Authorization', format: 'Bearer {value}' };

describe('evaluateGhostSetup · 启发式回落(无 setup 声明)', () => {
  it('零凭证零连接的意识恒就绪', () => {
    const m = manifest({ slots: ['tool'], tools: [{ name: 'draw', description: '画' }] });
    expect(evaluateGhostSetup(m, probes())).toEqual({ ready: true, missingGroups: [], reauth: [] });
  });

  it('仅 login-email 凭证的意识恒就绪(登录派生不构成配置需求)', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'deploy', description: '部署' }],
      network: {
        hosts: ['workers.example.com'],
        secrets: [
          { key: 'pages_token', label: 'Pages Token', source: 'login-email', inject: INJECT },
        ],
      },
    });
    expect(evaluateGhostSetup(m, probes()).ready).toBe(true);
  });

  it('双 key 任一已保存即就绪(Web Search 形态)', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'search', description: '搜' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.search.example'],
        secrets: [
          { key: 'brave_api_key', label: 'Brave API Key', inject: INJECT },
          { key: 'tavily_api_key', label: 'Tavily API Key', inject: INJECT },
        ],
      },
    });
    expect(evaluateGhostSetup(m, probes()).ready).toBe(false);
    expect(
      evaluateGhostSetup(m, probes({ secretSaved: (key) => key === 'tavily_api_key' })).ready,
    ).toBe(true);
  });

  it('全未配置时缺失项合成一个 anyOf 组并带展示 label', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'search', description: '搜' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.search.example'],
        secrets: [
          { key: 'brave_api_key', label: 'Brave API Key', inject: INJECT },
          { key: 'tavily_api_key', label: 'Tavily API Key', inject: INJECT },
        ],
      },
    });
    const status = evaluateGhostSetup(m, probes());
    expect(status.ready).toBe(false);
    expect(status.missingGroups).toEqual([
      [
        { ref: 'secret:brave_api_key', label: 'Brave API Key', kind: 'key' },
        { ref: 'secret:tavily_api_key', label: 'Tavily API Key', kind: 'key' },
      ],
    ]);
    expect(status.reauth).toEqual([]);
  });

  it('Node 持久凭证绑定:保险库未保存时拦截,保存后就绪', () => {
    const m = manifest({
      slots: ['tool', 'node'],
      tools: [{ name: 'mail', description: '收发邮件' }],
      settingsHtml: 'settings.html',
      node: {
        entry: 'worker.cjs',
        protocol: 'json-rpc-stdio',
        secretBindings: [
          {
            key: 'mail_authorization_code',
            label: '邮箱授权码',
            methods: ['mail/action'],
            hint: '请填写邮箱服务生成的授权码',
            url: 'https://mail.example/settings',
          },
        ],
      },
    });
    expect(evaluateGhostSetup(m, probes()).missingGroups).toEqual([
      [{ ref: 'secret:mail_authorization_code', label: '邮箱授权码', kind: 'key' }],
    ]);
    expect(
      evaluateGhostSetup(
        m,
        probes({ secretSaved: (key) => key === 'mail_authorization_code' }),
      ),
    ).toEqual({ ready: true, missingGroups: [], reauth: [] });
    expect(
      evaluateGhostSetupAssessment(m, probes(), { revision: 1 }).groups[0]?.items[0],
    ).toMatchObject({
      ref: 'secret:mail_authorization_code',
      kind: 'secret',
      description: '请填写邮箱服务生成的授权码',
      actions: [
        {
          kind: 'inline_form',
          form: {
            fields: [
              {
                id: 'value',
                type: 'secret',
                externalLink: { url: 'https://mail.example/settings' },
              },
            ],
          },
        },
      ],
    });
  });

  it('连接声明:零连接未就绪,≥1 条就绪(GitLab 形态)', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'mr', description: '查 MR' }],
      settingsHtml: 'settings.html',
      network: {
        connections: [
          {
            key: 'gitlab_conn',
            label: 'GitLab 实例',
            inject: { header: 'PRIVATE-TOKEN', format: '{value}' },
          },
        ],
      },
    });
    expect(evaluateGhostSetup(m, probes()).ready).toBe(false);
    expect(evaluateGhostSetup(m, probes({ connectionCount: () => 2 })).ready).toBe(true);
  });
});

describe('evaluateGhostSetup · oauth 凭证(Google 形态)', () => {
  const oauthManifest = manifest({
    slots: ['tool', 'network'],
    tools: [{ name: 'gmail', description: '读邮件' }],
    settingsHtml: 'settings.html',
    network: {
      hosts: ['accounts.google.example', 'api.google.example'],
      secrets: [
        {
          key: 'google_account',
          label: 'Google 账号',
          source: 'oauth',
          inject: INJECT,
          oauth: {
            authorizeUrl: 'https://accounts.google.example/auth',
            tokenUrl: 'https://accounts.google.example/token',
          },
        },
      ],
    },
  });

  it('client 未配置 → missing(kind: oauth)', () => {
    const status = evaluateGhostSetup(oauthManifest, probes());
    expect(status.ready).toBe(false);
    expect(status.missingGroups).toEqual([
      [{ ref: 'secret:google_account', label: 'Google 账号', kind: 'oauth' }],
    ]);
    expect(status.reauth).toEqual([]);
  });

  it('client 就绪但无账号 → missing', () => {
    const status = evaluateGhostSetup(
      oauthManifest,
      probes({ oauthStatus: () => ({ clientConfigured: true, connected: 0, expired: 0 }) }),
    );
    expect(status.ready).toBe(false);
    expect(status.missingGroups).toHaveLength(1);
    expect(status.reauth).toEqual([]);
  });

  it('账号全部过期 → reauth 单列,不进 missing', () => {
    const status = evaluateGhostSetup(
      oauthManifest,
      probes({ oauthStatus: () => ({ clientConfigured: true, connected: 0, expired: 2 }) }),
    );
    expect(status.ready).toBe(false);
    expect(status.missingGroups).toEqual([]);
    expect(status.reauth).toEqual([
      { ref: 'secret:google_account', label: 'Google 账号', kind: 'oauth' },
    ]);
  });

  it('≥1 个 connected 账号即就绪(其余过期不拦)', () => {
    const status = evaluateGhostSetup(
      oauthManifest,
      probes({ oauthStatus: () => ({ clientConfigured: true, connected: 1, expired: 3 }) }),
    );
    expect(status).toEqual({ ready: true, missingGroups: [], reauth: [] });
  });
});

describe('evaluateGhostSetup · setup 显式声明', () => {
  const declared = manifest({
    slots: ['tool', 'network'],
    tools: [{ name: 'work', description: '干活' }],
    settingsHtml: 'settings.html',
    network: {
      hosts: ['api.example.com'],
      secrets: [
        { key: 'key_a', label: 'Key A', inject: INJECT },
        { key: 'key_b', label: 'Key B', inject: INJECT },
      ],
    },
    setup: {
      requires: [
        { anyOf: ['secret:key_a'] },
        { anyOf: ['secret:key_b', { kv: 'workspace', label: '工作区' }] },
      ],
    },
  });

  it('组间 allOf:只满足一组仍未就绪,缺失只报未满足的组', () => {
    const status = evaluateGhostSetup(declared, probes({ secretSaved: (key) => key === 'key_a' }));
    expect(status.ready).toBe(false);
    expect(status.missingGroups).toEqual([
      [
        { ref: 'secret:key_b', label: 'Key B', kind: 'key' },
        { ref: 'kv:workspace', label: '工作区', kind: 'kv' },
      ],
    ]);
  });

  it('第二组由 kv 参数满足 → 全就绪(组内 anyOf)', () => {
    const status = evaluateGhostSetup(
      declared,
      probes({
        secretSaved: (key) => key === 'key_a',
        kvValue: (key) => (key === 'workspace' ? 'team-x' : undefined),
      }),
    );
    expect(status.ready).toBe(true);
  });

  it('kv 存在性口径:null / 空白字符串算未配置,false / 0 算已配置', () => {
    const kvOnly = manifest({
      slots: ['tool'],
      tools: [{ name: 'work', description: '干活' }],
      settingsHtml: 'settings.html',
      setup: { requires: [{ anyOf: [{ kv: 'mode', label: '模式' }] }] },
    });
    for (const unset of [undefined, null, '', '   ']) {
      expect(evaluateGhostSetup(kvOnly, probes({ kvValue: () => unset })).ready).toBe(false);
    }
    for (const set of [false, 0, 'fast', { nested: true }]) {
      expect(evaluateGhostSetup(kvOnly, probes({ kvValue: () => set })).ready).toBe(true);
    }
  });

  it('有 setup 声明时启发式不再参与(未被声明引用的凭证不构成需求)', () => {
    const partial = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'work', description: '干活' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.example.com'],
        secrets: [
          { key: 'key_a', label: 'Key A', inject: INJECT },
          { key: 'optional_key', label: '可选 Key', inject: INJECT },
        ],
      },
      setup: { requires: [{ anyOf: ['secret:key_a'] }] },
    });
    // optional_key 未配置,但声明只要求 key_a → 就绪。
    const status = evaluateGhostSetup(partial, probes({ secretSaved: (key) => key === 'key_a' }));
    expect(status.ready).toBe(true);
  });
});

describe('evaluateGhostSetup · requires: [] 显式 opt-out', () => {
  it('声明了可选凭证但 requires 为空 → 恒就绪(启发式不再兜底)', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'work', description: '干活' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.example.com'],
        secrets: [{ key: 'optional_key', label: '可选 Key', inject: INJECT }],
      },
      setup: { requires: [] },
    });
    // 同一份声明去掉 setup 时启发式会拦(对照组),opt-out 后放行。
    expect(evaluateGhostSetup(m, probes())).toEqual({ ready: true, missingGroups: [], reauth: [] });
  });
});

describe('evaluateGhostSetupAssessment · Setup Runtime 完整判定', () => {
  it('保留 any-of 关系、全部条目状态、Action 和 Host revision', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'search', description: '搜' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.search.example', 'accounts.google.example'],
        secrets: [
          {
            key: 'key_a',
            label: 'Key A',
            hint: '从控制台复制 API Key',
            url: 'https://console.example.com/keys',
            inject: INJECT,
          },
          {
            key: 'google',
            label: 'Google',
            source: 'oauth',
            inject: INJECT,
            oauth: {
              authorizeUrl: 'https://accounts.google.example/auth',
              tokenUrl: 'https://accounts.google.example/token',
            },
          },
        ],
      },
      setup: { requires: [{ anyOf: ['secret:key_a', 'secret:google'] }] },
    });
    const assessment = evaluateGhostSetupAssessment(
      m,
      probes({
        oauthStatus: () => ({ clientConfigured: true, connected: 0, expired: 1 }),
      }),
      { revision: 7 },
    );
    expect(assessment).toEqual({
      state: 'required',
      revision: 7,
      groups: [
        {
          id: 'manifest:1',
          mode: 'any_of',
          items: [
            {
              ref: 'secret:key_a',
              kind: 'secret',
              label: 'Key A',
              description: '从控制台复制 API Key',
              state: 'missing',
              actions: [
                {
                  id: expect.stringMatching(/^inline_form:[a-f0-9]{24}$/),
                  kind: 'inline_form',
                  form: {
                    fields: [
                      {
                        id: 'value',
                        type: 'secret',
                        label: 'Key A',
                        description: '从控制台复制 API Key',
                        externalLink: {
                          url: 'https://console.example.com/keys',
                        },
                        required: true,
                        maxLength: 4096,
                      },
                    ],
                  },
                },
              ],
            },
            {
              ref: 'secret:google',
              kind: 'oauth',
              label: 'Google',
              state: 'expired',
              actions: [
                {
                  id: 'oauth_connect:secret:google',
                  kind: 'oauth_connect',
                },
              ],
            },
          ],
        },
      ],
    });
    const inlineAction = assessment.groups[0].items[0].actions[0];
    expect(inlineAction.id).not.toContain('key_a');
  });

  it('可合并 Host client_config 虚拟组，不要求 manifest 伪造 Secret', () => {
    const m = manifest({ slots: ['tool'], tools: [{ name: 'draw', description: '画' }] });
    const assessment = evaluateGhostSetupAssessment(m, probes(), {
      revision: 3,
      additionalGroups: [
        {
          id: 'host:image-provider',
          mode: 'any_of',
          items: [
            {
              ref: 'client_config:image-provider',
              kind: 'client_config',
              label: '图片模型',
              state: 'missing',
              actions: [
                {
                  id: 'open_client_settings:client_config:image-provider',
                  kind: 'open_client_settings',
                },
              ],
            },
          ],
        },
      ],
    });
    expect(assessment.state).toBe('required');
    expect(assessment.groups[0]?.items[0]?.kind).toBe('client_config');
  });

  it('严格模式遇到 manifest 漂移时 fail-closed，旧投影仍兼容 fail-open', () => {
    const drifted = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'work', description: '干活' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.example.com'],
        secrets: [{ key: 'declared', label: 'Declared', inject: INJECT }],
      },
      setup: { requires: [{ anyOf: ['secret:declared'] }] },
    });
    drifted.setup = {
      requires: [{ anyOf: [{ kind: 'secret', key: 'removed' }] }],
    };
    expect(() => evaluateGhostSetupAssessment(drifted, probes(), { revision: 0 })).toThrow(
      GhostSetupAssessmentError,
    );
    expect(evaluateGhostSetup(drifted, probes()).ready).toBe(true);
  });

  it('严格模式统一拒绝悬空 connection、缺 settingsHtml 的 kv 与 login-email requirement', () => {
    const connectionDrift = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'work', description: '干活' }],
      settingsHtml: 'settings.html',
      network: {
        connections: [
          {
            key: 'declared',
            label: 'Declared',
            inject: { header: 'Authorization', format: '{value}' },
          },
        ],
      },
      setup: { requires: [{ anyOf: ['connection:declared'] }] },
    });
    connectionDrift.setup = {
      requires: [{ anyOf: [{ kind: 'connection', key: 'removed' }] }],
    };
    expect(() => evaluateGhostSetupAssessment(connectionDrift, probes(), { revision: 1 })).toThrow(
      GhostSetupAssessmentError,
    );

    const kvDrift = manifest({
      slots: ['tool'],
      tools: [{ name: 'work', description: '干活' }],
      settingsHtml: 'settings.html',
      setup: { requires: [{ anyOf: [{ kv: 'mode', label: '模式' }] }] },
    });
    kvDrift.settingsHtml = undefined;
    expect(() => evaluateGhostSetupAssessment(kvDrift, probes(), { revision: 1 })).toThrow(
      GhostSetupAssessmentError,
    );

    const loginEmailDrift = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'work', description: '干活' }],
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'identity',
            label: 'Identity',
            source: 'login-email',
            inject: INJECT,
          },
        ],
      },
    });
    loginEmailDrift.setup = {
      requires: [{ anyOf: [{ kind: 'secret', key: 'identity' }] }],
    };
    expect(() => evaluateGhostSetupAssessment(loginEmailDrift, probes(), { revision: 1 })).toThrow(
      GhostSetupAssessmentError,
    );
  });

  it('OAuth client 未配置时先打开插件设置，client 可用后才允许授权', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'gmail', description: '邮件' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['accounts.google.example'],
        secrets: [
          {
            key: 'google',
            label: 'Google',
            source: 'oauth',
            inject: INJECT,
            oauth: {
              authorizeUrl: 'https://accounts.google.example/auth',
              tokenUrl: 'https://accounts.google.example/token',
            },
          },
        ],
      },
    });
    const withoutClient = evaluateGhostSetupAssessment(m, probes(), { revision: 1 });
    expect(withoutClient.groups[0]?.items[0]?.actions[0]?.kind).toBe('open_plugin_settings');
    const withClient = evaluateGhostSetupAssessment(
      m,
      probes({
        oauthStatus: () => ({ clientConfigured: true, connected: 0, expired: 0 }),
      }),
      { revision: 2 },
    );
    expect(withClient.groups[0]?.items[0]?.actions[0]?.kind).toBe('oauth_connect');
  });

  it('Runtime revision 必须是非负整数', () => {
    const m = manifest({ slots: ['tool'], tools: [{ name: 'work', description: '干活' }] });
    for (const revision of [-1, 1.5, Number.NaN]) {
      expect(() => evaluateGhostSetupAssessment(m, probes(), { revision })).toThrow(
        GhostSetupAssessmentError,
      );
    }
  });
});

describe('handleGhostSetupStatusRequest · IPC handler 主体(规则 14)', () => {
  const readyManifest = manifest({
    slots: ['tool'],
    tools: [{ name: 'work', description: '干活' }],
  });

  it('非法 id 形态 → INVALID_PARAMS', () => {
    for (const bad of [null, 42, 'UPPER_CASE!', '']) {
      expect(() =>
        handleGhostSetupStatusRequest({
          id: bad,
          getRuntimeManifest: () => readyManifest,
          probesFor: () => probes(),
        }),
      ).toThrow(/INVALID_PARAMS/);
    }
  });

  it('未安装的意识 → NOT_FOUND', () => {
    expect(() =>
      handleGhostSetupStatusRequest({
        id: 'nope',
        getRuntimeManifest: () => null,
        probesFor: () => probes(),
      }),
    ).toThrow(/NOT_FOUND/);
  });

  it('正常路径:清单经 getRuntimeManifest 现查,状态透传判定结果', () => {
    const getRuntimeManifest = vi.fn(() => readyManifest);
    const status = handleGhostSetupStatusRequest({
      id: 'demo',
      getRuntimeManifest,
      probesFor: () => probes(),
    });
    expect(getRuntimeManifest).toHaveBeenCalledWith('demo');
    expect(status).toEqual({ ready: true, missingGroups: [], reauth: [] });
  });

  it('探针意外抛错原样上抛(不折叠成「未配置」;renderer 侧 fail-open)', () => {
    const m = manifest({
      slots: ['tool', 'network'],
      tools: [{ name: 'work', description: '干活' }],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.example.com'],
        secrets: [{ key: 'api_key', label: 'API Key', inject: INJECT }],
      },
    });
    expect(() =>
      handleGhostSetupStatusRequest({
        id: 'demo',
        getRuntimeManifest: () => m,
        probesFor: () =>
          probes({
            secretSaved: () => {
              throw new Error('vault io failed');
            },
          }),
      }),
    ).toThrow('vault io failed');
  });
});
