/**
 * skillhub/zipPacker.test.ts — zip 打包测试 (F-pub-5, M3)
 *
 * 验证：
 *   - pack 返回 buffer / sha256 / size / manifest
 *   - sha256 与 buffer 内容一致
 *   - 排除规则（高风险 / 平台噪声路径）
 *   - manifest 包含正确的 relPath + size + sha256
 *   - zip 根直接是文件（无顶层目录包裹）
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PackCancelledError, PackTimeoutError, pack } from '../zipPacker';
import JSZip from 'jszip';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillzip-test-'));
}

function writeFile(dir: string, relPath: string, content: Buffer | string): void {
  const fullPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function rmDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = makeTmpDir();
});

afterAll(() => {
  rmDir(tmpDir);
});

describe('skillhub/zipPacker.pack', () => {
  it('returns a PackResult with non-empty buffer', async () => {
    const dir = path.join(tmpDir, 'basic');
    writeFile(dir, 'SKILL.md', Buffer.from('# hello', 'utf8'));

    const result = await pack(dir);
    expect(result.buffer).toBeInstanceOf(Buffer);
    expect(result.buffer.length).toBeGreaterThan(0);
    expect(result.size).toBe(result.buffer.length);
  });

  it('sha256 matches actual buffer sha256', async () => {
    const dir = path.join(tmpDir, 'sha256-check');
    writeFile(dir, 'SKILL.md', Buffer.from('checksum test', 'utf8'));

    const result = await pack(dir);
    const actualSha256 = crypto.createHash('sha256').update(result.buffer).digest('hex');
    expect(result.sha256).toBe(actualSha256);
  });

  it('manifest contains SKILL.md with correct size', async () => {
    const dir = path.join(tmpDir, 'manifest-check');
    const content = Buffer.from('manifest test content', 'utf8');
    writeFile(dir, 'SKILL.md', content);

    const result = await pack(dir);
    const skillMdEntry = result.manifest.files.find((f) => f.relPath === 'SKILL.md');
    expect(skillMdEntry).toBeDefined();
    expect(skillMdEntry!.size).toBe(content.length);
    expect(skillMdEntry!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manifest sha256 matches actual file sha256', async () => {
    const dir = path.join(tmpDir, 'manifest-sha');
    const content = Buffer.from('accurate sha test', 'utf8');
    writeFile(dir, 'SKILL.md', content);

    const result = await pack(dir);
    const entry = result.manifest.files.find((f) => f.relPath === 'SKILL.md');
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    expect(entry!.sha256).toBe(expected);
  });

  it('keeps declared dotfile fixtures in zip and manifest', async () => {
    const dir = path.join(tmpDir, 'include-dot-fixtures');
    writeFile(dir, 'SKILL.md', Buffer.from('visible', 'utf8'));
    writeFile(dir, '.cca-bindings.json', Buffer.from('{"task":"demo"}', 'utf8'));
    writeFile(dir, '.cca-state/task/current-goal.md', Buffer.from('goal', 'utf8'));

    const result = await pack(dir);
    expect(result.manifest.files.map((f) => f.relPath)).toContain('.cca-bindings.json');
    expect(result.manifest.files.map((f) => f.relPath)).toContain('.cca-state/task/current-goal.md');

    const zip = await JSZip.loadAsync(result.buffer);
    expect(zip.file('.cca-bindings.json')).not.toBeNull();
    expect(zip.file('.cca-state/task/current-goal.md')).not.toBeNull();
  });

  it('excludes sensitive dotfiles from zip and manifest', async () => {
    const dir = path.join(tmpDir, 'exclude-sensitive-dotfiles');
    writeFile(dir, 'SKILL.md', Buffer.from('visible', 'utf8'));
    writeFile(dir, '.env', Buffer.from('TOKEN=secret', 'utf8'));
    writeFile(dir, '.env.local', Buffer.from('TOKEN=secret', 'utf8'));
    writeFile(dir, '.envrc', Buffer.from('export TOKEN=secret', 'utf8'));
    writeFile(dir, '.npmrc', Buffer.from('//registry/:_authToken=secret', 'utf8'));
    writeFile(dir, '.netrc', Buffer.from('machine example.com password secret', 'utf8'));
    writeFile(dir, '.pypirc', Buffer.from('[pypi]\npassword=secret', 'utf8'));
    writeFile(dir, '.ssh/id_rsa', Buffer.from('private key', 'utf8'));
    writeFile(dir, '.aws/credentials', Buffer.from('aws_secret_access_key=secret', 'utf8'));
    writeFile(dir, '.docker/config.json', Buffer.from('{"auths":{"example.com":{}}}', 'utf8'));
    writeFile(dir, '.gem/credentials', Buffer.from(':rubygems_api_key: secret', 'utf8'));
    writeFile(
      dir,
      '.config/gcloud/application_default_credentials.json',
      Buffer.from('{"client_secret":"secret"}', 'utf8'),
    );
    writeFile(dir, 'fixtures/.docker/config.json', Buffer.from('{"auths":{"example.com":{}}}', 'utf8'));
    writeFile(dir, 'fixtures/.gem/credentials', Buffer.from(':rubygems_api_key: secret', 'utf8'));
    writeFile(
      dir,
      'fixtures/.config/gcloud/application_default_credentials.json',
      Buffer.from('{"client_secret":"secret"}', 'utf8'),
    );
    writeFile(dir, '.kube/config', Buffer.from('token: secret', 'utf8'));
    writeFile(dir, '.config/gh/hosts.yml', Buffer.from('oauth_token: secret', 'utf8'));
    writeFile(dir, '.azure/accessTokens.json', Buffer.from('[]', 'utf8'));
    writeFile(dir, 'keys/id_ed25519', Buffer.from('private key', 'utf8'));
    writeFile(dir, 'certs/client.pem', Buffer.from('private key', 'utf8'));
    writeFile(dir, '.config/tool/settings.json', Buffer.from('{"fixture":true}', 'utf8'));
    writeFile(dir, '.DS_Store', Buffer.from('metadata', 'utf8'));
    writeFile(dir, 'docs/._README.md', Buffer.from('resource fork', 'utf8'));

    const result = await pack(dir);
    const paths = result.manifest.files.map((f) => f.relPath);
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('.env.local');
    expect(paths).not.toContain('.envrc');
    expect(paths).not.toContain('.npmrc');
    expect(paths).not.toContain('.netrc');
    expect(paths).not.toContain('.pypirc');
    expect(paths).not.toContain('.ssh/id_rsa');
    expect(paths).not.toContain('.aws/credentials');
    expect(paths).not.toContain('.docker/config.json');
    expect(paths).not.toContain('.gem/credentials');
    expect(paths).not.toContain('.config/gcloud/application_default_credentials.json');
    expect(paths).not.toContain('fixtures/.docker/config.json');
    expect(paths).not.toContain('fixtures/.gem/credentials');
    expect(paths).not.toContain('fixtures/.config/gcloud/application_default_credentials.json');
    expect(paths).not.toContain('.kube/config');
    expect(paths).not.toContain('.config/gh/hosts.yml');
    expect(paths).not.toContain('.azure/accessTokens.json');
    expect(paths).not.toContain('keys/id_ed25519');
    expect(paths).not.toContain('certs/client.pem');
    expect(paths).toContain('.config/tool/settings.json');
    expect(paths).not.toContain('.DS_Store');
    expect(paths).not.toContain('docs/._README.md');

    const zip = await JSZip.loadAsync(result.buffer);
    expect(zip.file('.env')).toBeNull();
    expect(zip.file('.env.local')).toBeNull();
    expect(zip.file('.envrc')).toBeNull();
    expect(zip.file('.npmrc')).toBeNull();
    expect(zip.file('.netrc')).toBeNull();
    expect(zip.file('.pypirc')).toBeNull();
    expect(zip.file('.ssh/id_rsa')).toBeNull();
    expect(zip.file('.aws/credentials')).toBeNull();
    expect(zip.file('.docker/config.json')).toBeNull();
    expect(zip.file('.gem/credentials')).toBeNull();
    expect(zip.file('.config/gcloud/application_default_credentials.json')).toBeNull();
    expect(zip.file('fixtures/.docker/config.json')).toBeNull();
    expect(zip.file('fixtures/.gem/credentials')).toBeNull();
    expect(zip.file('fixtures/.config/gcloud/application_default_credentials.json')).toBeNull();
    expect(zip.file('.kube/config')).toBeNull();
    expect(zip.file('.config/gh/hosts.yml')).toBeNull();
    expect(zip.file('.azure/accessTokens.json')).toBeNull();
    expect(zip.file('keys/id_ed25519')).toBeNull();
    expect(zip.file('certs/client.pem')).toBeNull();
    expect(zip.file('.config/tool/settings.json')).not.toBeNull();
    expect(zip.file('.DS_Store')).toBeNull();
    expect(zip.file('docs/._README.md')).toBeNull();
  });

  it('excludes node_modules from zip and manifest', async () => {
    const dir = path.join(tmpDir, 'exclude-nm');
    writeFile(dir, 'SKILL.md', Buffer.from('skill', 'utf8'));
    writeFile(dir, 'node_modules/some-lib/index.js', Buffer.from('module', 'utf8'));

    const result = await pack(dir);
    const nmEntry = result.manifest.files.find((f) => f.relPath.includes('node_modules'));
    expect(nmEntry).toBeUndefined();

    const zip = await JSZip.loadAsync(result.buffer);
    const keys = Object.keys(zip.files);
    expect(keys.some((k) => k.includes('node_modules'))).toBe(false);
  });

  it('excludes .git directory from zip', async () => {
    const dir = path.join(tmpDir, 'exclude-git');
    writeFile(dir, 'SKILL.md', Buffer.from('skill', 'utf8'));
    writeFile(dir, '.git/HEAD', Buffer.from('ref: refs/heads/main', 'utf8'));

    const result = await pack(dir);
    const gitEntry = result.manifest.files.find((f) => f.relPath.includes('.git'));
    expect(gitEntry).toBeUndefined();
  });

  it('zip root has files directly (no top-level directory wrapper)', async () => {
    const dir = path.join(tmpDir, 'no-toplevel');
    writeFile(dir, 'SKILL.md', Buffer.from('# root', 'utf8'));
    writeFile(dir, 'scripts/run.sh', Buffer.from('#!/bin/bash', 'utf8'));

    const result = await pack(dir);
    const zip = await JSZip.loadAsync(result.buffer);

    // SKILL.md should be at root, not under a folder named after dir
    expect(zip.file('SKILL.md')).not.toBeNull();
    expect(zip.file('scripts/run.sh')).not.toBeNull();
  });

  it('manifest files are sorted by relPath', async () => {
    const dir = path.join(tmpDir, 'sorted');
    writeFile(dir, 'z.md', Buffer.from('z', 'utf8'));
    writeFile(dir, 'a.md', Buffer.from('a', 'utf8'));
    writeFile(dir, 'SKILL.md', Buffer.from('skill', 'utf8'));

    const result = await pack(dir);
    const paths = result.manifest.files.map((f) => f.relPath);
    const sorted = [...paths].sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual(sorted);
  });

  it('same input produces same buffer sha256 (deterministic)', async () => {
    const dir1 = path.join(tmpDir, 'det1');
    const dir2 = path.join(tmpDir, 'det2');
    writeFile(dir1, 'SKILL.md', Buffer.from('deterministic', 'utf8'));
    writeFile(dir2, 'SKILL.md', Buffer.from('deterministic', 'utf8'));

    const r1 = await pack(dir1);
    const r2 = await pack(dir2);
    // Same content, different path → only content matters → same sha256
    expect(r1.sha256).toBe(r2.sha256);
  });

  it('打包时刻不进 zip 字节:跨秒界两次 pack 仍同 sha256(条目时间戳已固定)', async () => {
    // 回归背景:JSZip 缺省给条目盖打包瞬间墙钟(DOS 2 秒精度),两次 pack 跨过
    // 秒界即 sha 漂移,上面的 determinism 用例在 CI 上随机红。用假时钟制造
    // 远大于精度的墙钟差,锁住"时间不参与包字节";带子目录层级,覆盖 walk 递归路径。
    const dir1 = path.join(tmpDir, 'clock1');
    const dir2 = path.join(tmpDir, 'clock2');
    for (const dir of [dir1, dir2]) {
      writeFile(dir, 'SKILL.md', Buffer.from('clock-free', 'utf8'));
      writeFile(dir, 'scripts/run.sh', Buffer.from('#!/bin/sh\necho ok\n', 'utf8'));
    }

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-07-30T20:42:59.900Z'));
      const r1 = await pack(dir1);
      vi.setSystemTime(new Date('2026-07-30T20:43:07.100Z'));
      const r2 = await pack(dir2);
      expect(r1.sha256).toBe(r2.sha256);
      expect(r1.manifest.files.map((f) => f.relPath)).toContain('scripts/run.sh');
    } finally {
      vi.useRealTimers();
    }
  });

  it('时区不进 zip 字节:不同 TZ 下两次 pack 仍同 sha256(本地分量构造的条目时间戳)', async () => {
    // zip 的 DOS 时间字段无时区,JSZip 用本地 getters 写分量——固定 UTC 瞬间在
    // 不同时区会写出不同分量。锁住"本地分量构造"后任何时区字节一致。
    // (POSIX Node 运行中改 process.env.TZ 即生效;不生效的平台上两次 pack
    // 同时区,断言退化为原确定性语义,仍成立。)
    const dir1 = path.join(tmpDir, 'tz1');
    const dir2 = path.join(tmpDir, 'tz2');
    for (const dir of [dir1, dir2]) {
      writeFile(dir, 'SKILL.md', Buffer.from('tz-free', 'utf8'));
      writeFile(dir, 'scripts/run.sh', Buffer.from('#!/bin/sh\necho ok\n', 'utf8'));
    }

    const prevTz = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Shanghai';
      const r1 = await pack(dir1);
      process.env.TZ = 'America/New_York';
      const r2 = await pack(dir2);
      expect(r1.sha256).toBe(r2.sha256);
    } finally {
      if (prevTz === undefined) delete process.env.TZ;
      else process.env.TZ = prevTz;
    }
  });

  it('aborts before reading files when the signal is already cancelled', async () => {
    const dir = path.join(tmpDir, 'abort-before-start');
    writeFile(dir, 'SKILL.md', Buffer.from('skill', 'utf8'));
    const controller = new AbortController();
    controller.abort();

    await expect(pack(dir, { signal: controller.signal })).rejects.toBeInstanceOf(PackCancelledError);
  });

  it('enforces timeout inside the packer instead of racing an external promise', async () => {
    const dir = path.join(tmpDir, 'timeout-before-start');
    writeFile(dir, 'SKILL.md', Buffer.from('skill', 'utf8'));
    let now = 1_000;

    await expect(pack(dir, {
      timeoutMs: 0,
      now: () => now++,
    })).rejects.toBeInstanceOf(PackTimeoutError);
  });
});
