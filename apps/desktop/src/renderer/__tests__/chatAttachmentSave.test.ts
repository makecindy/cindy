import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  isAttachmentUnsupportedOnPlatform,
  isSafetyDowngradedAttachment,
  saveChatAttachmentWithToasts,
  type ChatAttachmentSaveDeps,
} from '../lib/chatAttachmentSave';

function makeDeps(overrides: Partial<ChatAttachmentSaveDeps> = {}): ChatAttachmentSaveDeps {
  return {
    platform: 'win32',
    fetchRemoteFile: vi.fn(async () => 'C:\\cache\\remote.bin'),
    saveAs: vi.fn(async () => ({
      status: 'saved' as const,
      savedPath: 'C:\\Downloads\\setup.exe',
    })),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe('safe attachment routing', () => {
  it('only treats a mismatched .bin materialization as safety-downgraded', () => {
    expect(isSafetyDowngradedAttachment({ name: 'setup.exe', path: 'C:\\cache\\random.bin' })).toBe(
      true,
    );
    expect(isSafetyDowngradedAttachment({ name: 'archive.zip', path: '/cache/random.BIN' })).toBe(
      true,
    );
    expect(isSafetyDowngradedAttachment({ name: 'raw.bin', path: '/cache/random.bin' })).toBe(
      false,
    );
    expect(isSafetyDowngradedAttachment({ name: 'report.pdf', path: '/cache/report.pdf' })).toBe(
      false,
    );
  });

  it('detects known macOS/Windows/Linux incompatibilities deterministically', () => {
    expect(isAttachmentUnsupportedOnPlatform('setup.exe', 'darwin')).toBe(true);
    expect(isAttachmentUnsupportedOnPlatform('setup.exe', 'win32')).toBe(false);
    expect(isAttachmentUnsupportedOnPlatform('installer.dmg', 'win32')).toBe(true);
    expect(isAttachmentUnsupportedOnPlatform('installer.dmg', 'darwin')).toBe(false);
    expect(isAttachmentUnsupportedOnPlatform('installer.pkg', 'linux')).toBe(true);
    expect(isAttachmentUnsupportedOnPlatform('tool.jar', 'darwin')).toBe(false);
  });

  it('wires the UserMessage attachment chip to save before the open/preview path', () => {
    const source = readFileSync(
      resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx'),
      'utf8',
    );
    expect(source).toMatch(
      /const downloadOnly = isSafetyDowngradedAttachment\(f\);[\s\S]+if \(downloadOnly\) \{[\s\S]+saveChatAttachmentWithToasts\(sessionFileCtx, f\)[\s\S]+shouldOpenTextLightboxForOrigin/,
    );
    expect(source).toContain('<Download size={14}');
  });
});

describe('saveChatAttachmentWithToasts', () => {
  it('saves a local cache file under the original name and reports success', async () => {
    const deps = makeDeps();
    const result = await saveChatAttachmentWithToasts(
      { origin: { kind: 'local' }, workingDir: 'C:\\work' },
      { name: 'setup.exe', path: 'C:\\cache\\random.bin' },
      deps,
    );
    expect(deps.fetchRemoteFile).not.toHaveBeenCalled();
    expect(deps.saveAs).toHaveBeenCalledWith({
      sourcePath: 'C:\\cache\\random.bin',
      suggestedName: 'setup.exe',
    });
    expect(deps.success).toHaveBeenCalledOnce();
    expect(deps.warning).not.toHaveBeenCalled();
    expect(result).toBe('saved');
  });

  it('fetches a remote copy first and warns when the type is unsupported locally', async () => {
    const deps = makeDeps({ platform: 'darwin' });
    const origin = { kind: 'device' as const, deviceId: 'device-1' };
    const result = await saveChatAttachmentWithToasts(
      { origin, workingDir: '/remote/work' },
      { name: 'setup.exe', path: '/remote/cache/random.bin' },
      deps,
    );
    expect(deps.fetchRemoteFile).toHaveBeenCalledWith(
      origin,
      '/remote/work',
      '/remote/cache/random.bin',
    );
    expect(deps.saveAs).toHaveBeenCalledWith({
      sourcePath: 'C:\\cache\\remote.bin',
      suggestedName: 'setup.exe',
    });
    expect(deps.warning).toHaveBeenCalledOnce();
    expect(deps.success).not.toHaveBeenCalled();
    expect(result).toBe('saved');
  });

  it('keeps cancellation silent and maps source/copy failures to user feedback', async () => {
    const canceled = makeDeps({ saveAs: vi.fn(async () => ({ status: 'canceled' as const })) });
    await expect(
      saveChatAttachmentWithToasts(
        { origin: { kind: 'local' }, workingDir: '/work' },
        { name: 'setup.exe', path: '/cache/a.bin' },
        canceled,
      ),
    ).resolves.toBe('canceled');
    expect(canceled.success).not.toHaveBeenCalled();
    expect(canceled.warning).not.toHaveBeenCalled();
    expect(canceled.error).not.toHaveBeenCalled();

    const missing = makeDeps({
      saveAs: vi.fn(async () => ({ status: 'error' as const, code: 'not_found' as const })),
    });
    await saveChatAttachmentWithToasts(
      { origin: { kind: 'local' }, workingDir: '/work' },
      { name: 'setup.exe', path: '/cache/a.bin' },
      missing,
    );
    expect(missing.error).toHaveBeenCalledOnce();

    const copyFailed = makeDeps({
      saveAs: vi.fn(async () => ({ status: 'error' as const, code: 'copy_failed' as const })),
    });
    await saveChatAttachmentWithToasts(
      { origin: { kind: 'local' }, workingDir: '/work' },
      { name: 'setup.exe', path: '/cache/a.bin' },
      copyFailed,
    );
    expect(copyFailed.error).toHaveBeenCalledOnce();
  });
});
