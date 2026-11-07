import { describe, expect, it } from 'vitest';
import {
  credentialGuidanceKind,
  missingCredentialRuntime,
} from '../components/settings/customProviderCredentialGuard';

/**
 * 保护 #8693 报的真实行为：apiKey 模式下把 API Key 留空仍能保存，落库的配置
 * 里 `auth` 字段整个缺失（`...(auth ? { auth } : {})`）。下游 pi-host 把缺失
 * 当 `apiKey` 处理、因为没有 key 而静默 `continue`，界面只剩一个灰置的开关。
 *
 * 判据必须与 main 侧 `hasCustomProviderCredential` 一致（authorization /
 * x-api-key 头也算凭据），否则会误挡本来可用的配置。
 */
describe('missingCredentialRuntime', () => {
  const runtime = (over: Record<string, unknown> = {}) => ({
    agent: 'pi' as const,
    apiKey: '',
    headers: [] as { name: string; value: string }[],
    baseUrl: 'http://192.168.1.10:11434/v1',
    keyEdited: true,
    hasStoredKey: false,
    ...over,
  });

  it('flags an apiKey runtime saved with no key and no credential header', () => {
    expect(missingCredentialRuntime('apiKey', [runtime()])).toBe('pi');
  });

  it('accepts a non-empty key', () => {
    expect(missingCredentialRuntime('apiKey', [runtime({ apiKey: 'ollama' })])).toBeUndefined();
  });

  it('treats whitespace as empty', () => {
    expect(missingCredentialRuntime('apiKey', [runtime({ apiKey: '   ' })])).toBe('pi');
  });

  for (const name of ['Authorization', 'authorization', 'X-Api-Key', 'x-api-key']) {
    it(`accepts a credential carried by the ${name} header`, () => {
      expect(
        missingCredentialRuntime('apiKey', [runtime({ headers: [{ name, value: 'Bearer t' }] })]),
      ).toBeUndefined();
    });
  }

  it('ignores a credential header with an empty value', () => {
    expect(
      missingCredentialRuntime('apiKey', [
        runtime({ headers: [{ name: 'authorization', value: '  ' }] }),
      ]),
    ).toBe('pi');
  });

  it('ignores headers that are not credentials', () => {
    expect(
      missingCredentialRuntime('apiKey', [
        runtime({ headers: [{ name: 'x-tenant', value: 'acme' }] }),
      ]),
    ).toBe('pi');
  });

  /** 编辑既有 Provider 时不碰 key 字段：已存的 key 仍然有效，不能误挡保存。 */
  it('accepts an untouched key on an existing provider', () => {
    expect(
      missingCredentialRuntime('apiKey', [runtime({ keyEdited: false, hasStoredKey: true })]),
    ).toBeUndefined();
  });

  it('still flags an existing provider whose stored key was cleared', () => {
    expect(
      missingCredentialRuntime('apiKey', [runtime({ keyEdited: true, hasStoredKey: true })]),
    ).toBe('pi');
  });

  it('does not apply to the none and oauth modes', () => {
    expect(missingCredentialRuntime('none', [runtime()])).toBeUndefined();
    expect(missingCredentialRuntime('oauth', [runtime()])).toBeUndefined();
  });

  it('reports the first offending runtime so the error can focus its field', () => {
    expect(
      missingCredentialRuntime('apiKey', [
        runtime({ agent: 'claude-code', apiKey: 'set' }),
        runtime({ agent: 'codex' }),
      ]),
    ).toBe('codex');
  });

  /**
   * PR #9034 review (P1, greptile + codex):只用 `Authorization` / `x-api-key` 头
   * 鉴权的既有 Provider,头凭证是 main-only 密文 —— `provider:list` 经
   * `withoutProviderHeaderCredentials` 整个剔除 `headerOverride`,表单读不到它。
   * 若不认 main 侧的保留行为,这类 Provider 连改名称/模型都无法保存。
   */
  it('accepts a stored header credential that main preserves on an unchanged edit', () => {
    expect(
      missingCredentialRuntime('apiKey', [runtime({ preservesStoredHeaderCredential: true })]),
    ).toBeUndefined();
  });

  it('still flags a runtime whose stored header credential is not preserved', () => {
    expect(
      missingCredentialRuntime('apiKey', [runtime({ preservesStoredHeaderCredential: false })]),
    ).toBe('pi');
  });

  /**
   * PR #9034 review 第二轮 (P1, codex):`preservesStoredHeaderCredential` 必须由
   * main 侧的存在信号推出,不能只看「端点未变 + 未带 headers」。一个以
   * `auth.method: 'none'` 保存、本就没有任何凭证的 Provider,切到 API Key 而不填
   * Key 时那两个条件都成立,会放行出正是本 PR 要挡的无凭据配置 —— 因为
   * none / oauth 模式下头凭证一律被清除,main 侧无凭证可留。
   *
   * 调用方的判据因此加了 `headersState === 'configured'` 与「上次保存就是 apiKey」
   * 两个条件（与 activeHeadersCanRemainSaved 同口径）。本判据只消费那个布尔,
   * 所以这里断言的是:条件不成立时必须命中。
   */
  it('flags a provider switched from none to apiKey with nothing stored', () => {
    expect(
      missingCredentialRuntime('apiKey', [
        runtime({ preservesStoredHeaderCredential: undefined }),
      ]),
    ).toBe('pi');
  });

  /**
   * PR #9034 review (P2, greptile):保存时同名请求头由后一行覆盖,所以判据要看
   * 合并后的结果。先填有效 Authorization、再填一行同名空值时,最终落库的凭据是空的。
   */
  it('uses the merged headers, so a later empty duplicate wins', () => {
    expect(
      missingCredentialRuntime('apiKey', [
        runtime({
          headers: [
            { name: 'authorization', value: 'Bearer t' },
            { name: 'authorization', value: '' },
          ],
        }),
      ]),
    ).toBe('pi');
  });

  it('accepts a later duplicate that supplies the value', () => {
    expect(
      missingCredentialRuntime('apiKey', [
        runtime({
          headers: [
            { name: 'authorization', value: '' },
            { name: 'authorization', value: 'Bearer t' },
          ],
        }),
      ]),
    ).toBeUndefined();
  });
});

