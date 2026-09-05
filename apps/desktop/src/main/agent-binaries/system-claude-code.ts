import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import claudeLatest from '../../../../../tools/claude/latest.json';
import type {
  ClaudeCodeRuntimeFallbackReason,
  ClaudeCodeRuntimeProbeResult,
} from '../../shared/claudeCodeRuntimeSettings.js';
import { isBinaryVersionNotOlder, normalizeBinaryVersion } from './binary-version-probe.js';

export const CLAUDE_CODE_MINIMUM_VERSION = (claudeLatest as { version: string }).version;

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BUFFER = 64 * 1024;
const VERSION_RE = /\bv?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/;

interface ResolverDependencies {
  platform: NodeJS.Platform;
  envPath: string;
  homeDir: string;
  access: (candidate: string) => Promise<void>;
  stat: (candidate: string) => Promise<{ isFile(): boolean }>;
  probeVersion: (candidate: string, signal?: AbortSignal) => Promise<string | null>;
}

function parseClaudeVersion(output: string): string | null {
  const match = VERSION_RE.exec(output.trim());
  return match?.[1] ? normalizeBinaryVersion(match[1]) : null;
}

function probeVersion(candidate: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        candidate,
        ['--version'],
        {
          encoding: 'utf8',
          maxBuffer: PROBE_MAX_BUFFER,
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          signal,
        },
        (error, stdout, stderr) => {
          resolve(error ? null : parseClaudeVersion(stdout || stderr || ''));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function defaultDependencies(): ResolverDependencies {
  return {
    platform: process.platform,
    envPath: process.env.PATH ?? '',
    homeDir: os.homedir(),
    access: (candidate) => fs.promises.access(candidate, fs.constants.X_OK),
    stat: (candidate) => fs.promises.stat(candidate),
    probeVersion,
  };
}

function candidatePaths(deps: ResolverDependencies, customPath: string): string[] {
  if (customPath) return [path.resolve(customPath)];

  const names = deps.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const directories = deps.envPath.split(path.delimiter).filter(Boolean);
  if (deps.platform !== 'win32') {
    directories.push(
      path.join(deps.homeDir, '.local', 'bin'),
      path.join(deps.homeDir, '.npm-global', 'bin'),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    );
  }

  return [
    ...new Set(
      directories.flatMap((directory) => names.map((name) => path.resolve(directory, name))),
    ),
  ];
}

function failure(reason: ClaudeCodeRuntimeFallbackReason): ClaudeCodeRuntimeProbeResult {
  return {
    ok: false,
    binaryPath: null,
    version: null,
    minimumVersion: CLAUDE_CODE_MINIMUM_VERSION,
    reason,
  };
}

export async function resolveSystemClaudeCode(
  customPath = '',
  signal?: AbortSignal,
  deps: ResolverDependencies = defaultDependencies(),
): Promise<ClaudeCodeRuntimeProbeResult> {
  const candidates = candidatePaths(deps, customPath.trim());
  let foundCandidate = false;
  let unsupportedLauncherFound = false;
  let bestVersionFailure: ClaudeCodeRuntimeProbeResult | null = null;

  for (const candidate of candidates) {
    if (signal?.aborted) return failure('version_unavailable');
    if (deps.platform === 'win32' && /\.(?:cmd|bat)$/i.test(candidate)) {
      try {
        await deps.stat(candidate);
        foundCandidate = true;
        unsupportedLauncherFound = true;
        if (customPath) return failure('unsupported_launcher');
      } catch {
        // Keep looking for a native executable.
      }
      continue;
    }

    try {
      const stat = await deps.stat(candidate);
      foundCandidate = true;
      if (!stat.isFile()) {
        if (customPath) return failure('not_executable');
        continue;
      }
      await deps.access(candidate);
    } catch {
      if (foundCandidate && customPath) return failure('not_executable');
      continue;
    }

    const version = await deps.probeVersion(candidate, signal);
    if (!version) {
      const result = {
        ...failure('version_unavailable'),
        binaryPath: candidate,
      };
      if (customPath) return result;
      bestVersionFailure ??= result;
      continue;
    }
    if (version.includes('-') || !isBinaryVersionNotOlder(version, CLAUDE_CODE_MINIMUM_VERSION)) {
      const result = {
        ...failure('version_too_old'),
        binaryPath: candidate,
        version,
      };
      if (customPath) return result;
      if (bestVersionFailure?.reason !== 'version_too_old') bestVersionFailure = result;
      continue;
    }
    return {
      ok: true,
      binaryPath: candidate,
      version,
      minimumVersion: CLAUDE_CODE_MINIMUM_VERSION,
    };
  }

  if (bestVersionFailure) return bestVersionFailure;
  return failure(
    unsupportedLauncherFound
      ? 'unsupported_launcher'
      : foundCandidate
        ? 'not_executable'
        : 'not_found',
  );
}

export const __testing = {
  candidatePaths,
  parseClaudeVersion,
};
