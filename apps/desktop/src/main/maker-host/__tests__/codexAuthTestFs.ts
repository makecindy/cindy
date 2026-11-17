import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Real shared-login scenarios require file symlinks, not hardlinks (Codex 0.165+).
// Probe the filesystem instead of excluding Windows: privileged Windows and POSIX
// still run those scenarios (including the full Linux unit shards in CI).
// Denied-link behavior is exercised independently by
// codexAuthInvalidation.test.ts and codexAuthLink.test.ts with explicit EPERM input.
export const canLinkFile = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-auth-link-probe-'));
  try {
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'probe');
    fs.symlinkSync(target, path.join(root, 'link'), 'file');
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      return false;
    }
    throw error;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
