import { describe, expect, it } from 'vitest';

import { parseMarketSource } from '../../main/plugin-market/sources/parse';
import {
  isPluginMarketCustomIconKey,
  isPluginMarketSourceIdentity,
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
 * - 生产入口与可观察结果：pluginMarketSourceIdentity 的返回值（原样进入安装确认、市场条目与远程回执），
 *   以及控制端用的 isPluginMarketSourceIdentity；添加来源的地址先经生产 parseMarketSource 归一。
 * - 依据：PR #12684 维护者评审（2026-11-25）要求目标 Host 生成去敏的 host/owner/repo；
 *   credentials-and-local-storage.md：凭证只留在系统 git，不进任何投影。
 * - 现有覆盖缺口：此前没有来源身份投影，来源地址只在 Main 内使用。
 * - 最小失败输入：内嵌令牌、user:pass、query、fragment、端口；手工改坏的 sources.v1.json（非字符串、
 *   双向控制符、百分号编码、`..` 路径段）；新增函数之前这些用例全部失败（函数不存在）。
 * - tier：unit（纯函数，node 环境）。实测耗时：见 PR「验证」。
 */
describe('pluginMarketSourceIdentity', () => {
  const git = (url: string, ref?: string) =>
    pluginMarketSourceIdentity({ type: 'git', url, sparsePaths: [], ...(ref ? { ref } : {}) });
  const added = (input: string, ref?: string) => {
    const parsed = parseMarketSource({ source: input, ...(ref ? { ref } : {}) }, '/home/tester');
    if (!parsed.ok) throw new Error(parsed.code);
    return pluginMarketSourceIdentity(parsed.source);
  };

  it('names the repository for every Git address form a source can be added with', () => {
    const acme = { kind: 'git', repository: 'github.com/acme/plugins' };
    for (const input of [
      'acme/plugins',
      'https://github.com/acme/plugins.git',
      'https://github.com/acme/plugins',
      'https://github.com/acme/plugins/',
      'HTTPS://GitHub.COM/acme/plugins.git',
      'ssh://git@github.com/acme/plugins.git',
      'git@github.com:acme/plugins.git',
    ]) expect(added(input)).toEqual(acme);
    // Hand-edited stored forms that the add dialog does not offer but git still clones.
    expect(git('git://github.com/acme/plugins.git')).toEqual(acme);
    expect(git('http://github.com/acme/plugins')).toEqual(acme);
    expect(added('https://gitlab.example.com/group/sub/plugins.git'))
      .toEqual({ kind: 'git', repository: 'gitlab.example.com/group/sub/plugins' });
    expect(added('acme/plugins', 'release/2026'))
      .toEqual({ kind: 'git', repository: 'github.com/acme/plugins', ref: 'release/2026' });
  });

  it('never carries credentials, query strings, fragments or ports into the identity', () => {
    for (const url of [
      'https://ghp_SECRET@github.com/acme/plugins.git',
      'https://user:pass@github.com/acme/plugins.git',
      'https://github.com/acme/plugins.git?access_token=SECRET',
      'https://github.com/acme/plugins.git#SECRET',
      'https://github.com:8443/acme/plugins.git',
      'ssh://git@github.com:2222/acme/plugins.git',
      'ssh://git:SECRET@github.com/acme/plugins.git',
    ]) {
      const identity = git(url);
      expect(identity).toEqual({ kind: 'git', repository: 'github.com/acme/plugins' });
      expect(JSON.stringify(identity)).not.toMatch(/SECRET|ghp_|user|pass|8443|2222/);
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
    ]) expect(git(url)).toBeNull();
    // A stored config is untrusted: wrong value types never leak through or break the shape.
    const stored = (source: unknown) => pluginMarketSourceIdentity(source as MarketSource);
    expect(stored({ type: 'git', url: 42, sparsePaths: [] })).toBeNull();
    expect(stored({ type: 'git', url: 'https://github.com/acme/plugins', ref: 42, sparsePaths: [] }))
      .toEqual({ kind: 'git', repository: 'github.com/acme/plugins' });
    expect(git('https://github.com/acme/plugins.git', '--upload-pack=evil'))
      .toEqual({ kind: 'git', repository: 'github.com/acme/plugins' });
    expect(stored({ type: 'svn', url: 'https://github.com/acme/plugins' })).toBeNull();
  });

  it('marks a local folder market by kind only, without its path', () => {
    const identity = added('~/Projects/market');
    expect(identity).toEqual({ kind: 'local' });
    expect(JSON.stringify(identity)).not.toContain('Projects');
  });

  it('accepts only the contract shape when a controller validates a received identity', () => {
    for (const valid of [
      git('https://github.com/acme/plugins'), git('https://github.com/acme/plugins', 'main'), { kind: 'local' },
    ]) expect(isPluginMarketSourceIdentity(valid)).toBe(true);
    for (const invalid of [
      null, 'github.com/acme/plugins', { kind: 'git' }, { kind: 'git', repository: 'github.com/acme' },
      { kind: 'git', repository: 'github.com/acme/plugins', url: 'https://github.com/acme/plugins' },
      { kind: 'git', repository: 'github.com/acme/plugins', ref: 7 },
      { kind: 'local', path: '/home/tester/market' },
    ]) expect(isPluginMarketSourceIdentity(invalid)).toBe(false);
  });
});
