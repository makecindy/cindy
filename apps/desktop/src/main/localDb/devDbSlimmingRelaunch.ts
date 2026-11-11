import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEV_RELAUNCH_SIGNAL_ENV = 'XDT_DESKTOP_DEV_RELAUNCH_SIGNAL_FILE';

/** Signals the repository dev runner without launching Electron outside Forge/Vite. */
export function writeDbSlimmingDevRelaunchSignal(
  requestId: string,
  options: { signalPath?: string; tempDir?: string } = {},
): boolean {
  const signalPath = options.signalPath ?? process.env[DEV_RELAUNCH_SIGNAL_ENV];
  if (!signalPath || !path.isAbsolute(signalPath)) return false;

  const tempDir = path.resolve(options.tempDir ?? os.tmpdir());
  const resolvedSignalPath = path.resolve(signalPath);
  const relativePath = path.relative(tempDir, resolvedSignalPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) return false;

  const candidatePath = `${resolvedSignalPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(
      candidatePath,
      `${JSON.stringify({ version: 1, requestId, createdAt: Date.now() })}\n`,
      { mode: 0o600 },
    );
    fs.renameSync(candidatePath, resolvedSignalPath);
    return true;
  } catch {
    fs.rmSync(candidatePath, { force: true });
    return false;
  }
}
