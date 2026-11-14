import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// File.Move's two-argument overload uses a non-replacing Windows move. Unlike
// link + unlink, it consumes the source name in the same filesystem operation.
// Paths are data in the child environment, never interpolated into PowerShell.
const command = `
$ErrorActionPreference = 'Stop'
try {
  [System.IO.File]::Move($env:CINDY_CODEX_MOVE_FROM, $env:CINDY_CODEX_MOVE_TO)
} catch {
  [Console]::Error.WriteLine(($_.Exception.GetBaseException().HResult -band 65535))
  exit 1
}
`;

/** Windows-only, same-directory, no-overwrite move; never creates a hardlink. */
export async function moveCodexAuthFile(source: string, destination: string): Promise<void> {
  if (
    !path.isAbsolute(source) ||
    path.dirname(source) !== path.dirname(destination) ||
    source === destination
  ) {
    throw Object.assign(new Error('Codex auth move requires distinct sibling paths'), {
      code: 'EINVAL',
    });
  }
  const before = await fs.stat(source, { bigint: true });
  // Avoid starting PowerShell for an already-known collision. A cold Windows
  // shell can exhaust its startup budget before reporting EEXIST (CI #10413).
  // lstat also rejects dangling destination symlinks. File.Move remains the
  // atomic no-overwrite authority if a destination appears after this check.
  const destinationExists = await fs.lstat(destination).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw Object.assign(new Error('Codex auth destination is unavailable'), { code: error.code });
    },
  );
  if (destinationExists) {
    throw Object.assign(new Error('Codex auth move failed (EEXIST)'), { code: 'EEXIST' });
  }
  const powershell = path.win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    await exec(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(command, 'utf16le').toString('base64'),
      ],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 4096,
        env: { ...process.env, CINDY_CODEX_MOVE_FROM: source, CINDY_CODEX_MOVE_TO: destination },
      },
    );
  } catch (error) {
    // A child may terminate after the move but before acknowledging it. The
    // consumed source and captured identity still prove the committed result.
    const [remaining, moved] = await Promise.all([
      fs.lstat(source).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
      ),
      fs.stat(destination, { bigint: true }).catch(() => null),
    ]);
    if (!remaining && before.ino !== 0n && moved?.ino === before.ino && moved?.dev === before.dev)
      return;
    const windowsCode = Number((error as { stderr?: string }).stderr?.trim());
    const code =
      (
        {
          2: 'ENOENT',
          3: 'ENOENT',
          5: 'EACCES',
          32: 'EBUSY',
          33: 'EBUSY',
          80: 'EEXIST',
          183: 'EEXIST',
        } as Record<number, string>
      )[windowsCode] ?? 'EIO';
    // Do not propagate child stderr or environment into credential diagnostics.
    throw Object.assign(new Error(`Codex auth move failed (${code})`), { code });
  }
}
