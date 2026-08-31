import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

interface SemverApi {
  valid(version: string): string | null;
  gte(left: string, right: string): boolean;
}

const semver = createRequire(import.meta.url)('semver') as SemverApi;
const VERSION_PROBE_TIMEOUT_MS = 5_000;
const VERSION_PROBE_MAX_BUFFER = 64 * 1024;

/** Normalize a strict runtime semantic version using the installed semver implementation. */
export function normalizeBinaryVersion(version: string): string | null {
  return semver.valid(version.trim());
}

export function isBinaryVersionNotOlder(candidate: string, required: string): boolean {
  return semver.gte(candidate, required);
}

/** Parse the supported Pi version forms from the first `--version` output line. */
export function parseBinaryVersionOutput(stdout: string, stderr: string): string | null {
  const output = (stdout || stderr).trim();
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const tokens = firstLine.split(/\s+/);
  const versionToken = tokens.length === 1
    ? tokens[0]
    : tokens.length === 2 && tokens[0]?.toLowerCase() === 'pi'
      ? tokens[1]
      : undefined;
  return versionToken
    ? normalizeBinaryVersion(versionToken.replace(/^v(?=\d)/, ''))
    : null;
}

/**
 * Probe a managed executable without letting a broken/local self-update fail the
 * surrounding CDN prepare. Invalid output, timeout, or spawn errors all return null.
 */
export function probeBinaryVersion(
  binaryPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        binaryPath,
        ['--version'],
        {
          encoding: 'utf8',
          maxBuffer: VERSION_PROBE_MAX_BUFFER,
          timeout: VERSION_PROBE_TIMEOUT_MS,
          windowsHide: true,
          signal,
        },
        (error, stdout, stderr) => {
          if (error) {
            resolve(null);
            return;
          }
          resolve(parseBinaryVersionOutput(stdout, stderr));
        },
      );
    } catch {
      resolve(null);
    }
  });
}
