import { describe, expect, it } from 'vitest';

import { parseMarketSource } from '../../main/plugin-market/sources/parse';
import {
  isPluginMarketCustomIconKey,
  isPluginMarketSourceIdentity,
  pluginMarketFetchAddress,
  pluginMarketRepositoryFromUrl,
  pluginMarketSourceIdentity,
  pluginMarketCustomIconProjectionToken,
  pluginMarketCustomIconSourceToken,
  type MarketSource,
} from '../pluginMarket';

describe('Plugin Market shared contract', () => {
  it('accepts generated custom icon keys and reserves a leading zero', () => {
    expect(isPluginMarketCustomIconKey(`1${'0'.repeat(63)}`)).toBe(true);
    expect(isPluginMarketCustomIconKey(`a${'f'.repeat(63)}`)).toBe(true);
    expect(isPluginMarketCustomIconKey('0'.repeat(64))).toBe(false);
    expect(isPluginMarketCustomIconKey('A'.repeat(64))).toBe(false);
    expect(isPluginMarketCustomIconKey('a'.repeat(63))).toBe(false);
    expect(isPluginMarketCustomIconKey('a'.repeat(65))).toBe(false);
  });

  it('extracts opaque source and projection tokens from the stable key layout', () => {
    const key = `2${'a'.repeat(16)}${'b'.repeat(16)}${'c'.repeat(31)}`;
    expect(pluginMarketCustomIconSourceToken(key)).toBe('a'.repeat(16));
    expect(pluginMarketCustomIconProjectionToken(key)).toBe('b'.repeat(16));
    expect(pluginMarketCustomIconSourceToken('0'.repeat(64))).toBeNull();
    expect(pluginMarketCustomIconProjectionToken('invalid')).toBeNull();
  });
});

/* 测试价值
 * - 生产入口与可观察结果：pluginMarketRepositoryFromUrl（把配置地址或 git 解析出的实际取包地址归约成展示用
 *   仓库）、pluginMarketSourceIdentity（组装进入确认、条目与远程回执的身份）与控制端用的
 *   isPluginMarketSourceIdentity；添加来源的地址先经生产 parseMarketSource 归一。
 * - 依据：PR #12684／#12731 维护者评审（2026-11-25）：目标 Host 生成去敏的仓库身份与不透明来源标识；
 *   credentials-and-local-storage.md：凭证只留在系统 git，不进任何投影。
 * - 现有覆盖缺口：此前没有来源身份投影，来源地址只在 Main 内使用。
 * - 最小失败输入：内嵌令牌、user:pass、query、fragment、端口；手工改坏的配置（非字符串、双向控制符、
 *   百分号编码、`..` 路径段、不合法 ref）；缺来源标识或取包记录。函数新增之前这些用例全部失败。
 * - tier：unit（纯函数，node 环境）。
 */
const SOURCE_ID = 'AbCdEfGhIjKlMnOpQrStUv';

