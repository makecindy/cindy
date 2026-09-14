import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import {
  claudeLauncherScript,
  extractCodexBinaryFromTarGz,
  legacyManagedBinaryPath,
  pinnedOfficialAssetDescriptor,
  privateBinaryPath,
  runtimeInstallRoot,
  runtimeVersionMatchesPin,
  systemRuntimeVersionSupportsPin,
} from '../linux-runtime-fallback';
import {
  newerStableVersion,
  olderStableVersion,
  PINNED_CLAUDE_VERSION,
  PINNED_CODEX_VERSION,
  prereleaseAtPinnedCore,
} from './runtimeVersionFixtures';

const tempDirs: string[] = [];
const describeOnLinuxFileSystem = process.platform === 'win32' ? describe.skip : describe;
const SAMPLE_ASSET_VERSION = '1.2.3';

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tarOctal(value: number, length: number): Buffer {
  return Buffer.from(value.toString(8).padStart(length - 1, '0') + '\0');
}

function singleFileTar(name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  tarOctal(0o755, 8).copy(header, 100);
  tarOctal(content.length, 12).copy(header, 124);
  header[156] = 48;
  header.write('ustar\0', 257, 6, 'ascii');
  const padding = Buffer.alloc(Math.ceil(content.length / 512) * 512 - content.length);
  return Buffer.concat([header, content, padding, Buffer.alloc(1024)]);
}

describe('runtimeVersionMatchesPin', () => {
  it('requires Cindy-managed Claude and Codex binaries to match their pins exactly', () => {
    expect(runtimeVersionMatchesPin('claude-code', `${PINNED_CLAUDE_VERSION} (Claude Code)`)).toBe(true);
    expect(
      runtimeVersionMatchesPin(
        'claude-code',
        `${olderStableVersion(PINNED_CLAUDE_VERSION)} (Claude Code)`,
      ),
    ).toBe(false);
    expect(runtimeVersionMatchesPin('codex', `codex-cli ${PINNED_CODEX_VERSION}`)).toBe(true);
    expect(
      runtimeVersionMatchesPin('codex', `codex-cli ${olderStableVersion(PINNED_CODEX_VERSION)}`),
    ).toBe(false);
  });

  it('rejects empty or unparsable version output', () => {
    expect(runtimeVersionMatchesPin('claude-code', '')).toBe(false);
    expect(runtimeVersionMatchesPin('codex', 'development build')).toBe(false);
  });
});

describe('systemRuntimeVersionSupportsPin', () => {
  it('accepts the pinned or newer Claude runtime and rejects older or prerelease-equivalent builds', () => {
    const newerVersion = newerStableVersion(PINNED_CLAUDE_VERSION);
    expect(
      systemRuntimeVersionSupportsPin('claude-code', `${PINNED_CLAUDE_VERSION} (Claude Code)`),
    ).toBe(true);
    expect(systemRuntimeVersionSupportsPin('claude-code', `${newerVersion} (Claude Code)`)).toBe(true);
    expect(
      systemRuntimeVersionSupportsPin(
        'claude-code',
        `${olderStableVersion(PINNED_CLAUDE_VERSION)} (Claude Code)`,
      ),
    ).toBe(false);
    expect(
      systemRuntimeVersionSupportsPin('claude-code', prereleaseAtPinnedCore(PINNED_CLAUDE_VERSION)),
    ).toBe(false);
    expect(systemRuntimeVersionSupportsPin('claude-code', `${newerVersion}-beta.1`)).toBe(false);
  });
});

describeOnLinuxFileSystem('install path helpers', () => {
  it('places pinned private binaries under userData/agent-runtime/<kind>/bin', () => {
    expect(runtimeInstallRoot('/userdata', 'codex')).toBe(path.join('/userdata', 'agent-runtime', 'codex'));
    expect(runtimeInstallRoot('/userdata', 'claude-code')).toBe(
      path.join('/userdata', 'agent-runtime', 'claude-code'),
    );
    expect(privateBinaryPath('/userdata', 'codex')).toBe(
      path.join('/userdata', 'agent-runtime', 'codex', 'bin', 'codex'),
    );
    expect(privateBinaryPath('/userdata', 'claude-code')).toBe(
      path.join('/userdata', 'agent-runtime', 'claude-code', 'bin', 'claude'),
    );
  });

  it('resolves the exact legacy CDN cache path for migration', () => {
    expect(legacyManagedBinaryPath('/userdata', 'claude-code')).toBe(
      path.join('/userdata', 'claude-code', PINNED_CLAUDE_VERSION, 'claude'),
    );
    expect(legacyManagedBinaryPath('/userdata', 'codex')).toBe(
      path.join('/userdata', 'codex', PINNED_CODEX_VERSION, 'codex'),
    );
  });

  it('keeps the Node lookup path in a user-managed Claude launcher', () => {
    const script = claudeLauncherScript('/home/user/.npm/bin/claude', '/home/user/.nvm/bin');
    expect(script).toContain("NODE_BIN_DIR='/home/user/.nvm/bin'");
    expect(script).toContain('export PATH="$NODE_BIN_DIR${PATH:+:$PATH}"');
    expect(script).toContain("exec '/home/user/.npm/bin/claude' \"$@\"");
  });
});

