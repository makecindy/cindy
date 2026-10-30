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

/** Managed CLIs that print `<name> <version>` instead of a leading bare version. */
const NAMED_VERSION_PREFIXES = new Set(['pi', 'codex-cli']);

function normalizeVersionToken(token: string | undefined): string | null {
  return token ? normalizeBinaryVersion(token.replace(/^v(?=\d)/, '')) : null;
}

/**
 * Parse the supported version forms from the first `--version` output line.
 *
 * Covers the three shapes the managed runtimes actually print:
 *   - `0.84.4`              (pi)
 *   - `2.1.258 (Claude Code)` (claude-code — version leads, suffix is a product label)
 *   - `codex-cli 0.145.0`   (codex)
 *
 * Stays deliberately strict: an unknown leading token that is not itself a valid
 * version yields null rather than scanning the line for anything semver-shaped.
 */
export function parseBinaryVersionOutput(stdout: string, stderr: string): string | null {
  const output = (stdout || stderr).trim();
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const tokens = firstLine.split(/\s+/);
  const leadingVersion = normalizeVersionToken(tokens[0]);
  if (leadingVersion) return leadingVersion;
  if (tokens.length === 2 && NAMED_VERSION_PREFIXES.has(tokens[0]?.toLowerCase() ?? '')) {
    return normalizeVersionToken(tokens[1]);
  }
  return null;
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
