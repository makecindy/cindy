import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  fingerprintReviewCappedWorkspaceFiles,
  ReviewCappedWorkspaceFingerprintError,
  ReviewCappedWorkspaceFingerprintLimitError,
} from '../reviewCappedWorkspaceFingerprint.js';

const tempDirs: string[] = [];

const canLinkFile = (() => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'review-capped-file-link-probe-'));
  try {
    const target = path.join(root, 'target');
    fsSync.writeFileSync(target, 'probe');
    fsSync.symlinkSync(target, path.join(root, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
})();

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-review-capped-fingerprint-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('capped Review workspace fingerprint', () => {
  it('fully fingerprints same-size content changes', async () => {
    const repoRoot = await makeTempDir();
    const file = path.join(repoRoot, 'large.ts');
    await fs.writeFile(file, 'aaa111zzz');
    const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['large.ts']);

    await fs.writeFile(file, 'aaa222zzz');
    const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['large.ts']);

    expect(after).not.toBe(before);
  });

  it('distinguishes a present file from a deleted capped path', async () => {
    const repoRoot = await makeTempDir();
    const file = path.join(repoRoot, 'deleted.ts');
    await fs.writeFile(file, 'content');
    const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['deleted.ts']);

    await fs.unlink(file);
    const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['deleted.ts']);

    expect(after).not.toBe(before);
  });

  it('never reads sensitive capped paths', async () => {
    const repoRoot = await makeTempDir();
    const sensitive = path.join(repoRoot, '.env.local');
    await fs.writeFile(sensitive, 'TOKEN=first');
    const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['.env.local']);

    await fs.writeFile(sensitive, 'TOKEN=other');
    const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['.env.local']);

    expect(after).toBe(before);
  });

  it('fails closed for traversal and an outside symlink', async () => {
    const repoRoot = await makeTempDir();
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['../outside.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);

    if (!canLinkFile) return;
    const outside = await makeTempDir();
    await fs.writeFile(path.join(outside, 'outside.ts'), 'outside');
    await fs.symlink(path.join(outside, 'outside.ts'), path.join(repoRoot, 'linked.ts'));
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['linked.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);

    await fs.writeFile(path.join(repoRoot, '.env.local'), 'TOKEN=secret');
    await fs.symlink('.env.local', path.join(repoRoot, 'safe-name.ts'));
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['safe-name.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);
  });

  it.skipIf(!canLinkFile)(
    'symlinkMode link-text binds the link text without resolving the target (#2463 review)',
    async () => {
      // 悬空 / 指向仓库外的 symlink 是合法 Git 改动(Git 记录的内容就是链接
      // 文本);resolve 语义下会 fail closed 中止,link-text 语义绑定文本本身。
      const repoRoot = await makeTempDir();
      const link = path.join(repoRoot, 'link.ts');
      await fs.symlink('../shared/lib', link);
      const opts = { symlinkMode: 'link-text' as const };

      const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['link.ts'], opts);
      const again = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['link.ts'], opts);
      expect(again).toBe(before);

      await fs.unlink(link);
      await fs.symlink('../shared/other', link);
      const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['link.ts'], opts);
      expect(after).not.toBe(before);
    },
  );

  // symlink-platform-skip: Windows cannot represent a symlink target containing arbitrary non-UTF-8 bytes.
  it.skipIf(process.platform === 'win32')(
    'symlinkMode link-text distinguishes non-UTF-8 target bytes (#2463 review)',
    async () => {
      // readlink 默认按 UTF-8 解码,0xff / 0xfe 等非法字节都坍缩成替换字符:
      // 原始字节不同的两个链接文本必须产生不同指纹。
      const repoRoot = await makeTempDir();
      const link = path.join(repoRoot, 'raw-link');
      const opts = { symlinkMode: 'link-text' as const };

      await fs.symlink(Buffer.from([0x2e, 0x2e, 0x2f, 0xff]), link);
      const withFf = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['raw-link'], opts);
      await fs.unlink(link);
      await fs.symlink(Buffer.from([0x2e, 0x2e, 0x2f, 0xfe]), link);
      const withFe = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['raw-link'], opts);

      expect(withFe).not.toBe(withFf);
    },
  );

  it.skipIf(!canLinkFile)(
    'symlinkMode link-text never reads target bytes (#2463 review)',
    async () => {
      // 指向敏感文件的链接:只绑定文本,目标内容变化不得进入指纹 ——
      // 反证目标字节从未被读取。
      const repoRoot = await makeTempDir();
      const sensitive = path.join(repoRoot, '.env.local');
      await fs.writeFile(sensitive, 'TOKEN=first');
      await fs.symlink('.env.local', path.join(repoRoot, 'safe-name.ts'));
      const opts = { symlinkMode: 'link-text' as const };

      const before = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['safe-name.ts'], opts);
      await fs.writeFile(sensitive, 'TOKEN=other-value');
      const after = await fingerprintReviewCappedWorkspaceFiles(repoRoot, ['safe-name.ts'], opts);

      expect(after).toBe(before);
    },
  );

  it('fails closed instead of degrading to metadata above the byte limit', async () => {
    const repoRoot = await makeTempDir();
    await fs.writeFile(path.join(repoRoot, 'large.ts'), '1234');

    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['large.ts'], { maxTotalBytes: 3 }),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintLimitError);
  });
});

describe('git 路径词法校验的平台语义 (#2463 review)', () => {
  it.skipIf(process.platform === 'win32')(
    'accepts POSIX filenames containing backslashes (C:\\notes, dir\\..\\file)',
    async () => {
      // 反斜杠在 POSIX 上是普通文件名字符,git 会原样输出 —— 不能按 win32
      // 语义误判为绝对路径/越界而中止 Review。
      const repoRoot = await makeTempDir();
      await fs.writeFile(path.join(repoRoot, 'C:\\notes'), 'a');
      await fs.writeFile(path.join(repoRoot, 'dir\\..\\file'), 'b');

      await expect(
        fingerprintReviewCappedWorkspaceFiles(repoRoot, ['C:\\notes', 'dir\\..\\file']),
      ).resolves.toBeTruthy();
    },
  );

  it('still rejects "/"-separated parent traversal and absolute paths', async () => {
    const repoRoot = await makeTempDir();
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['../escape.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);
    await expect(
      fingerprintReviewCappedWorkspaceFiles(repoRoot, ['/abs.ts']),
    ).rejects.toBeInstanceOf(ReviewCappedWorkspaceFingerprintError);
  });
});
