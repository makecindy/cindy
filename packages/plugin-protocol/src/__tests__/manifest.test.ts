import { describe, expect, it } from 'vitest';
import {
  GHOST_MANUAL_DESCRIPTION_MAX_CHARS,
  GHOST_MANUAL_ENTRY_FILE,
  GHOST_MANUAL_MAX_ITEMS,
  GHOST_MANUAL_MD_MAX_BYTES,
  GHOST_MANIFEST_SUMMARY_MAX_CHARS,
  GHOST_MANIFEST_SCHEMA_VERSION,
  GHOST_OAUTH_SCOPES_MAX,
  compareCindyVersions,
  ghostManifestUsesOidcToken,
  isSafeGhostRelativePath,
  isValidCindyVersion,
  isValidGhostId,
  isVersionlessCindyVersion,
  supportsCindyVersion,
  validateGhostManifest,
} from '../manifest.js';

const validManifest = {
  schemaVersion: GHOST_MANIFEST_SCHEMA_VERSION,
  id: 'acme-helper',
  name: 'Acme Helper',
  version: '1.0.0',
  kind: 'chip',
  entry: 'index.js',
  slots: ['tool'],
  tools: [{ name: 'help', description: 'Help with Acme tasks' }],
} as const;

describe('Ghost manifest contract', () => {
  it('exports the manual authoring limits', () => {
    expect(GHOST_MANUAL_MAX_ITEMS).toBe(8);
    expect(GHOST_MANUAL_ENTRY_FILE).toBe('MANUAL.md');
    expect(GHOST_MANUAL_MD_MAX_BYTES).toBe(64 * 1024);
    expect(GHOST_MANUAL_DESCRIPTION_MAX_CHARS).toBe(300);
  });

  it('accepts and normalizes a valid schema v2 manifest', () => {
    const result = validateGhostManifest(validManifest);
    expect(result).toEqual({ ok: true, manifest: validManifest });
  });

  it('keeps minCindyVersion optional for old plugins and validates declared versions', () => {
    expect(validateGhostManifest(validManifest)).toEqual({ ok: true, manifest: validManifest });
    expect(validateGhostManifest({ ...validManifest, minCindyVersion: '1.2.3' })).toEqual({
      ok: true,
      manifest: { ...validManifest, minCindyVersion: '1.2.3' },
    });
    for (const invalid of ['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '']) {
      expect(validateGhostManifest({ ...validManifest, minCindyVersion: invalid }).ok).toBe(false);
    }
  });

  it('compares Cindy versions with SemVer precedence', () => {
    expect(compareCindyVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareCindyVersions('1.3.0', '1.2.9')).toBe(1);
    expect(compareCindyVersions('1.2.3-beta.2', '1.2.3-beta.10')).toBe(-1);
    expect(compareCindyVersions('1.2.3-999999999999999999', '1.2.3-1000000000000000000')).toBe(-1);
    expect(compareCindyVersions('1.2.3', '1.2.3-rc.1')).toBe(1);
    expect(compareCindyVersions('not-a-version', '1.2.3')).toBeNull();
    expect(isValidCindyVersion('1.2.3')).toBe(true);
    expect(isValidCindyVersion('v1.2.3')).toBe(false);
    expect(isVersionlessCindyVersion('0.0.0-dev.1')).toBe(true);
    expect(supportsCindyVersion('0.1.0', undefined)).toBe(true);
    expect(supportsCindyVersion('0.0.0-dev.1', '99.0.0')).toBe(true);
    expect(supportsCindyVersion('0.0.0-not valid', '1.0.0')).toBe(false);
    expect(supportsCindyVersion('0.0.0-dev.1', 'not-a-version')).toBe(false);
    expect(supportsCindyVersion('1.2.3', '1.2.3')).toBe(true);
    expect(supportsCindyVersion('1.2.2', '1.2.3')).toBe(false);
    expect(supportsCindyVersion('not-a-version', '1.2.3')).toBe(false);
  });

  it('rejects invalid ids and schema versions', () => {
    expect(isValidGhostId('../escape')).toBe(false);
    expect(validateGhostManifest({ ...validManifest, schemaVersion: 1 }).ok).toBe(false);
  });

  it('shares the 300-character limit across description and whenToUse', () => {
    expect(GHOST_MANIFEST_SUMMARY_MAX_CHARS).toBe(300);
    for (const field of ['description', 'whenToUse'] as const) {
      expect(
        validateGhostManifest({
          ...validManifest,
          [field]: 'x'.repeat(GHOST_MANIFEST_SUMMARY_MAX_CHARS),
        }).ok,
      ).toBe(true);
      expect(
        validateGhostManifest({
          ...validManifest,
          [field]: 'x'.repeat(GHOST_MANIFEST_SUMMARY_MAX_CHARS + 1),
        }),
      ).toEqual({
        ok: false,
        reason: `${field} 必须是 1–${GHOST_MANIFEST_SUMMARY_MAX_CHARS} 字符的非空字符串`,
      });
    }
  });

  it('accepts an oidc-token secret without a settings page and normalizes its exact host', () => {
    const result = validateGhostManifest({
      ...validManifest,
      tools: undefined,
      slots: ['network'],
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token',
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['API.EXAMPLE.COM'],
            },
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        network: {
          hosts: ['api.example.com'],
          secrets: [
            {
              key: 'cindy_identity',
              label: 'Cindy organization identity',
              source: 'oidc-token',
              inject: {
                header: 'Authorization',
                format: 'Bearer {value}',
                hosts: ['api.example.com'],
              },
            },
          ],
        },
      }),
    });
    expect(result.ok && ghostManifestUsesOidcToken(result.manifest)).toBe(true);
    const baseline = validateGhostManifest(validManifest);
    expect(baseline.ok && ghostManifestUsesOidcToken(baseline.manifest)).toBe(false);
  });

  it('rejects unsafe oidc-token declarations', () => {
    const base = {
      ...validManifest,
      tools: undefined,
      slots: ['network'],
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'cindy_identity',
            label: 'Cindy organization identity',
            source: 'oidc-token',
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['api.example.com'],
            },
          },
        ],
      },
    };
    const secret = (patch: Record<string, unknown> = {}, hosts: string[] = base.network.hosts) => ({
      ...base,
      network: {
        ...base.network,
        hosts,
        secrets: [{ ...base.network.secrets[0], ...patch }],
      },
    });

    expect(
      validateGhostManifest(
        secret({
          inject: { header: 'X-Identity', format: 'Bearer {value}', hosts: ['api.example.com'] },
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('Authorization: Bearer') });
    expect(
      validateGhostManifest(
        secret({
          inject: { header: 'Authorization', format: 'Basic {value}' },
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('Authorization: Bearer') });
    expect(
      validateGhostManifest(
        secret(
          {
            inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['*.example.com'] },
          },
          ['*.example.com'],
        ),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不允许通配') });
    expect(
      validateGhostManifest(
        secret({
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('显式声明非空 inject.hosts') });
    expect(validateGhostManifest(secret({ url: 'https://api.example.com/keys' }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不允许声明 url'),
    });
    expect(validateGhostManifest(secret({ exchange: {} }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不允许声明 exchange'),
    });
    expect(validateGhostManifest(secret({ oauth: {} }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('oauth 仅允许在 source: oauth'),
    });
    expect(
      validateGhostManifest(
        secret({
          input: 'ghost',
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不允许标注 input') });
  });

  it('accepts a gh-cli secret with a settings-managed fallback token', () => {
    const result = validateGhostManifest({
      ...validManifest,
      tools: undefined,
      slots: ['network'],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.github.com', 'objects.githubusercontent.com'],
        secrets: [
          {
            key: 'github_pat',
            label: 'GitHub login',
            source: 'gh-cli',
            hint: 'The host prefers GitHub CLI and falls back to this token',
            url: 'https://github.com/settings/tokens',
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['API.GITHUB.COM'],
            },
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: true,
      manifest: expect.objectContaining({
        network: {
          hosts: ['api.github.com', 'objects.githubusercontent.com'],
          secrets: [
            {
              key: 'github_pat',
              label: 'GitHub login',
              source: 'gh-cli',
              hint: 'The host prefers GitHub CLI and falls back to this token',
              url: 'https://github.com/settings/tokens',
              inject: {
                header: 'Authorization',
                format: 'Bearer {value}',
                hosts: ['api.github.com'],
              },
            },
          ],
        },
      }),
    });
  });

  it('rejects unsafe gh-cli declarations', () => {
    const base = {
      ...validManifest,
      tools: undefined,
      slots: ['network'],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['api.github.com', 'uploads.github.com'],
        secrets: [
          {
            key: 'github_pat',
            label: 'GitHub login',
            source: 'gh-cli',
            inject: {
              header: 'Authorization',
              format: 'Bearer {value}',
              hosts: ['api.github.com'],
            },
          },
        ],
      },
    };
    const secret = (patch: Record<string, unknown> = {}) => ({
      ...base,
      network: {
        ...base.network,
        secrets: [{ ...base.network.secrets[0], ...patch }],
      },
    });

    expect(validateGhostManifest({ ...base, settingsHtml: undefined })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('settingsHtml'),
    });
    expect(
      validateGhostManifest(
        secret({
          inject: {
            header: 'X-GitHub-Token',
            format: 'Bearer {value}',
            hosts: ['api.github.com'],
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('Authorization: Bearer') });
    expect(
      validateGhostManifest(
        secret({
          inject: {
            header: 'Authorization',
            format: 'Bearer {value}',
            hosts: ['api.github.com', 'uploads.github.com'],
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('只能是 api.github.com') });
    expect(
      validateGhostManifest(
        secret({
          inject: { header: 'Authorization', format: 'Bearer {value}' },
        }),
      ),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('只能是 api.github.com') });
    expect(validateGhostManifest(secret({ exchange: {} }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不允许声明 exchange'),
    });
    expect(validateGhostManifest(secret({ oauth: {} }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('oauth 仅允许在 source: oauth'),
    });
    expect(validateGhostManifest(secret({ input: 'ghost' }))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不允许标注 input'),
    });
  });

  it('accepts up to 256 OAuth scopes and rejects more', () => {
    const withScopes = (count: number) =>
      validateGhostManifest({
        ...validManifest,
        tools: undefined,
        slots: ['network'],
        settingsHtml: 'settings.html',
        network: {
          hosts: ['accounts.example.com'],
          secrets: [
            {
              key: 'account',
              label: 'Example account',
              source: 'oauth',
              inject: { header: 'Authorization', format: 'Bearer {value}' },
              oauth: {
                authorizeUrl: 'https://accounts.example.com/authorize',
                tokenUrl: 'https://accounts.example.com/token',
                scopes: Array.from({ length: count }, (_, index) => `scope:${index}`),
              },
            },
          ],
        },
      });

    expect(GHOST_OAUTH_SCOPES_MAX).toBe(256);
    const accepted = withScopes(GHOST_OAUTH_SCOPES_MAX);
    expect(accepted.ok).toBe(true);
    expect(accepted.ok && accepted.manifest.network?.secrets?.[0]?.oauth?.scopes).toEqual(
      Array.from({ length: GHOST_OAUTH_SCOPES_MAX }, (_, index) => `scope:${index}`),
    );
    expect(withScopes(GHOST_OAUTH_SCOPES_MAX + 1)).toEqual({
      ok: false,
      reason: 'network.secrets[].oauth.scopes 必须是 ≤256 条的数组',
    });
  });

  it('preserves Desktop-supported OAuth client alternatives and identity avatar path', () => {
    const result = validateGhostManifest({
      ...validManifest,
      tools: undefined,
      slots: ['network'],
      settingsHtml: 'settings.html',
      network: {
        hosts: ['accounts.example.com', 'api.example.com'],
        secrets: [
          {
            key: 'account',
            label: 'Example account',
            source: 'oauth',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
            oauth: {
              authorizeUrl: 'https://accounts.example.com/authorize',
              tokenUrl: 'https://accounts.example.com/token',
              clientId: 'cn-client',
              clientIdAlternatives: ['global-client'],
              tokenBroker: 'example',
              identity: {
                url: 'https://api.example.com/me',
                labelPath: 'data.user_id',
                avatarPath: 'data.avatar_thumb',
              },
            },
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.network?.secrets?.[0]?.oauth).toMatchObject({
      clientIdAlternatives: ['global-client'],
      identity: { avatarPath: 'data.avatar_thumb' },
    });
  });

  it('accepts and normalizes Plugin locale resource declarations', () => {
    const locales = {
      en: 'locales/en.json',
      'zh-CN': 'locales/zh-CN.json',
      ja: 'locales/ja.json',
      ko: 'locales/ko.json',
    };
    const result = validateGhostManifest({ ...validManifest, locales });

    expect(result).toEqual({
      ok: true,
      manifest: { ...validManifest, locales },
    });
  });

  it('rejects locale declarations without English fallback or with unsafe conflicts', () => {
    expect(
      validateGhostManifest({
        ...validManifest,
        locales: { ja: 'locales/ja.json' },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('必须提供 en'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        locales: { en: 'index.js' },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('以 .json 结尾'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        locales: { en: 'ghost.json' },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件其他声明文件'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        locales: {
          en: 'locales/en.json',
          ja: 'locales/EN.json',
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('重复路径'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        locales: {
          en: 'a.json',
          ja: 'a.json/child.json',
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('祖先路径冲突'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        locales: {
          en: 'locales/en.json',
          fr: 'locales/fr.json',
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不支持的语言'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'skill'],
        locales: { en: 'skills/helper.json' },
        skill: {
          items: [
            {
              dir: 'skills/helper.json',
              name: 'helper',
              description: 'Help with example tasks.',
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件其他声明文件'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'skill'],
        locales: { en: 'skills/helper.json' },
        skill: {
          items: [
            {
              dir: 'skills/helper.json/subskill',
              name: 'helper',
              description: 'Help with example tasks.',
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件其他声明文件'),
    });
    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'skill'],
        locales: { en: 'skills/helper/locales/en.json' },
        skill: {
          items: [
            {
              dir: 'skills/helper',
              name: 'helper',
              description: 'Help with example tasks.',
            },
          ],
        },
      }),
    ).toMatchObject({
      ok: true,
      manifest: expect.objectContaining({
        locales: { en: 'skills/helper/locales/en.json' },
      }),
    });
  });

  it('rejects locale and manual paths with either nesting direction', () => {
    const validatePaths = (localePath: string, manualDir: string) =>
      validateGhostManifest({
        ...validManifest,
        locales: { en: localePath },
        manual: {
          items: [{ dir: manualDir, name: 'guide', description: 'Manual guide.' }],
        },
      });

    expect(validatePaths('content/en.json', 'content/en.json/manual')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件其他声明文件'),
    });
    expect(validatePaths('manual/docs/en.json', 'manual/docs')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件其他声明文件'),
    });
    expect(validatePaths('manual/en.json', 'manual/en.json')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件其他声明文件'),
    });
    expect(validatePaths('locales/en.json', 'manual/docs')).toMatchObject({
      ok: true,
      manifest: expect.objectContaining({
        locales: { en: 'locales/en.json' },
        manual: {
          items: [{ dir: 'manual/docs', name: 'guide', description: 'Manual guide.' }],
        },
      }),
    });
  });

  it('rejects Windows reserved device names in ids and relative paths', () => {
    expect(isValidGhostId('con')).toBe(false);
    expect(isValidGhostId('com1')).toBe(false);
    expect(isSafeGhostRelativePath('CON.js')).toBe(false);
    expect(isSafeGhostRelativePath('assets/AUX.html')).toBe(false);
    expect(isSafeGhostRelativePath('assets/console.html')).toBe(true);
    expect(validateGhostManifest({ ...validManifest, entry: 'assets/LPT9.js' }).ok).toBe(false);
  });

  it('rejects credential exchange URLs on non-default HTTPS ports', () => {
    const result = validateGhostManifest({
      ...validManifest,
      settingsHtml: 'settings.html',
      slots: ['network'],
      tools: undefined,
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'api_key',
            label: 'API key',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
            exchange: {
              url: 'https://api.example.com:8443/token',
              bodyFormat: '{"key":"{value}"}',
              tokenPath: 'token',
            },
          },
        ],
      },
    });

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain('仅支持 https 默认端口');
  });

  it('normalizes a representative full capability manifest', () => {
    const result = validateGhostManifest({
      schemaVersion: GHOST_MANIFEST_SCHEMA_VERSION,
      id: 'full-helper',
      name: 'Full Helper',
      version: '2.0.0',
      author: 'Cindy',
      description: 'Exercises the shared manifest contract.',
      whenToUse: 'Use for representative protocol validation.',
      icon: 'assets/icon.png',
      entry: 'src/main.js',
      launch: 'resident',
      settingsHtml: 'settings.html',
      settingsHeight: 320,
      slots: ['subscribe', 'tool', 'card', 'panel', 'cindy', 'network', 'notify', 'fs'],
      tools: [
        {
          name: 'run_helper',
          description: 'Run the helper.',
          parameters: {
            type: 'object',
            properties: { input: { type: 'string' } },
            required: ['input'],
          },
        },
      ],
      cindy: { image: ['generate'], video: ['edit'] },
      subscribe: { topics: ['turn'], hooks: ['will-user-message'] },
      network: {
        hosts: ['api.example.com'],
        secrets: [
          {
            key: 'api_key',
            label: 'API key',
            inject: { header: 'Authorization', format: 'Bearer {value}' },
          },
        ],
      },
      command: 'full-helper',
      keywords: ['full helper'],
      panel: {
        title: 'Full Helper',
        html: 'panel.html',
        position: 'right',
        minWidth: 320,
        defaultFraction: 0.2,
      },
      unknownField: 'ignored',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe('chip');
    expect(result.manifest.slots).toEqual([
      'subscribe',
      'tool',
      'card',
      'panel',
      'cindy',
      'network',
      'notify',
      'fs',
    ]);
    expect(result.manifest).not.toHaveProperty('unknownField');
  });

  it('accepts Desktop-supported badge and confirm slots while requiring a badge panel', () => {
    const manifest = {
      ...validManifest,
      slots: ['tool', 'panel', 'badge', 'confirm'],
      panel: { html: 'panel.html' },
    } as const;

    expect(validateGhostManifest(manifest)).toEqual({ ok: true, manifest });
    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'badge'],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('panel'),
    });
  });

  it('accepts the taptap-maker style manifest with node/session-context/pick/preview slots', () => {
    const result = validateGhostManifest({
      schemaVersion: GHOST_MANIFEST_SCHEMA_VERSION,
      id: 'taptap-maker',
      name: 'TapTap Maker',
      version: '2.0.0',
      author: 'Cindy',
      icon: 'assets/icon.png',
      entry: 'main.js',
      settingsHtml: 'settings.html',
      settingsHeight: 760,
      slots: ['tool', 'card', 'node', 'session-context', 'pick', 'preview', 'workspace'],
      card: { externalLinks: true },
      node: {
        entry: 'node/maker-mcp.cjs',
        entries: ['node/account.cjs', 'node/maker-child.cjs'],
        protocol: 'mcp-stdio',
        lifecycle: 'on-demand',
        idleTimeoutSeconds: 600,
        childSpawn: true,
      },
      preview: { hosts: ['maker.taptap.cn'] },
      command: 'taptap-maker',
      tools: [{ name: 'maker_status', description: 'Check Maker status' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.slots).toEqual([
      'tool',
      'card',
      'node',
      'session-context',
      'pick',
      'preview',
      'workspace',
    ]);
    expect(result.manifest.node).toEqual({
      entry: 'node/maker-mcp.cjs',
      protocol: 'mcp-stdio',
      lifecycle: 'on-demand',
      idleTimeoutSeconds: 600,
      entries: ['node/account.cjs', 'node/maker-child.cjs'],
      childSpawn: true,
    });
    expect(result.manifest.preview).toEqual({ hosts: ['maker.taptap.cn'] });
    expect(result.manifest.card).toEqual({ externalLinks: true });
  });

  it('round-trips the Host-owned ios-simulator slot with an explicit Cindy version floor', () => {
    const manifest = {
      ...validManifest,
      id: 'simulator-workflow',
      name: 'Simulator Workflow',
      minCindyVersion: '1.2.3',
      slots: ['ios-simulator'],
      tools: undefined,
    } as const;

    const result = validateGhostManifest(JSON.parse(JSON.stringify(manifest)));

    expect(result).toEqual({ ok: true, manifest });
  });

  it('rejects ios-simulator manifests that cannot be version-gated for older Hosts', () => {
    const manifest = {
      ...validManifest,
      slots: ['ios-simulator'],
      tools: undefined,
    };

    expect(validateGhostManifest(manifest)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('minCindyVersion'),
    });
    expect(
      validateGhostManifest({
        ...manifest,
        minCindyVersion: '1.2.3',
        slots: ['ios-simulator-control'],
      }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('未知卡槽'),
    });
  });

  it('enforces node slot / detail pairing and entry discipline', () => {
    const base = {
      ...validManifest,
      slots: ['tool', 'node'],
    };
    expect(validateGhostManifest(base)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('缺少 node 工作进程详单'),
    });
    const withNode = (node: Record<string, unknown>) => validateGhostManifest({ ...base, node });
    expect(withNode({ entry: 'node/a.cjs', protocol: 'mcp-stdio', command: 'sh' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不能声明 command/args/shell/env'),
    });
    expect(withNode({ entry: '../a.cjs', protocol: 'mcp-stdio' }).ok).toBe(false);
    expect(withNode({ entry: 'index.js', protocol: 'mcp-stdio' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不能与浏览器沙箱 entry'),
    });
    expect(withNode({ entry: 'node/a.cjs', protocol: 'bash' }).ok).toBe(false);
    expect(
      withNode({ entry: 'node/a.cjs', protocol: 'mcp-stdio', entries: ['node/a.cjs'] }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不能重复主入口') });
    // 大小写不敏感文件系统上的同名变体必须按同一个文件拒绝。
    expect(withNode({ entry: 'Index.js', protocol: 'mcp-stdio' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('不能与浏览器沙箱 entry'),
    });
    expect(
      withNode({ entry: 'node/a.cjs', protocol: 'mcp-stdio', entries: ['node/A.cjs'] }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('不能重复主入口') });
    expect(
      withNode({
        entry: 'node/a.cjs',
        protocol: 'mcp-stdio',
        entries: ['node/b.cjs', 'node/B.cjs'],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复入口') });
    expect(
      withNode({
        entry: 'node/a.cjs',
        protocol: 'mcp-stdio',
        entries: ['node/b.cjs', 'node/b.cjs'],
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复入口') });
    expect(
      withNode({ entry: 'node/a.cjs', protocol: 'mcp-stdio', childSpawn: 'yes' }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('childSpawn 必须是布尔值') });
    expect(
      withNode({
        entry: 'node/a.cjs',
        protocol: 'mcp-stdio',
        lifecycle: 'resident',
        idleTimeoutSeconds: 60,
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('resident 时不能再声明') });
  });

  it('accepts and normalizes method-scoped Node secret bindings', () => {
    const result = validateGhostManifest({
      ...validManifest,
      settingsHtml: 'settings.html',
      slots: ['tool', 'node'],
      node: {
        entry: 'node/worker.cjs',
        entries: ['node/secondary.cjs'],
        protocol: 'json-rpc-stdio',
        secretBindings: [
          {
            key: 'mail_code',
            label: 'Mail authorization code',
            methods: ['account/connect', 'mail/action'],
            entry: 'node/secondary.cjs',
            hint: 'Use the provider-generated authorization code',
            url: 'https://mail.example.com/settings',
          },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.node?.secretBindings).toEqual([
      {
        key: 'mail_code',
        label: 'Mail authorization code',
        methods: ['account/connect', 'mail/action'],
        entry: 'node/secondary.cjs',
        hint: 'Use the provider-generated authorization code',
        url: 'https://mail.example.com/settings',
      },
    ]);
  });

  it('rejects unsafe Node secret bindings and shared credential-key collisions', () => {
    const base = {
      ...validManifest,
      settingsHtml: 'settings.html',
      slots: ['tool', 'node'],
      node: {
        entry: 'node/worker.cjs',
        entries: ['node/secondary.cjs'],
        protocol: 'json-rpc-stdio',
      },
    };
    const binding = {
      key: 'mail_code',
      label: 'Mail authorization code',
      methods: ['mail/action'],
    };

    expect(
      validateGhostManifest({
        ...base,
        settingsHtml: undefined,
        node: { ...base.node, secretBindings: [binding] },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('需要 settingsHtml') });
    expect(
      validateGhostManifest({
        ...base,
        node: { ...base.node, secretBindings: [{ ...binding, methods: ['bad method'] }] },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('安全方法名') });
    expect(
      validateGhostManifest({
        ...base,
        node: {
          ...base.node,
          protocol: 'mcp-stdio',
          secretBindings: [{ ...binding, methods: ['initialize'] }],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('宿主保留的 MCP 方法') });
    expect(
      validateGhostManifest({
        ...base,
        node: {
          ...base.node,
          protocol: 'json-rpc-stdio',
          secretBindings: [{ ...binding, methods: ['initialize'] }],
        },
      }).ok,
    ).toBe(true);
    expect(
      validateGhostManifest({
        ...base,
        node: {
          ...base.node,
          secretBindings: [{ ...binding, entry: 'node/other.cjs' }],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('逐字命中') });
    expect(
      validateGhostManifest({
        ...base,
        node: { ...base.node, secretBindings: [binding, binding] },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复 key') });
    expect(
      validateGhostManifest({
        ...base,
        slots: ['tool', 'node', 'network'],
        node: { ...base.node, secretBindings: [binding] },
        network: {
          hosts: ['api.example.com'],
          secrets: [
            {
              key: 'mail_code',
              label: 'Duplicate key',
              inject: { header: 'Authorization', format: 'Bearer {value}' },
            },
          ],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('与 node.secretBindings 撞名') });
    expect(
      validateGhostManifest({
        ...base,
        slots: ['tool', 'node', 'network'],
        node: { ...base.node, secretBindings: [binding] },
        network: {
          hosts: [],
          connections: [
            {
              key: 'mail_code',
              label: 'Duplicate connection',
              inject: { header: 'Authorization', format: 'Bearer {value}' },
            },
          ],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('与 node.secretBindings') });

    for (const invalidBinding of [
      { ...binding, key: 'Bad-Key' },
      { ...binding, label: '' },
      { ...binding, methods: [] },
      { ...binding, methods: ['mail/action', 'mail/action'] },
      { ...binding, hint: '' },
      { ...binding, url: 'http://mail.example.com/settings' },
      { ...binding, unexpected: true },
    ]) {
      expect(
        validateGhostManifest({
          ...base,
          node: { ...base.node, secretBindings: [invalidBinding] },
        }).ok,
        JSON.stringify(invalidBinding),
      ).toBe(false);
    }
    expect(
      validateGhostManifest({
        ...base,
        node: { ...base.node, secretBindings: [] },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('1–4 条') });
    expect(
      validateGhostManifest({
        ...base,
        node: {
          ...base.node,
          secretBindings: Array.from({ length: 5 }, (_, index) => ({
            ...binding,
            key: `mail_code_${index}`,
          })),
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('1–4 条') });
  });

  it('enforces preview slot / hosts pairing and pattern rules', () => {
    const base = { ...validManifest, slots: ['tool', 'preview'] };
    expect(validateGhostManifest(base)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('缺少 preview 详单'),
    });
    expect(validateGhostManifest({ ...base, preview: { hosts: [] } }).ok).toBe(false);
    expect(
      validateGhostManifest({ ...base, preview: { hosts: ['https://x.example.com'] } }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({
        ...base,
        preview: { hosts: ['maker.taptap.cn', 'maker.taptap.cn'] },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复域名') });
    expect(
      validateGhostManifest({ ...validManifest, preview: { hosts: ['maker.taptap.cn'] } }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('未包含 "preview"') });
    const loopback = validateGhostManifest({
      ...base,
      preview: { hosts: ['localhost', '*.taptap.cn'] },
    });
    expect(loopback.ok).toBe(true);
  });

  it('enforces skill slot / items pairing and shape rules', () => {
    const base = { ...validManifest, slots: ['tool', 'skill'] };
    const goodItems = [{ dir: 'skills/foo', name: 'foo', description: '教 Agent 用 foo' }];
    // 有槽必有详单;有详单必有槽
    expect(validateGhostManifest(base)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('缺少 skill 详单'),
    });
    expect(validateGhostManifest({ ...validManifest, skill: { items: goodItems } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('未包含 "skill"'),
    });
    // 合法声明原样收录
    const good = validateGhostManifest({ ...base, skill: { items: goodItems } });
    expect(good).toMatchObject({ ok: true, manifest: { skill: { items: goodItems } } });
    // items 形状:空/超限/非对象/自造字段一律拒
    expect(validateGhostManifest({ ...base, skill: { items: [] } }).ok).toBe(false);
    expect(validateGhostManifest({ ...base, skill: {} }).ok).toBe(false);
    expect(validateGhostManifest({ ...base, skill: { items: goodItems, extra: 1 } }).ok).toBe(
      false,
    );
    expect(
      validateGhostManifest({
        ...base,
        skill: { items: [{ ...goodItems[0], scope: 'global' }] },
      }).ok,
    ).toBe(false);
    const five = Array.from({ length: 5 }, (_, i) => ({
      dir: `skills/s${i}`,
      name: `s${i}`,
      description: 'x',
    }));
    expect(validateGhostManifest({ ...base, skill: { items: five } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('最多 4 条'),
    });
    expect(validateGhostManifest({ ...base, skill: { items: five.slice(0, 4) } }).ok).toBe(true);
  });

  it('enforces skill item dir / name / description constraints and case-folded dedupe', () => {
    const base = { ...validManifest, slots: ['tool', 'skill'] };
    const item = (patch: Record<string, unknown>) =>
      validateGhostManifest({
        ...base,
        skill: { items: [{ dir: 'skills/foo', name: 'foo', description: 'x', ...patch }] },
      });
    // dir:必须是包内安全相对路径
    expect(item({ dir: '../evil' }).ok).toBe(false);
    expect(item({ dir: '/abs/path' }).ok).toBe(false);
    expect(item({ dir: 'skills\\foo' }).ok).toBe(false);
    expect(item({ dir: 'skills/./foo' }).ok).toBe(false);
    expect(item({ dir: '' }).ok).toBe(false);
    // name:小写字母数字单连字符分段(链接名 <id>--<name> 的无歧义前提)
    expect(item({ name: 'foo-bar' }).ok).toBe(true);
    expect(item({ name: 'Foo' }).ok).toBe(false);
    expect(item({ name: '-foo' }).ok).toBe(false);
    expect(item({ name: 'foo-' }).ok).toBe(false);
    expect(item({ name: 'foo--bar' }).ok).toBe(false);
    expect(item({ name: '' }).ok).toBe(false);
    expect(item({ name: 'a'.repeat(65) }).ok).toBe(false);
    expect(item({ name: 'a'.repeat(64) }).ok).toBe(true);
    // description:1–1024 非空
    expect(item({ description: '' }).ok).toBe(false);
    expect(item({ description: '   ' }).ok).toBe(false);
    expect(item({ description: 'x'.repeat(1025) }).ok).toBe(false);
    expect(item({ description: 'x'.repeat(1024) }).ok).toBe(true);
    expect(item({ description: 42 }).ok).toBe(false);
    // name/dir 大小写折叠去重(win32 文件系统折叠大小写)
    expect(
      validateGhostManifest({
        ...base,
        skill: {
          items: [
            { dir: 'skills/a', name: 'foo', description: 'x' },
            { dir: 'skills/b', name: 'foo', description: 'y' },
          ],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复 name') });
    expect(
      validateGhostManifest({
        ...base,
        skill: {
          items: [
            { dir: 'skills/A', name: 'foo', description: 'x' },
            { dir: 'skills/a', name: 'bar', description: 'y' },
          ],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复 dir') });
  });

  it('accepts a top-level manual index without requiring a slot', () => {
    const items = [
      {
        dir: 'manual/getting-started',
        name: 'getting-started',
        description: '按需读取的入门工作流',
      },
    ];
    const result = validateGhostManifest({ ...validManifest, manual: { items } });
    expect(result).toMatchObject({
      ok: true,
      manifest: {
        slots: ['tool'],
        manual: { items },
      },
    });
  });

  it('enforces manual items shape, limits, and case-folded dedupe', () => {
    const item = (patch: Record<string, unknown>) =>
      validateGhostManifest({
        ...validManifest,
        manual: {
          items: [
            {
              dir: 'manual/getting-started',
              name: 'getting-started',
              description: 'x',
              ...patch,
            },
          ],
        },
      });

    expect(validateGhostManifest({ ...validManifest, manual: { items: [] } }).ok).toBe(false);
    expect(validateGhostManifest({ ...validManifest, manual: {} }).ok).toBe(false);
    expect(validateGhostManifest({ ...validManifest, manual: { items: [], extra: true } }).ok).toBe(
      false,
    );
    expect(item({ extra: true }).ok).toBe(false);
    const nine = Array.from({ length: 9 }, (_, index) => ({
      dir: `manual/unit-${index}`,
      name: `unit-${index}`,
      description: 'x',
    }));
    expect(validateGhostManifest({ ...validManifest, manual: { items: nine } })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('最多 8 条'),
    });

    expect(item({ dir: '../manual' }).ok).toBe(false);
    expect(item({ dir: 'manual\\guide' }).ok).toBe(false);
    expect(item({ name: 'GettingStarted' }).ok).toBe(false);
    expect(item({ name: 'getting--started' }).ok).toBe(false);
    expect(item({ name: 'a'.repeat(65) }).ok).toBe(false);
    expect(item({ name: 'a'.repeat(64) }).ok).toBe(true);
    expect(item({ description: '' }).ok).toBe(false);
    expect(item({ description: ' '.repeat(3) }).ok).toBe(false);
    expect(item({ description: 'x'.repeat(301) }).ok).toBe(false);
    expect(item({ description: 'x'.repeat(300) }).ok).toBe(true);

    expect(
      validateGhostManifest({
        ...validManifest,
        manual: {
          items: [
            { dir: 'manual/a', name: 'guide', description: 'x' },
            { dir: 'manual/b', name: 'guide', description: 'y' },
          ],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复 name') });
    expect(
      validateGhostManifest({
        ...validManifest,
        manual: {
          items: [
            { dir: 'manual/A', name: 'guide-a', description: 'x' },
            { dir: 'manual/a', name: 'guide-b', description: 'y' },
          ],
        },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('重复 dir') });
  });

  it('intentionally allows nested manual item directories with distinct logical names', () => {
    const items = [
      { dir: 'manual', name: 'overview', description: 'Overview.' },
      { dir: 'manual/advanced', name: 'advanced', description: 'Advanced topics.' },
    ];

    expect(validateGhostManifest({ ...validManifest, manual: { items } })).toMatchObject({
      ok: true,
      manifest: expect.objectContaining({ manual: { items } }),
    });
  });

  it('rejects manual directories that contain or descend from declared file paths', () => {
    const withManual = (manifest: Record<string, unknown>, dir: string) =>
      validateGhostManifest({
        ...manifest,
        manual: { items: [{ dir, name: 'guide', description: 'Manual guide.' }] },
      });
    const declaredFileCases: Array<{
      label: string;
      manifest: Record<string, unknown>;
      dir: string;
    }> = [
      { label: 'ghost.json', manifest: { ...validManifest }, dir: 'ghost.json' },
      {
        label: 'entry',
        manifest: { ...validManifest, entry: 'manual/entry/main.js' },
        dir: 'manual/entry',
      },
      {
        label: 'icon',
        manifest: { ...validManifest, icon: 'manual/icon/icon.png' },
        dir: 'manual/icon',
      },
      {
        label: 'settingsHtml',
        manifest: { ...validManifest, settingsHtml: 'manual/settings/settings.html' },
        dir: 'manual/settings',
      },
      {
        label: 'panel.html',
        manifest: {
          ...validManifest,
          slots: ['tool', 'panel'],
          panel: { html: 'manual/panel/panel.html', position: 'tab' },
        },
        dir: 'manual/panel',
      },
      {
        label: 'node.entry',
        manifest: {
          ...validManifest,
          slots: ['tool', 'node'],
          node: { entry: 'manual/node/main.cjs', protocol: 'mcp-stdio' },
        },
        dir: 'manual/node',
      },
      {
        label: 'node.entries',
        manifest: {
          ...validManifest,
          slots: ['tool', 'node'],
          node: {
            entry: 'node/main.cjs',
            entries: ['manual/node-extra/child.cjs'],
            protocol: 'mcp-stdio',
          },
        },
        dir: 'manual/node-extra',
      },
    ];

    for (const { label, manifest, dir } of declaredFileCases) {
      expect(withManual(manifest, dir), label).toMatchObject({
        ok: false,
        reason: expect.stringContaining('与插件声明文件路径'),
      });
    }

    expect(
      withManual({ ...validManifest, entry: 'assets/main.js' }, 'assets/main.js/manual'),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件声明文件路径'),
    });
    expect(
      withManual({ ...validManifest, entry: 'Manual/Case/main.js' }, 'manual/case'),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('与插件声明文件路径'),
    });
    expect(withManual({ ...validManifest, entry: 'src/main.js' }, 'manual/guide')).toMatchObject({
      ok: true,
      manifest: expect.objectContaining({
        manual: {
          items: [{ dir: 'manual/guide', name: 'guide', description: 'Manual guide.' }],
        },
      }),
    });
  });

  it('validates card and agent capability details', () => {
    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'card'],
        card: { externalLinks: 'yes' },
      }).ok,
    ).toBe(false);
    expect(
      validateGhostManifest({ ...validManifest, card: { externalLinks: true } }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('未包含 "card"') });
    const normalizedCard = validateGhostManifest({
      ...validManifest,
      slots: ['tool', 'card'],
      card: { externalLinks: false },
    });
    expect(normalizedCard.ok).toBe(true);
    if (normalizedCard.ok) expect(normalizedCard.manifest).not.toHaveProperty('card');

    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'agent'],
        agent: { background: false },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('background: true') });
    const backgroundAgent = validateGhostManifest({
      ...validManifest,
      slots: ['tool', 'agent'],
      agent: { background: true },
    });
    expect(backgroundAgent.ok).toBe(true);
    if (backgroundAgent.ok) expect(backgroundAgent.manifest.agent).toEqual({ background: true });

    for (const [capability, expected] of [
      ['errand', { errand: true }],
      ['schedule', { schedule: true }],
    ] as const) {
      const result = validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'agent'],
        agent: { [capability]: true },
      });
      expect(result.ok, capability).toBe(true);
      if (result.ok) expect(result.manifest.agent).toEqual(expected);
    }

    const sessionMessage = validateGhostManifest({
      ...validManifest,
      minCindyVersion: '1.2.3',
      slots: ['tool', 'agent', 'panel', 'session-context'],
      panel: { html: 'panel.html' },
      agent: { sessionMessage: true },
    });
    expect(sessionMessage.ok).toBe(true);
    if (sessionMessage.ok) {
      expect(sessionMessage.manifest.agent).toEqual({ sessionMessage: true });
    }
    expect(
      validateGhostManifest({
        ...validManifest,
        minCindyVersion: '1.2.3',
        slots: ['tool', 'agent', 'session-context'],
        agent: { sessionMessage: true },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('panel') });
    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'agent'],
        agent: { sessionMessage: true },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('session-context') });
    expect(
      validateGhostManifest({
        ...validManifest,
        slots: ['tool', 'agent', 'panel', 'session-context'],
        panel: { html: 'panel.html' },
        agent: { sessionMessage: true },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('minCindyVersion') });
    expect(
      validateGhostManifest({
        ...validManifest,
        minCindyVersion: '1.2.3',
        slots: ['tool', 'agent', 'session-context'],
        agent: { sessionMessage: 'yes' },
      }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('必须是布尔值') });
  });

  it("panel.position 'tab' 合法;tab 时停靠专属字段(minWidth/defaultFraction)明确拒绝", () => {
    const withPanel = (panel: Record<string, unknown>) => ({
      ...validManifest,
      slots: ['tool', 'panel'],
      panel: { html: 'panel.html', ...panel },
    });

    const tab = validateGhostManifest(withPanel({ position: 'tab' }));
    expect(tab.ok).toBe(true);
    if (tab.ok) expect(tab.manifest.panel?.position).toBe('tab');

    for (const extra of [{ minWidth: 240 }, { defaultFraction: 0.2 }]) {
      const rejected = validateGhostManifest(withPanel({ position: 'tab', ...extra }));
      expect(rejected.ok, JSON.stringify(extra)).toBe(false);
      if (!rejected.ok) expect(rejected.reason).toContain('仅停靠形态');
    }

    // top/bottom 仍收词明确拒绝,野值仍拒。
    const pending = validateGhostManifest(withPanel({ position: 'top' }));
    expect(pending.ok).toBe(false);
    if (!pending.ok) expect(pending.reason).toContain('暂未支持');
    expect(validateGhostManifest(withPanel({ position: 'center' })).ok).toBe(false);
  });
});

describe('cindy 详单:media/text/embed/search 类目与 oneshotModel 校验', () => {
  const base = {
    schemaVersion: GHOST_MANIFEST_SCHEMA_VERSION,
    id: 'cindy-full',
    name: 'Cindy Full',
    version: '1.0.0',
    entry: 'main.js',
    slots: ['cindy'],
  };

  it('接受 media/text/embed 类目并保留', () => {
    const r = validateGhostManifest({
      ...base,
      cindy: { media: ['deposit'], text: ['oneshot'], embed: ['text'] },
    });
    expect(r.ok, r.ok ? '' : String(r.reason)).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.cindy).toEqual({ media: ['deposit'], text: ['oneshot'], embed: ['text'] });
  });

  it('text 与 embed 的动作集各归各(不接受串用)', () => {
    expect(validateGhostManifest({ ...base, cindy: { text: ['text'] } }).ok).toBe(false);
    expect(validateGhostManifest({ ...base, cindy: { embed: ['oneshot'] } }).ok).toBe(false);
  });

  it('接受 search.web 并要求真实工具声明', () => {
    const manifest = {
      ...base,
      slots: ['cindy', 'tool'],
      tools: [{ name: 'search_web', description: 'Search the public web' }],
      cindy: { search: ['web'] },
    };
    const accepted = validateGhostManifest(manifest);
    expect(accepted.ok, accepted.ok ? '' : String(accepted.reason)).toBe(true);
    if (accepted.ok) expect(accepted.manifest.cindy).toEqual({ search: ['web'] });

    expect(validateGhostManifest({ ...base, cindy: { search: ['web'] } }).ok).toBe(false);
    expect(validateGhostManifest({ ...manifest, cindy: { search: ['deep'] } }).ok).toBe(false);
    expect(validateGhostManifest({ ...manifest, cindy: { search: [] } }).ok).toBe(false);
    expect(validateGhostManifest({ ...manifest, cindy: { search: ['web', 'web'] } }).ok).toBe(
      false,
    );
  });

  it('oneshotModel:合法声明落字段;形态非法 / 缺 text.oneshot 单挂 → 拒', () => {
    const ok = validateGhostManifest({
      ...base,
      cindy: { text: ['oneshot'], oneshotModel: 'codex/gpt-5.5' },
    });
    expect(ok.ok, ok.ok ? '' : String(ok.reason)).toBe(true);
    if (ok.ok)
      expect(ok.manifest.cindy).toEqual({ text: ['oneshot'], oneshotModel: 'codex/gpt-5.5' });

    for (const bad of [
      { text: ['oneshot'], oneshotModel: '' },
      { text: ['oneshot'], oneshotModel: '   ' },
      { text: ['oneshot'], oneshotModel: 42 },
      { text: ['oneshot'], oneshotModel: 'x'.repeat(129) },
      { oneshotModel: 'codex/gpt-5.5' },
      { image: ['generate'], oneshotModel: 'gpt-5.5' },
    ]) {
      const rejected = validateGhostManifest({ ...base, cindy: bad });
      expect(rejected.ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
