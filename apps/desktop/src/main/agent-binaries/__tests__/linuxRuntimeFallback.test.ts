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

const tempDirs: string[] = [];
const describeOnLinuxFileSystem = process.platform === 'win32' ? describe.skip : describe;

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
    expect(runtimeVersionMatchesPin('claude-code', '2.1.219 (Claude Code)')).toBe(true);
    expect(runtimeVersionMatchesPin('claude-code', '2.1.218 (Claude Code)')).toBe(false);
    expect(runtimeVersionMatchesPin('codex', 'codex-cli 0.145.0')).toBe(true);
    expect(runtimeVersionMatchesPin('codex', 'codex-cli 0.144.6')).toBe(false);
  });

  it('rejects empty or unparsable version output', () => {
    expect(runtimeVersionMatchesPin('claude-code', '')).toBe(false);
    expect(runtimeVersionMatchesPin('codex', 'development build')).toBe(false);
  });
});

describe('systemRuntimeVersionSupportsPin', () => {
  it('accepts the pinned or newer Claude runtime and rejects older or prerelease-equivalent builds', () => {
    expect(systemRuntimeVersionSupportsPin('claude-code', '2.1.219 (Claude Code)')).toBe(true);
    expect(systemRuntimeVersionSupportsPin('claude-code', '2.2.0 (Claude Code)')).toBe(true);
    expect(systemRuntimeVersionSupportsPin('claude-code', '2.1.218 (Claude Code)')).toBe(false);
    expect(systemRuntimeVersionSupportsPin('claude-code', '2.1.219-beta.1')).toBe(false);
    expect(systemRuntimeVersionSupportsPin('claude-code', '2.2.0-beta.1')).toBe(false);
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
      path.join('/userdata', 'claude-code', '2.1.219', 'claude'),
    );
    expect(legacyManagedBinaryPath('/userdata', 'codex')).toBe(
      path.join('/userdata', 'codex', '0.145.0', 'codex'),
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
  it('uses the trusted Claude asset committed with the version pin', () => {
    const sha256 = 'a'.repeat(64);
    expect(pinnedOfficialAssetDescriptor('claude-code', '2.1.219', {
      runtimeAssets: {
        'linux-x64': {
          url: 'https://downloads.claude.ai/claude-code-releases/2.1.219/linux-x64/claude',
          sha256,
          size: 123,
        },
      },
    })).toEqual({
      url: 'https://downloads.claude.ai/claude-code-releases/2.1.219/linux-x64/claude',
      sha256,
      size: 123,
    });
  });

  it('uses the pinned Codex asset and rejects missing or unexpected metadata', () => {
    const sha256 = 'b'.repeat(64);
    const url = 'https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-x86_64-unknown-linux-musl.tar.gz';
    expect(pinnedOfficialAssetDescriptor('codex', '0.144.6', {
      runtimeAssets: { 'linux-x64': { url, sha256, size: 456 } },
    })).toEqual({ url, sha256, size: 456 });
    expect(() => pinnedOfficialAssetDescriptor('codex', '0.144.6', {
      runtimeAssets: { 'linux-x64': { url: 'https://example.test/codex.tar.gz', sha256 } },
    })).toThrow(
      /pin lacks a trusted linux-x64 asset/,
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

    await extractCodexBinaryFromTarGz(archivePath, destinationPath);

    expect(fs.readFileSync(destinationPath, 'utf8')).toBe('codex-binary');
    if (process.platform !== 'win32') {
      expect(fs.statSync(destinationPath).mode & 0o111).not.toBe(0);
    }
  });
});
