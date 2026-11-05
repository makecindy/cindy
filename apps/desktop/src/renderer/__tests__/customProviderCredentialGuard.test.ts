import { describe, expect, it } from 'vitest';
import { missingCredentialRuntime } from '../components/settings/customProviderCredentialGuard';

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
});

/**
 * 引导分两种：loopback 端点可以直接改选「无鉴权」，局域网/远端不行
 * （`user-provider.ts` 对非 loopback 的 `none` 强制 `disabled: true`），
 * 只能填占位 Key。文案选错会把用户推向一条代码不允许的路。
 */
describe('missingCredentialRuntime guidance', () => {
  const runtime = (baseUrl: string) => ({
    agent: 'pi' as const,
    apiKey: '',
    headers: [] as { name: string; value: string }[],
    baseUrl,
    keyEdited: true,
    hasStoredKey: false,
  });

  it('offers the none mode for loopback endpoints', async () => {
    const { credentialGuidanceKind } = await import(
      '../components/settings/customProviderCredentialGuard'
    );
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:11434/v1',
      'http://[::1]:11434/v1',
    ]) {
      expect(credentialGuidanceKind(runtime(url).baseUrl)).toBe('loopback');
    }
  });

  it('asks for a placeholder key on non-loopback endpoints', async () => {
    const { credentialGuidanceKind } = await import(
      '../components/settings/customProviderCredentialGuard'
    );
    for (const url of [
      'http://192.168.1.10:11434/v1',
      'http://10.0.0.5:11434/v1',
      'https://gateway.example.com/v1',
    ]) {
      expect(credentialGuidanceKind(runtime(url).baseUrl)).toBe('remote');
    }
  });
});