describe('official asset descriptors', () => {
  // arch 显式传入而非依赖宿主:同一套断言要在 x64 与 aarch64 构建机上都成立。
  it.each([
    ['x64', 'linux-x64'],
    ['arm64', 'linux-arm64'],
  ])('uses the trusted Claude %s asset committed with the version pin', (arch, platformKey) => {
    const sha256 = 'a'.repeat(64);
    const url = `https://downloads.claude.ai/claude-code-releases/${SAMPLE_ASSET_VERSION}/${platformKey}/claude`;
    expect(pinnedOfficialAssetDescriptor('claude-code', SAMPLE_ASSET_VERSION, {
      runtimeAssets: { [platformKey]: { url, sha256, size: 123 } },
    }, arch)).toEqual({ url, sha256, size: 123 });
  });

  it.each([
    ['x64', 'linux-x64', 'x86_64'],
    ['arm64', 'linux-arm64', 'aarch64'],
  ])('uses the pinned Codex %s asset and rejects unexpected metadata', (arch, platformKey, rustArch) => {
    const sha256 = 'b'.repeat(64);
    const url = `https://github.com/openai/codex/releases/download/rust-v${SAMPLE_ASSET_VERSION}/codex-${rustArch}-unknown-linux-musl.tar.gz`;
    expect(pinnedOfficialAssetDescriptor('codex', SAMPLE_ASSET_VERSION, {
      runtimeAssets: { [platformKey]: { url, sha256, size: 456 } },
    }, arch)).toEqual({ url, sha256, size: 456 });
    expect(() => pinnedOfficialAssetDescriptor('codex', SAMPLE_ASSET_VERSION, {
      runtimeAssets: { [platformKey]: { url: 'https://example.test/codex.tar.gz', sha256 } },
    }, arch)).toThrow(
      new RegExp(`pin lacks a trusted ${platformKey} asset`),
    );
  });

  // 跨架构混淆是这条链路最危险的失败模式:pin 里只有另一个 arch 的资产时必须
  // 抛错,绝不能退回宿主跑不了的二进制(下载会因 SHA 命中而"成功",故障要到
  // 执行时才暴露)。
  it('refuses a pin that only carries the other architecture', () => {
    const sha256 = 'c'.repeat(64);
    const x64Pin = {
      runtimeAssets: {
        'linux-x64': {
          url: `https://downloads.claude.ai/claude-code-releases/${SAMPLE_ASSET_VERSION}/linux-x64/claude`,
          sha256,
        },
      },
    };
    expect(() => pinnedOfficialAssetDescriptor('claude-code', SAMPLE_ASSET_VERSION, x64Pin, 'arm64')).toThrow(
      /pin lacks a trusted linux-arm64 asset/,
    );
  });

  // 未知 arch 走 fail closed:URL 拼出来必然与 pin 不等,不做兜底猜测。
  it('rejects an unsupported architecture instead of guessing', () => {
    const sha256 = 'd'.repeat(64);
    expect(() => pinnedOfficialAssetDescriptor('codex', SAMPLE_ASSET_VERSION, {
      runtimeAssets: { 'linux-armv7l': { url: 'https://example.test/codex.tar.gz', sha256 } },
    }, 'armv7l')).toThrow(
      /pin lacks a trusted linux-armv7l asset/,
    );
  });
});

describeOnLinuxFileSystem('extractCodexBinaryFromTarGz', () => {
  it('extracts the verified archive binary without a system tar dependency', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-tar-'));
    tempDirs.push(dir);
    const archivePath = path.join(dir, 'codex.tar.gz');
    const destinationPath = path.join(dir, 'bin', 'codex');
    fs.writeFileSync(
      archivePath,
      gzipSync(singleFileTar('codex-x86_64-unknown-linux-musl', Buffer.from('codex-binary'))),
    );

    await extractCodexBinaryFromTarGz(archivePath, destinationPath, 'x64');

    expect(fs.readFileSync(destinationPath, 'utf8')).toBe('codex-binary');
    if (process.platform !== 'win32') {
      expect(fs.statSync(destinationPath).mode & 0o111).not.toBe(0);
    }
  });

  it('extracts the aarch64 archive binary under the arm64 asset name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-tar-arm64-'));
    tempDirs.push(dir);
    const archivePath = path.join(dir, 'codex.tar.gz');
    const destinationPath = path.join(dir, 'bin', 'codex');
    fs.writeFileSync(
      archivePath,
      gzipSync(singleFileTar('codex-aarch64-unknown-linux-musl', Buffer.from('codex-arm64-binary'))),
    );

    await extractCodexBinaryFromTarGz(archivePath, destinationPath, 'arm64');

    expect(fs.readFileSync(destinationPath, 'utf8')).toBe('codex-arm64-binary');
  });

  // 名字不匹配时必须留空:抽错架构的二进制比抽不到更糟。
  it('refuses an archive whose binary belongs to another architecture', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-tar-mismatch-'));
    tempDirs.push(dir);
    const archivePath = path.join(dir, 'codex.tar.gz');
    const destinationPath = path.join(dir, 'bin', 'codex');
    fs.writeFileSync(
      archivePath,
      gzipSync(singleFileTar('codex-x86_64-unknown-linux-musl', Buffer.from('codex-binary'))),
    );

    await expect(
      extractCodexBinaryFromTarGz(archivePath, destinationPath, 'arm64'),
    ).rejects.toThrow(/Codex binary not found/);
    expect(fs.existsSync(destinationPath)).toBe(false);
  });
});
