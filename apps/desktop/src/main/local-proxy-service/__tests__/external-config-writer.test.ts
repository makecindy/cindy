import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  previewExternalConfig,
  writeExternalConfig,
} from '../external-config-writer';

const URL = 'http://127.0.0.1:54321';
const TOKEN = 'cindy-local-abcdef';

let dir: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-cc-config-'));
  prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
  rmSync(dir, { recursive: true, force: true });
});

function settingsPath(): string {
  return path.join(dir, 'settings.json');
}

describe('external-config-writer — preview', () => {
  it('文件不存在:exists=false,无冲突,proposedEnv 含两键', () => {
    const preview = previewExternalConfig(URL, TOKEN);
    expect(preview.exists).toBe(false);
    expect(preview.conflicts).toEqual([]);
    expect(preview.proposedEnv).toEqual({
      ANTHROPIC_BASE_URL: URL,
      ANTHROPIC_API_KEY: TOKEN,
    });
    expect(preview.path).toBe(settingsPath());
  });

  it('已有不同的同名 env 值 → 报告冲突项', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://old', OTHER: 'keep' } }),
      'utf8',
    );
    const preview = previewExternalConfig(URL, TOKEN);
    expect(preview.exists).toBe(true);
    expect(preview.conflicts).toEqual([
      { key: 'ANTHROPIC_BASE_URL', current: 'http://old', next: URL },
    ]);
  });

  it('同名同值不算冲突', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({ env: { ANTHROPIC_BASE_URL: URL } }),
      'utf8',
    );
    expect(previewExternalConfig(URL, TOKEN).conflicts).toEqual([]);
  });
});

describe('external-config-writer — write（非破坏性 merge）', () => {
  it('新建文件:写入 env 两键', () => {
    const res = writeExternalConfig(URL, TOKEN);
    expect(res.success).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_API_KEY: TOKEN });
  });

  it('保留其它顶层字段与其它 env 键,只覆盖两键', () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        model: 'sonnet',
        permissions: { allow: ['Bash'] },
        env: { ANTHROPIC_BASE_URL: 'http://old', MY_FLAG: '1' },
      }),
      'utf8',
    );
    const res = writeExternalConfig(URL, TOKEN);
    expect(res.success).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.model).toBe('sonnet');
    expect(written.permissions).toEqual({ allow: ['Bash'] });
    expect(written.env).toEqual({
      MY_FLAG: '1',
      ANTHROPIC_BASE_URL: URL,
      ANTHROPIC_API_KEY: TOKEN,
    });
  });

  it('损坏 JSON → 不覆盖,返回失败', () => {
    writeFileSync(settingsPath(), '{ not valid json', 'utf8');
    const res = writeExternalConfig(URL, TOKEN);
    expect(res.success).toBe(false);
    // 原坏文件保持不动。
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ not valid json');
  });

  it('env 段不是对象 → 不覆盖,返回失败', () => {
    writeFileSync(settingsPath(), JSON.stringify({ env: 'nope' }), 'utf8');
    const res = writeExternalConfig(URL, TOKEN);
    expect(res.success).toBe(false);
  });

  it('空文件视为无配置,可安全新建结构', () => {
    writeFileSync(settingsPath(), '   \n', 'utf8');
    const res = writeExternalConfig(URL, TOKEN);
    expect(res.success).toBe(true);
    const written = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: URL, ANTHROPIC_API_KEY: TOKEN });
  });
});
