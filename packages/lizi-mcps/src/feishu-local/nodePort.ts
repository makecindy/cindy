import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FEISHU_LOCAL_REQUIRED_SCOPES,
  isValidImageRef,
  isValidVerificationUrl,
  isVersionSupported,
  mapCliFailure,
  parseAuthStatus,
  parseUpdateCheck,
  parseVersionOutput,
} from './descriptor.js';
import type {
  FeishuLocalAuthState,
  FeishuLocalBinaryProbe,
  FeishuLocalCliResult,
  FeishuLocalConnectInput,
  FeishuLocalHostPort,
  FeishuLocalImageHandoff,
  FeishuLocalReasonCode,
  FeishuLocalSetupInput,
  FeishuLocalUpdateProbe,
} from './types.js';

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;

export interface NodeFeishuLocalPortOptions {
  platform?: string;
  homeDir: string;
  profileDir: string;
  deviceId(): string | Promise<string>;
  credentials: {
    read(): Promise<string | null>;
    write(value: string): Promise<void>;
    /** Capture the account/owner binding before any queue wait or CLI run. */
    bind?(): BoundCredentials | null;
  };
  resolveManagedImage(imageRef: string): Promise<{ absPath: string; mimeType: string } | null>;
  managedBinaryPath?: string;
  additionalBinaryPaths?: readonly string[];
  requestSetup?: (input: FeishuLocalSetupInput) => Promise<{ ok: boolean; reasonCode?: FeishuLocalReasonCode; message?: string }>;
  spawnFn?: typeof spawn;
}

interface ArchiveFile { rel: string; data: string }
interface CredentialArchive { v: 1; files: ArchiveFile[] }
interface BoundCredentials {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  assertCurrent(): void;
}

/** Serialize only the short credential-store critical sections, never a CLI run. */
const credentialQueues = new Map<string, Promise<void>>();

async function withCredentialQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = credentialQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const next = previous.then(() => gate);
  credentialQueues.set(key, next);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (credentialQueues.get(key) === next) credentialQueues.delete(key);
  }
}

function platformOf(options: NodeFeishuLocalPortOptions): string {
  return options.platform ?? process.platform;
}

function configDir(home: string, platform: string): string {
  if (platform === 'win32') return path.join(home, 'AppData', 'Roaming', 'lark-cli');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'lark-cli');
  return path.join(home, '.config', 'lark-cli');
}

function baseEnv(home: string, platform: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('LARKSUITE_CLI_')) env[key] = value;
  }
  env.HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  if (platform === 'win32') {
    env.USERPROFILE = home;
    env.APPDATA = path.join(home, 'AppData', 'Roaming');
  }
  return env;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(first, last + 1));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizedArchive(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Partial<CredentialArchive>;
    if (parsed.v !== 1 || !Array.isArray(parsed.files)) return null;
    const files = parsed.files
      .filter((file): file is ArchiveFile => !!file && typeof file.rel === 'string' && typeof file.data === 'string')
      .map(file => ({ rel: file.rel, data: file.data }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
    return JSON.stringify({ v: 1, files });
  } catch {
    return null;
  }
}

function sameCredentialArchive(a: string, b: string): boolean {
  const left = normalizedArchive(a);
  const right = normalizedArchive(b);
  return left !== null && left === right;
}

async function archiveDir(dir: string): Promise<string | null> {
  const files: ArchiveFile[] = [];
  let total = 0;
  async function walk(current: string, relPrefix: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, rel);
      } else if (entry.isFile()) {
        const data = await fs.readFile(absolute);
        total += data.byteLength;
        if (total > MAX_ARCHIVE_BYTES || files.length >= 64) throw new Error('credential archive too large');
        files.push({ rel, data: data.toString('base64') });
      }
    }
  }
  await walk(dir, '');
  return files.length ? JSON.stringify({ v: 1, files } satisfies CredentialArchive) : null;
}

