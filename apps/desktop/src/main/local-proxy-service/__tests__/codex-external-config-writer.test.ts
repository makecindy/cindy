import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseToml } from 'smol-toml';

// logger 顶层 import electron 的 app —— 无 electron 的 vitest 环境用轻量替身隔离掉。
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

import {
  previewCodexConfig,
  writeCodexConfig,
} from '../codex-external-config-writer';

const URL = 'http://127.0.0.1:51888';
const TOKEN = 'cindy-local-abcdef';

let dir: string;
let prevCodexHome: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-config-'));
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = dir;
});

afterEach(() => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  rmSync(dir, { recursive: true, force: true });
});

function configPath(): string {
  return path.join(dir, 'config.toml');
}

describe('codex-external-config-writer — preview', () => {
  it('文件不存在:exists=false,无冲突,proposedToml 含 cindy_external,token 只在 export 行', () => {
    const preview = previewCodexConfig(URL, TOKEN);
    expect(preview.exists).toBe(false);
    expect(preview.conflicts).toEqual([]);
    expect(preview.path).toBe(configPath());
    const parsed = parseToml(preview.proposedToml) as Record<string, unknown>;
    expect(parsed.model_provider).toBe('cindy_external');
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.cindy_external).toMatchObject({
      name: 'Cindy',
      base_url: URL,
      wire_api: 'responses',
      env_key: 'CINDY_LOCAL_TOKEN',
    });
    // token 绝不进 TOML;只在给用户复制的 export 行里。
    expect(preview.proposedToml).not.toContain(TOKEN);
    expect(preview.tokenExportLine).toBe(`export CINDY_LOCAL_TOKEN=${TOKEN}`);
  });

  it('已有不同的 model_provider / base_url → 报告冲突项', () => {
    writeFileSync(
      configPath(),
      [
        'model_provider = "openai"',
        '',
        '[model_providers.cindy_external]',
        'base_url = "http://old"',
        'env_key = "OTHER_KEY"',
      ].join('\n'),
      'utf8',
    );
    const preview = previewCodexConfig(URL, TOKEN);
    expect(preview.exists).toBe(true);
    expect(preview.conflicts).toContainEqual({
      key: 'model_provider',
      current: 'openai',
      next: 'cindy_external',
    });
    expect(preview.conflicts).toContainEqual({
      key: 'model_providers.cindy_external.base_url',
      current: 'http://old',
      next: URL,
    });
    expect(preview.conflicts).toContainEqual({
      key: 'model_providers.cindy_external.env_key',
      current: 'OTHER_KEY',
      next: 'CINDY_LOCAL_TOKEN',
    });
  });

  it('已有同值不算冲突', () => {
    writeFileSync(configPath(), `model_provider = "cindy_external"\n`, 'utf8');
    expect(previewCodexConfig(URL, TOKEN).conflicts).toEqual([]);
  });
});

describe('codex-external-config-writer — write（非破坏性 merge）', () => {
  it('新建文件:写入 cindy_external 块 + model_provider,token 不入文件', () => {
    const res = writeCodexConfig(URL);
    expect(res.success).toBe(true);
    const raw = readFileSync(configPath(), 'utf8');
    expect(raw).not.toContain(TOKEN);
    const parsed = parseToml(raw) as Record<string, unknown>;
    expect(parsed.model_provider).toBe('cindy_external');
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    expect(providers.cindy_external).toEqual({
      name: 'Cindy',
      base_url: URL,
      wire_api: 'responses',
      env_key: 'CINDY_LOCAL_TOKEN',
    });
  });

  it('保留其它顶层字段与其它 provider 块,只动 model_provider 与 cindy_external', () => {
    writeFileSync(
      configPath(),
      [
        'model = "gpt-5"',
        'model_provider = "other"',
        '',
        '[model_providers.other]',
        'name = "Other"',
        'base_url = "https://other.example/v1"',
        '',
        '[tui]',
        'theme = "dark"',
      ].join('\n'),
      'utf8',
    );
    const res = writeCodexConfig(URL);
    expect(res.success).toBe(true);
    const parsed = parseToml(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    // 顶层无关字段保留。
    expect(parsed.model).toBe('gpt-5');
    expect(parsed.tui).toEqual({ theme: 'dark' });
    // model_provider 被切到 cindy_external。
    expect(parsed.model_provider).toBe('cindy_external');
    const providers = parsed.model_providers as Record<string, Record<string, unknown>>;
    // 其它 provider 块原样保留。
    expect(providers.other).toEqual({
      name: 'Other',
      base_url: 'https://other.example/v1',
    });
    // cindy_external 块被写入。
    expect(providers.cindy_external).toMatchObject({ base_url: URL, env_key: 'CINDY_LOCAL_TOKEN' });
  });

  it('已有 cindy_external 块的额外字段被保留,只覆盖我们管的四键', () => {
    writeFileSync(
      configPath(),
      [
        '[model_providers.cindy_external]',
        'base_url = "http://stale"',
        'query_params = { foo = "bar" }',
      ].join('\n'),
      'utf8',
    );
    writeCodexConfig(URL);
    const parsed = parseToml(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    const block = (parsed.model_providers as Record<string, Record<string, unknown>>)
      .cindy_external;
    expect(block.base_url).toBe(URL); // 覆盖
    expect(block.query_params).toEqual({ foo: 'bar' }); // 保留额外字段
  });

  it('损坏 TOML → 不覆盖,返回失败', () => {
    writeFileSync(configPath(), 'this is [ not valid toml', 'utf8');
    const res = writeCodexConfig(URL);
    expect(res.success).toBe(false);
    // 原坏文件保持不动。
    expect(readFileSync(configPath(), 'utf8')).toBe('this is [ not valid toml');
  });

  it('空文件视为无配置,可安全新建结构', () => {
    writeFileSync(configPath(), '   \n', 'utf8');
    const res = writeCodexConfig(URL);
    expect(res.success).toBe(true);
    const parsed = parseToml(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
    expect(parsed.model_provider).toBe('cindy_external');
  });

  // POSIX 权限保护(#1666):temp+rename 不得把密文配置放宽成世界可读。Windows 无 POSIX mode 位,跳过。
  const posixIt = process.platform === 'win32' ? it.skip : it;

  posixIt('已有 0600 的配置被改写后仍是 0600(不被 rename 放宽成 0644)', () => {
    writeFileSync(configPath(), 'model = "gpt-5"\n', 'utf8');
    chmodSync(configPath(), 0o600);
    expect(writeCodexConfig(URL).success).toBe(true);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });

  posixIt('已有 0644 的配置沿用其原有 mode(保权限,不擅自收紧也不放宽)', () => {
    writeFileSync(configPath(), 'model = "gpt-5"\n', 'utf8');
    chmodSync(configPath(), 0o644);
    expect(writeCodexConfig(URL).success).toBe(true);
    expect(statSync(configPath()).mode & 0o777).toBe(0o644);
  });

  posixIt('新建文件默认收紧到 0600', () => {
    expect(writeCodexConfig(URL).success).toBe(true);
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});
