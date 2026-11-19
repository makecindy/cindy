import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Match the desktop's capability probes: keep real-link assertions on capable
// hosts, and report Windows privilege failures as a narrow, explicit skip.
// Host CI must exercise real file links; a missing CI capability stays a failure.
export function fileSymlinkSkipReason() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'host-file-symlink-probe-'));
  try {
    const target = path.join(root, 'target');
    fs.writeFileSync(target, 'probe');
    try {
      fs.symlinkSync(target, path.join(root, 'link'), 'file');
    } catch (error) {
      if (process.platform === 'win32' && !process.env.CI && ['EPERM', 'EACCES'].includes(error.code)) {
        return `File symlinks unavailable: Windows denied the capability probe (${error.code})`;
      }
      throw error;
    }
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