async function materializeDir(raw: string, target: string): Promise<void> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') throw new Error('invalid credential archive');
  const archive = parsed as Partial<CredentialArchive>;
  if (archive.v !== 1 || !Array.isArray(archive.files)) throw new Error('invalid credential archive');
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const file of archive.files) {
    if (!file || typeof file.rel !== 'string' || typeof file.data !== 'string' ||
      file.rel.includes('\0') || file.rel.startsWith('/') || file.rel.includes('..') || path.isAbsolute(file.rel)) {
      throw new Error('invalid credential archive path');
    }
    const dest = path.resolve(target, file.rel);
    const rel = path.relative(target, dest);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('invalid credential archive path');
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await fs.writeFile(dest, Buffer.from(file.data, 'base64'), { mode: 0o600 });
  }
}

function cliFailure(result: FeishuLocalCliResult): { ok: false; reasonCode: FeishuLocalReasonCode; message: string } {
  if (result.reasonCode) return { ok: false, reasonCode: result.reasonCode, message: 'Feishu CLI command failed; raw output was withheld.' };
  const mapped = mapCliFailure(result.stdout, result.stderr, result.exitCode);
  return { ok: false, reasonCode: mapped.reasonCode, message: mapped.message };
}

function authStateFromStatus(result: FeishuLocalCliResult): FeishuLocalAuthState | null {
  if (!result.ok || result.outputTruncated) return null;
  const parsed = parseAuthStatus(result.stdout);
  const scopes = parsed.scope ? parsed.scope.split(/\s+/).filter(Boolean) : [];
  let state: FeishuLocalAuthState['state'] = 'ready';
  if (!parsed.available || parsed.tokenStatus === 'expired') state = 'missing';
  else if (!FEISHU_LOCAL_REQUIRED_SCOPES.every(scope => scopes.includes(scope))) state = 'scope_missing';
  return {
    state,
    identity_alias: parsed.userName,
    scopes,
    ...(state === 'missing' ? { reason_code: 'NOT_AUTHORIZED' as const } : {}),
    ...(state === 'scope_missing' ? { reason_code: 'SCOPE_MISSING' as const } : {}),
  };
}

