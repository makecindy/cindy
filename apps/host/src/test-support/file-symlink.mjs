import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// engineering-conventions §3.3, as in scripts/__tests__/check-dco.test.mjs:
// probe the actual filesystem, not merely the OS. Host CI runs on all three OSes
// and must exercise the real file-link cases; missing CI capability stays red.
export const fileSymlinkSkipReason = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-file-symlink-probe-'));
  try {
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'synthetic symlink probe');
    fs.symlinkSync(target, path.join(root, 'link'), 'file');
    return false;
  } catch (error) {
    if (process.platform !== 'win32' || process.env.CI
      || !['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error?.code)) throw error;
    return `file symlinks unavailable on this Windows host (${error.code}); exercised in Host CI`;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();