describe('pluginMarketRepositoryFromUrl', () => {
  const added = (input: string) => {
    const parsed = parseMarketSource({ source: input }, '/home/tester');
    if (!parsed.ok || parsed.source.type !== 'git') throw new Error('not a git source');
    return pluginMarketRepositoryFromUrl(parsed.source.url);
  };

  it('names the repository for every Git address form a source can be added with', () => {
    for (const input of [
      'acme/plugins',
      'https://github.com/acme/plugins.git',
      'https://github.com/acme/plugins',
      'https://github.com/acme/plugins/',
      'HTTPS://GitHub.COM/acme/plugins.git',
      'ssh://git@github.com/acme/plugins.git',
      'git@github.com:acme/plugins.git',
    ]) expect(added(input)).toBe('github.com/acme/plugins');
    // Forms git can still fetch from: hand-edited configs and insteadOf rewrites.
    expect(pluginMarketRepositoryFromUrl('git://github.com/acme/plugins.git')).toBe('github.com/acme/plugins');
    expect(pluginMarketRepositoryFromUrl('http://github.com/acme/plugins')).toBe('github.com/acme/plugins');
    expect(added('https://gitlab.example.com/group/sub/plugins.git')).toBe('gitlab.example.com/group/sub/plugins');
  });

  it('never carries credentials, query strings, fragments or ports into the repository', () => {
    for (const url of [
      'https://ghp_SECRET@github.com/acme/plugins.git',
      'https://user:pass@github.com/acme/plugins.git',
      'https://github.com/acme/plugins.git?access_token=SECRET',
      'https://github.com/acme/plugins.git#SECRET',
      'https://github.com:8443/acme/plugins.git',
      'ssh://git@github.com:2222/acme/plugins.git',
      'ssh://git:SECRET@github.com/acme/plugins.git',
    ]) {
      const repository = pluginMarketRepositoryFromUrl(url);
      expect(repository).toBe('github.com/acme/plugins');
      expect(JSON.stringify(repository)).not.toMatch(/SECRET|ghp_|user|pass|8443|2222/);
    }
  });

  it('fails closed for addresses it cannot reduce to the repository git really fetches', () => {
    for (const url of [
      '', '   ', 'github.com', 'https://github.com/only-owner', 'https://github.com/a/b/c/d/e',
      // URL parsing would normalise these into a different path than the one git requests.
      'https://github.com/acme/x/../plugins', 'https://github.com/acme/./plugins', 'https://github.com/acme/x/%2e%2e/plugins',
      'https://github.com/acme/plu%67ins.git', 'https://github.com//acme/plugins',
      // Parsers disagree on the host in these.
      'https://github.com\\@evil.test/acme/plugins', 'https://a@evil.test@github.com/acme/plugins',
      'https://exa mple.com/acme/plugins', 'https://[::1]/acme/plugins', 'https://bad_host.test/acme/plugins',
      'git@github.com:/acme/plugins.git', 'github.com:acme/plugins', 'git@github.com/acme/plugins',
      'file:///home/tester/plugins', '/home/tester/plugins', 'not a url at all',
      'https://github.com/acme/plugins\u202e.git', 'https://github.com/acme/plug\u200bins',
      `https://${'a'.repeat(250)}.com/acme/plugins`,
    ]) expect(pluginMarketRepositoryFromUrl(url)).toBeNull();
    expect(pluginMarketRepositoryFromUrl(42)).toBeNull();
  });
});

describe('pluginMarketFetchAddress', () => {
  // Parts that feed the source id: scheme, host and port distinguish endpoints; credentials never appear.
  it('keeps the endpoint parts that tell sources apart and drops credentials', () => {
    expect(pluginMarketFetchAddress('https://ghp_SECRET@Git.Example.test:8443/acme/plugins.git?x=1#y'))
      .toEqual({ scheme: 'https', user: '', host: 'git.example.test', port: '8443', path: '/acme/plugins.git' });
    // SSH login users are part of the source (same host and path can resolve per user); https userinfo is a
    // credential and is never read.
    expect(pluginMarketFetchAddress('ssh://deploy@git.example.test:2222/acme/plugins.git'))
      .toEqual({ scheme: 'ssh', user: 'deploy', host: 'git.example.test', port: '2222', path: '/acme/plugins.git' });
    expect(pluginMarketFetchAddress('git@git.example.test:acme/plugins.git'))
      .toEqual({ scheme: 'scp', user: 'git', host: 'git.example.test', port: '', path: 'acme/plugins.git' });
    expect(pluginMarketFetchAddress('ssh://git:SECRET@git.example.test/acme/plugins.git')).toMatchObject({ user: 'git' });
    expect(JSON.stringify(pluginMarketFetchAddress('ssh://git:SECRET@git.example.test/acme/plugins.git'))).not.toContain('SECRET');
    // Paths the display identity rejects (e.g. a `.github` repository) still identify a source.
    expect(pluginMarketFetchAddress('https://github.com/acme/.github')).toMatchObject({ path: '/acme/.github' });
    expect(pluginMarketRepositoryFromUrl('https://github.com/acme/.github')).toBeNull();
    for (const url of ['file:///home/tester/plugins', 'https://github.com/', 'https://a@b@github.com/acme/plugins', 42]) {
      expect(pluginMarketFetchAddress(url)).toBeNull();
    }
  });
});