/**
 * 引导分两种：loopback 端点可以直接改选「无鉴权」，局域网/远端不行
 * （`user-provider.ts` 对非 loopback 的 `none` 强制 `disabled: true`），
 * 只能填占位 Key。文案选错会把用户推向一条代码不允许的路。
 */
describe('credentialGuidanceKind', () => {
  it('offers the none mode when every runtime is loopback', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
    ]) {
      expect(credentialGuidanceKind([{ baseUrl: url }])).toBe('loopback');
    }
  });

  it('asks for a placeholder key on non-loopback endpoints', () => {
    for (const url of [
      'http://192.168.1.10:11434/v1',
      'http://10.0.0.5:11434/v1',
      'https://gateway.example.com/v1',
    ]) {
      expect(credentialGuidanceKind([{ baseUrl: url }])).toBe('remote');
    }
  });

  /**
   * PR #9034 review (P2, greptile):鉴权方式对整个 Provider 生效,而
   * `user-provider.ts` 对每个 route 同时检查 baseUrl 与 modelsUrl。只看出问题那个
   * runtime 的 baseUrl 会建议「改选无鉴权」,照做后保存仍被远端地址检查挡住。
   */
  it('refuses the none mode when another runtime is remote', () => {
    expect(
      credentialGuidanceKind([
        { baseUrl: 'http://127.0.0.1:11434/v1' },
        { baseUrl: 'https://gateway.example.com/v1' },
      ]),
    ).toBe('remote');
  });

  it('refuses the none mode when a loopback runtime has a remote modelsUrl', () => {
    expect(
      credentialGuidanceKind([
        { baseUrl: 'http://127.0.0.1:11434/v1', modelsUrl: 'https://registry.example.com/models' },
      ]),
    ).toBe('remote');
  });

  it('accepts a loopback modelsUrl alongside a loopback baseUrl', () => {
    expect(
      credentialGuidanceKind([
        { baseUrl: 'http://127.0.0.1:11434/v1', modelsUrl: 'http://127.0.0.1:11434/v1/models' },
      ]),
    ).toBe('loopback');
  });

  it('falls back to the placeholder-key guidance with no runtimes', () => {
    expect(credentialGuidanceKind([])).toBe('remote');
  });
});