export function createNodeFeishuLocalPort(options: NodeFeishuLocalPortOptions): FeishuLocalHostPort {
  const platform = platformOf(options);
  const spawnFn = options.spawnFn ?? spawn;
  const queueKey = path.resolve(options.profileDir);
  let cachedProbe: { expiresAt: number; value: FeishuLocalBinaryProbe } | null = null;

  function currentCredentials(): BoundCredentials | null {
    const bound = options.credentials.bind?.();
    if (bound === null) return null;
    if (bound) return bound;
    return {
      read: options.credentials.read,
      write: options.credentials.write,
      assertCurrent: () => {},
    };
  }

  async function readBound(bound: BoundCredentials): Promise<string | null> {
    bound.assertCurrent();
    const value = await bound.read().catch(() => null);
    bound.assertCurrent();
    return value;
  }

  async function writeBound(bound: BoundCredentials, value: string): Promise<void> {
    bound.assertCurrent();
    await bound.write(value);
    bound.assertCurrent();
  }

  async function commitCredentialArchive(
    bound: BoundCredentials,
    expected: string | null,
    archive: string,
  ): Promise<boolean> {
    return withCredentialQueue(queueKey, async () => {
      const current = await readBound(bound);
      if (current !== expected) return false;
      await writeBound(bound, archive);
      return true;
    });
  }

  async function spawnCli(
    binary: string,
    argv: string[],
    env: Record<string, string | undefined>,
    cwd: string,
    timeoutMs: number,
  ): Promise<FeishuLocalCliResult> {
    return new Promise<FeishuLocalCliResult>((resolve) => {
      const child = spawnFn(binary, argv, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let outputTruncated = false;
      let settled = false;
      let timedOut = false;
      const pushBounded = (chunks: Buffer[], chunk: Buffer, used: number): number => {
        const room = MAX_OUTPUT_BYTES - used;
        if (room <= 0) {
          outputTruncated = true;
          return used;
        }
        if (chunk.byteLength > room) {
          chunks.push(chunk.subarray(0, room));
          outputTruncated = true;
          return MAX_OUTPUT_BYTES;
        }
        chunks.push(chunk);
        return used + chunk.byteLength;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
      child.stdout.on('data', (chunk: Buffer) => {
        outBytes = pushBounded(stdout, chunk, outBytes);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        errBytes = pushBounded(stderr, chunk, errBytes);
      });
      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: exitCode === 0 && !timedOut && !outputTruncated,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: timedOut ? -1 : exitCode,
          ...(timedOut || outputTruncated ? { reasonCode: 'CLI_FAILED' as const } : {}),
          ...(timedOut ? { timedOut: true as const } : {}),
          ...(outputTruncated ? { outputTruncated: true as const } : {}),
        });
      };
      child.on('error', () => finish(-1));
      child.on('close', code => finish(typeof code === 'number' ? code : -1));
    });
  }

  async function resolveBinary(): Promise<{ path: string; source: 'managed' | 'fixed-path' } | null> {
    const home = options.homeDir;
    const fixed = platform === 'win32'
      ? [
          path.join(home, 'AppData', 'Local', 'pnpm', 'lark-cli.exe'),
          path.join(home, 'AppData', 'Roaming', 'npm', 'lark-cli.exe'),
          path.join(home, '.local', 'share', 'pnpm', 'bin', 'lark-cli'),
        ]
      : [
          path.join(home, '.local', 'share', 'pnpm', 'bin', 'lark-cli'),
          path.join(home, '.local', 'bin', 'lark-cli'),
          '/opt/homebrew/bin/lark-cli',
          '/usr/local/bin/lark-cli',
        ];
    const managed = options.managedBinaryPath ? [options.managedBinaryPath] : [];
    const candidates: Array<{ path: string; source: 'managed' | 'fixed-path' }> = [
      ...managed.map(item => ({ path: item, source: 'managed' as const })),
      ...(options.additionalBinaryPaths ?? []).map(item => ({ path: item, source: 'fixed-path' as const })),
      ...fixed.map(item => ({ path: item, source: 'fixed-path' as const })),
    ];
    for (const candidate of candidates) {
      try {
        await fs.access(candidate.path, fsConstants.X_OK);
        return candidate;
      } catch {
        // Fixed candidates only; never enumerate PATH.
      }
    }
    return null;
  }

  async function probeBinary(): Promise<FeishuLocalBinaryProbe> {
    const now = Date.now();
    if (cachedProbe && cachedProbe.expiresAt > now) return cachedProbe.value;
    const resolved = await resolveBinary();
    if (!resolved) {
      const value: FeishuLocalBinaryProbe = { installed: false, binary_source: 'unavailable', version: null, version_supported: false };
      cachedProbe = { expiresAt: now + 60_000, value };
      return value;
    }
    const result = await spawnCli(resolved.path, ['--version'], baseEnv(options.homeDir, platform), options.profileDir, 10_000);
    const version = result.ok ? parseVersionOutput(result.stdout) : null;
    const value: FeishuLocalBinaryProbe = {
      installed: true,
      binary_source: resolved.source,
      version,
      version_supported: isVersionSupported(version),
    };
    cachedProbe = { expiresAt: now + 60_000, value };
    return value;
  }

  async function withMaterializedProfile<T>(run: (home: string) => Promise<T>): Promise<T | null> {
    const bound = currentCredentials();
    if (!bound) return null;
    let raw: string | null = null;
    let tempHome: string | null = null;
    try {
      await withCredentialQueue(queueKey, async () => {
        raw = await readBound(bound);
        if (!raw) return;
        tempHome = await fs.mkdtemp(path.join(options.profileDir, 'feishu-local-home-'));
        await materializeDir(raw, configDir(tempHome, platform));
      });
    } catch {
      if (tempHome) await fs.rm(tempHome, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    const profile = raw;
    const home = tempHome;
    if (!profile || !home) return null;
    try {
      return await run(home);
    } finally {
      const refreshed = await archiveDir(configDir(home, platform)).catch(() => null);
      if (refreshed && !sameCredentialArchive(refreshed, profile)) {
        await withCredentialQueue(queueKey, async () => {
          const current = await readBound(bound);
          if (current === profile) await writeBound(bound, refreshed);
        }).catch(() => {});
      }
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function terminalAuthStatus(resolved: { path: string }): Promise<FeishuLocalCliResult> {
    return spawnCli(resolved.path, ['auth', 'status', '--json'], baseEnv(options.homeDir, platform), options.profileDir, 15_000);
  }

  return {
    deviceId: () => options.deviceId(),

    probeBinary,

    async readAuth(): Promise<FeishuLocalAuthState> {
      const resolved = await resolveBinary();
      if (!resolved) return { state: 'missing', identity_alias: null, scopes: [], reason_code: 'LOCAL_CLI_NOT_INSTALLED' };
      const bound = currentCredentials();
      if (!bound) return { state: 'missing', identity_alias: null, scopes: [], reason_code: 'SETUP_UNAVAILABLE' };
      const raw = await withCredentialQueue(queueKey, () => readBound(bound)).catch(() => null);
      if (!raw) return { state: 'missing', identity_alias: null, scopes: [], reason_code: 'SETUP_REQUIRED' };
      const result = await withMaterializedProfile(async home =>
        spawnCli(resolved.path, ['auth', 'status', '--json'], baseEnv(home, platform), options.profileDir, 15_000));
      const auth = result ? authStateFromStatus(result) : null;
      return auth ?? { state: 'missing', identity_alias: null, scopes: [], reason_code: result ? cliFailure(result).reasonCode : 'CLI_FAILED' };
    },

    async checkUpdate(): Promise<FeishuLocalUpdateProbe | null> {
      const resolved = await resolveBinary();
      if (!resolved) return null;
      const result = await spawnCli(resolved.path, ['update', '--check', '--json'], baseEnv(options.homeDir, platform), options.profileDir, 30_000);
      return result.ok ? parseUpdateCheck(result.stdout) : null;
    },

    async runCli(invocation): Promise<FeishuLocalCliResult> {
      const resolved = await resolveBinary();
      if (!resolved) {
        return { ok: false, stdout: '', stderr: '', exitCode: -1, reasonCode: 'LOCAL_CLI_NOT_INSTALLED' };
      }
      if (!invocation.withCredential) {
        return spawnCli(resolved.path, invocation.argv, baseEnv(options.homeDir, platform), invocation.cwd ?? options.profileDir, invocation.timeoutMs ?? 30_000);
      }
      const result = await withMaterializedProfile(async home =>
        spawnCli(resolved.path, invocation.argv, baseEnv(home, platform), invocation.cwd ?? options.profileDir, invocation.timeoutMs ?? 30_000));
      return result ?? { ok: false, stdout: '', stderr: '', exitCode: -1, reasonCode: 'SETUP_REQUIRED' };
    },

    async resolveImage(imageRef: string): Promise<FeishuLocalImageHandoff> {
      if (!isValidImageRef(imageRef)) throw new Error('invalid managed image reference');
      const resolved = await options.resolveManagedImage(imageRef);
      if (!resolved || !resolved.mimeType.startsWith('image/')) throw new Error('managed image reference rejected');
      const tempDir = await fs.mkdtemp(path.join(options.profileDir, 'feishu-local-image-'));
      const basename = path.basename(resolved.absPath).replace(/[^A-Za-z0-9._-]/g, '_');
      const relativePath = basename || 'image.png';
      await fs.copyFile(resolved.absPath, path.join(tempDir, relativePath));
      return {
        cwd: tempDir,
        relativePath,
        async cleanup() { await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {}); },
      };
    },

    async requestSetup(input: FeishuLocalSetupInput) {
      if (!options.requestSetup) {
        return { ok: false as const, reasonCode: 'SETUP_UNAVAILABLE' as const, message: 'A native setup card is unavailable in this host.' };
      }
      return options.requestSetup(input);
    },

    async connect(input: FeishuLocalConnectInput) {
      const mode = input.mode ?? 'login';
      const bound = currentCredentials();
      if (!bound) return { ok: false as const, reasonCode: 'SETUP_UNAVAILABLE' as const };
      try {
        const expected = await withCredentialQueue(queueKey, () => readBound(bound));
        const resolved = await resolveBinary();
        if (!resolved) return { ok: false as const, reasonCode: 'LOCAL_CLI_NOT_INSTALLED' as const };
        if (mode === 'import-terminal') {
          const status = await terminalAuthStatus(resolved);
          const auth = authStateFromStatus(status);
          if (!auth || auth.state !== 'ready') {
            return { ok: false as const, reasonCode: auth?.reason_code ?? (status.ok ? 'NOT_AUTHORIZED' : cliFailure(status).reasonCode) };
          }
          input.assertCurrent?.();
          if (input.beforeCommit) await input.beforeCommit();
          const archive = await archiveDir(configDir(options.homeDir, platform));
          if (!archive) return { ok: false as const, reasonCode: 'NOT_AUTHORIZED' as const, message: 'Feishu CLI profile was not created.' };
          if (!await commitCredentialArchive(bound, expected, archive)) {
            return { ok: false as const, reasonCode: 'SETUP_REQUIRED' as const, message: 'Feishu CLI credentials changed; retry setup.' };
          }
          return { ok: true as const };
        }
        const env = baseEnv(options.homeDir, platform);
        const start = await spawnCli(resolved.path,
          ['auth', 'login', '--domain', 'sheets,drive', '--no-wait', '--json'],
          env, options.profileDir, 30_000);
        if (!start.ok) return cliFailure(start);
        const payload = parseJsonObject(start.stdout);
        const url = typeof payload?.verification_url === 'string' ? payload.verification_url : null;
        const deviceCode = typeof payload?.device_code === 'string' ? payload.device_code : null;
        if (!url || !deviceCode || !isValidVerificationUrl(url)) {
          return { ok: false as const, reasonCode: 'CLI_FAILED' as const, message: 'Feishu CLI did not return a valid device authorization URL.' };
        }
        try {
          if (input.onAuthorizationUrl) await input.onAuthorizationUrl(url);
        } catch {
          return { ok: false as const, reasonCode: 'SETUP_UNAVAILABLE' as const, message: 'Feishu Local CLI setup was cancelled or unavailable.' };
        }
        input.assertCurrent?.();
        const complete = await spawnCli(resolved.path,
          ['auth', 'login', '--device-code', deviceCode, '--json'],
          env, options.profileDir, 10 * 60_000);
        if (!complete.ok) return cliFailure(complete);
        input.assertCurrent?.();
        if (input.beforeCommit) await input.beforeCommit();
        const archive = await archiveDir(configDir(options.homeDir, platform));
        if (!archive) return { ok: false as const, reasonCode: 'NOT_AUTHORIZED' as const, message: 'Feishu CLI profile was not created.' };
        if (!await commitCredentialArchive(bound, expected, archive)) {
          return { ok: false as const, reasonCode: 'SETUP_REQUIRED' as const, message: 'Feishu CLI credentials changed; retry setup.' };
        }
        return { ok: true as const };
      } catch {
        return { ok: false as const, reasonCode: 'SETUP_UNAVAILABLE' as const, message: 'Feishu Local CLI setup could not be completed.' };
      }
    },
  };
}