describe('pluginMarketSourceIdentity', () => {
  const git = (extra: Record<string, unknown> = {}) =>
    ({ type: 'git', url: 'https://origin.example.test/acme/plugins.git', sparsePaths: [], ...extra }) as unknown as MarketSource;
  const facts = { sourceId: SOURCE_ID, fetchedRepository: 'mirror.example.test/tenant/plugins' };

  it('shows the repository git actually fetched from, not the configured address', () => {
    expect(pluginMarketSourceIdentity(git(), facts))
      .toEqual({ kind: 'git', repository: 'mirror.example.test/tenant/plugins', sourceId: SOURCE_ID });
    expect(pluginMarketSourceIdentity(git({ ref: 'release/2026' }), facts))
      .toEqual({ kind: 'git', repository: 'mirror.example.test/tenant/plugins', ref: 'release/2026', sourceId: SOURCE_ID });
  });

  it('marks a local folder market by kind and source id only, without its path', () => {
    const identity = pluginMarketSourceIdentity({ type: 'local', path: '/home/tester/Projects/market' },
      { sourceId: SOURCE_ID, fetchedRepository: null });
    expect(identity).toEqual({ kind: 'local', sourceId: SOURCE_ID });
    expect(JSON.stringify(identity)).not.toContain('Projects');
  });

  it('yields no identity when any part cannot be produced or verified', () => {
    // No source id (key unavailable) or a malformed one.
    expect(pluginMarketSourceIdentity(git(), { ...facts, sourceId: null })).toBeNull();
    expect(pluginMarketSourceIdentity(git(), { ...facts, sourceId: 'short' })).toBeNull();
    // No verified fetch record for this cache version, or a malformed one.
    expect(pluginMarketSourceIdentity(git(), { ...facts, fetchedRepository: null })).toBeNull();
    expect(pluginMarketSourceIdentity(git(), { ...facts, fetchedRepository: 'https://ghp_SECRET@x.test/a/b' })).toBeNull();
    // git still fetches a configured ref, so an invalid one yields no identity instead of a ref-less one.
    for (const ref of [42, '--upload-pack=evil', 'main branch', '../main', `a${'b'.repeat(128)}`]) {
      expect(pluginMarketSourceIdentity(git({ ref }), facts)).toBeNull();
    }
    // An unset ref (absent key as stored by the add dialog; null or empty as git treats them) is no ref.
    for (const ref of [undefined, null, '']) {
      expect(pluginMarketSourceIdentity(git({ ref }), facts))
        .toEqual({ kind: 'git', repository: 'mirror.example.test/tenant/plugins', sourceId: SOURCE_ID });
    }
    expect(pluginMarketSourceIdentity({ type: 'svn' } as unknown as MarketSource, facts)).toBeNull();
  });

  it('accepts only the contract shape when a controller validates a received identity', () => {
    for (const valid of [
      { kind: 'git', repository: 'github.com/acme/plugins', sourceId: SOURCE_ID },
      { kind: 'git', repository: 'github.com/acme/plugins', ref: 'main', sourceId: SOURCE_ID },
      { kind: 'local', sourceId: SOURCE_ID },
    ]) expect(isPluginMarketSourceIdentity(valid)).toBe(true);
    for (const invalid of [
      null, 'github.com/acme/plugins', { kind: 'local' }, { kind: 'git', repository: 'github.com/acme/plugins' },
      { kind: 'git', repository: 'github.com/acme', sourceId: SOURCE_ID },
      { kind: 'git', repository: 'github.com/acme/plugins', sourceId: `${SOURCE_ID}=` },
      { kind: 'git', repository: 'github.com/acme/plugins', url: 'https://github.com/acme/plugins', sourceId: SOURCE_ID },
      { kind: 'git', repository: 'github.com/acme/plugins', ref: 7, sourceId: SOURCE_ID },
      { kind: 'local', path: '/home/tester/market', sourceId: SOURCE_ID },
    ]) expect(isPluginMarketSourceIdentity(invalid)).toBe(false);
  });
});
