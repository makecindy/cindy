import { describe, expect, it } from 'vitest';
import {
  assertProductionGitGate,
  assertPublicEnv,
  formatBakedEnvLines,
  parseArgs,
  SELF_HOST_PUBLIC_ENV_KEYS,
} from '../../scripts/release-lib.mjs';

/** 造一个只认预置命令的 git 替身,build 脚本闸门单测不碰真实仓库。 */
function fakeGit(overrides: Partial<Record<string, string>> = {}) {
  const outputs: Record<string, string> = {
    'rev-parse --abbrev-ref HEAD': 'main',
    'status --porcelain': '',
    'rev-parse HEAD': 'a'.repeat(40),
    'rev-parse origin/main': 'a'.repeat(40),
    ...overrides,
  };
  return (args: string[]) => {
    const key = args.join(' ');
    const out = outputs[key];
    if (out == null) throw new Error(`unexpected git ${key}`);
    return out;
  };
}

describe('release-lib parseArgs', () => {
  it('camelCases kebab-case keys used by the build scripts', () => {
    expect(
      parseArgs([
        'positional',
        '--region', 'cn',
        '--version-code=42',
        '--desktop-version', '1.2.3',
        '--skip-git-gate',
        '--execute',
      ]),
    ).toEqual({
      _: ['positional'],
      region: 'cn',
      versionCode: '42',
      desktopVersion: '1.2.3',
      skipGitGate: true,
      execute: true,
    });
  });

  it('treats a trailing flag and `--` separator like ci-fingerprint parsing', () => {
    expect(parseArgs(['--', '--out'])).toEqual({ _: [], out: true });
    expect(parseArgs(['--out', 'dist', '--execute'])).toEqual({ _: [], out: 'dist', execute: true });
  });
});

describe('release-lib assertProductionGitGate', () => {
  it('passes on main + clean + HEAD synced with origin/main', () => {
    expect(assertProductionGitGate({ git: fakeGit() })).toEqual({
      branch: 'main',
      head: 'a'.repeat(40),
    });
  });

  it('rejects non-main branches', () => {
    expect(() =>
      assertProductionGitGate({ git: fakeGit({ 'rev-parse --abbrev-ref HEAD': 'feat/x' }) }),
    ).toThrow('main 分支');
  });

  it('rejects a dirty worktree', () => {
    expect(() =>
      assertProductionGitGate({ git: fakeGit({ 'status --porcelain': ' M app.json' }) }),
    ).toThrow('工作区不干净');
  });

  it('rejects HEAD drift from origin/main', () => {
    expect(() =>
      assertProductionGitGate({ git: fakeGit({ 'rev-parse origin/main': 'b'.repeat(40) }) }),
    ).toThrow('origin/main');
  });
});

describe('release-lib assertPublicEnv', () => {
  const baked = {
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://cdn.example.com',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL:
      'https://cdn-peer.example.com',
    EXPO_PUBLIC_XDT_OTA_SELFHOST: '1',
  };

  it('accepts a complete self-host build env', () => {
    expect(() =>
      assertPublicEnv(baked, { variant: 'production', requiredKeys: SELF_HOST_PUBLIC_ENV_KEYS }),
    ).not.toThrow();
  });

  it('lists every missing or blank required key', () => {
    expect(() =>
      assertPublicEnv(
        { EXPO_PUBLIC_CINDY_AUTH_REGION: ' ' },
        { requiredKeys: SELF_HOST_PUBLIC_ENV_KEYS },
      ),
    ).toThrow(
      'EXPO_PUBLIC_CINDY_AUTH_REGION, EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL, EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL, EXPO_PUBLIC_XDT_OTA_SELFHOST',
    );
  });

  it('rejects a leftover beta variant in production builds', () => {
    expect(() =>
      assertPublicEnv(
        { ...baked, EXPO_PUBLIC_APP_VARIANT: 'beta' },
        { variant: 'production', requiredKeys: SELF_HOST_PUBLIC_ENV_KEYS },
      ),
    ).toThrow('EXPO_PUBLIC_APP_VARIANT=beta');
  });
});

describe('release-lib formatBakedEnvLines', () => {
  it('shows EXPO_PUBLIC_ keys plus explicitly allowed extras only', () => {
    const lines = formatBakedEnvLines(
      {
        EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
        XDT_ANDROID_VERSION_CODE: '42',
        XDT_ANDROID_KEYSTORE_PASSWORD: 'secret',
      },
      { extraKeys: ['XDT_ANDROID_VERSION_CODE'] },
    );
    expect(lines[0]).toContain('baked env');
    expect(lines).toContain('  EXPO_PUBLIC_CINDY_AUTH_REGION=cn');
    expect(lines).toContain('  XDT_ANDROID_VERSION_CODE=42');
    expect(lines.join('\n')).not.toContain('secret');
  });
});
