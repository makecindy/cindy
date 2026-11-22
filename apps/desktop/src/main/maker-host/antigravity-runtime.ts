import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const GOOGLE_MAC_REQUIREMENT = 'anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"';
const WINDOWS_SIGNATURE_CHECK = `
$ErrorActionPreference = 'Stop'
$file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CINDY_AGY_VERIFY_PATH))
$signature = Get-AuthenticodeSignature -LiteralPath $file
if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate -or
    $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Google LLC') { exit 1 }
exit 0
`;
const verificationCache = new Map<string, string>();

export function supportsAntigravityRuntime(platform = process.platform, arch = process.arch): boolean {
  return (platform === 'win32' && arch === 'x64') || (platform === 'darwin' && arch === 'arm64');
}

function fingerprint(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.size === 0n) throw new Error('ANTIGRAVITY_UNVERIFIED_RUNTIME');
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join(':');
}

/** Check the OS signature before the CLI receives any account, workspace, or ACP arguments. */
export function assertVerifiedAntigravityBinary(binary: string): string {
  if (!supportsAntigravityRuntime() || !path.isAbsolute(binary)
    || fs.realpathSync(binary) !== binary
    || !/^(?:agy|antigravity)(?:\.exe)?$/i.test(path.basename(binary))) {
    throw new Error('ANTIGRAVITY_UNVERIFIED_RUNTIME');
  }
  fs.accessSync(binary, fs.constants.X_OK);
  const before = fingerprint(binary);
  if (verificationCache.get(binary) === before) return before;
  verificationCache.delete(binary);
  const options = { timeout: 15_000, windowsHide: true, stdio: 'ignore' as const };
  const windows = process.platform === 'win32';
  if (windows && !/\.exe$/i.test(binary)) throw new Error('ANTIGRAVITY_UNVERIFIED_RUNTIME');
  const result = windows
    ? spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_SIGNATURE_CHECK, 'utf16le').toString('base64'),
      ], { ...options, env: { ...process.env, CINDY_AGY_VERIFY_PATH: Buffer.from(binary).toString('base64') } })
    : spawnSync('/usr/bin/codesign', ['--verify', '--strict', '-R', `=${GOOGLE_MAC_REQUIREMENT}`, binary], options);
  if (result.status !== 0 || result.error || fingerprint(binary) !== before || fs.realpathSync(binary) !== binary) {
    throw new Error('ANTIGRAVITY_UNVERIFIED_RUNTIME');
  }
  if (verificationCache.size >= 16) {
    const oldest = verificationCache.keys().next().value;
    if (oldest !== undefined) verificationCache.delete(oldest);
  }
  verificationCache.set(binary, before);
  return before;
}
