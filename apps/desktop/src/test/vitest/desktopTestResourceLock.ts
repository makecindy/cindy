import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCK_HOST = '127.0.0.1';
const LOCK_PORT_START = 49_152;
const LOCK_PORT_COUNT = 16_000;
const LOCK_PORT_CANDIDATES = 32;
const RETRY_DELAY_MS = 250;
const PROBE_TIMEOUT_MS = 1_000;
const LOCK_PROTOCOL = 'cindy-desktop-test-lock-v1';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

interface DesktopTestLock {
  port: number;
  release: () => Promise<void>;
}

export type DesktopTestLockProbeResult = 'owner' | 'retry' | 'collision';

export type DesktopTestLockDecision =
  | { type: 'wait' }
  | { type: 'acquire'; port: number }
  | { type: 'unavailable' };

export function classifyDesktopTestLockProbeError(
  code: string | undefined,
): DesktopTestLockProbeResult {
  return code === 'ECONNREFUSED' ? 'retry' : 'collision';
}

/**
 * Decide only after every deterministic candidate has been probed. An owner
 * can be on a fallback port because an earlier unrelated service occupied the
 * primary port when it started; taking a now-free earlier port before checking
 * the fallbacks would split the shared budget between two worktrees.
 */
export function decideDesktopTestLock(
  probes: readonly { port: number; result: DesktopTestLockProbeResult }[],
): DesktopTestLockDecision {
  if (probes.some(({ result }) => result === 'owner')) return { type: 'wait' };
  const available = probes.find(({ result }) => result === 'retry');
  return available ? { type: 'acquire', port: available.port } : { type: 'unavailable' };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function resolveGitCommonDir(repoRoot: string): Promise<string> {
  const dotGitPath = path.join(repoRoot, '.git');
  let dotGitStat;
  try {
    dotGitStat = await fs.stat(dotGitPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // Source archives and exported checkouts may not carry Git metadata.
    // They still get a stable per-checkout lock instead of failing test setup.
    return fs.realpath(repoRoot);
  }
  if (dotGitStat.isDirectory()) return fs.realpath(dotGitPath);

  const gitDirLine = (await fs.readFile(dotGitPath, 'utf8')).trim();
  const gitDirMatch = /^gitdir:\s*(.+)$/i.exec(gitDirLine);
  if (!gitDirMatch) throw new Error(`Invalid gitdir file: ${dotGitPath}`);
  const gitDir = path.resolve(repoRoot, gitDirMatch[1]);
  try {
    const commonDir = (await fs.readFile(path.join(gitDir, 'commondir'), 'utf8')).trim();
    return fs.realpath(path.resolve(gitDir, commonDir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fs.realpath(gitDir);
  }
}

function lockIdentity(commonDir: string): string {
  const normalized = process.platform === 'win32' ? commonDir.toLowerCase() : commonDir;
  return createHash('sha256').update(normalized).digest('hex');
}

function lockPort(identity: string, candidate: number): number {
  const baseOffset = Number.parseInt(identity.slice(0, 8), 16) % LOCK_PORT_COUNT;
  return LOCK_PORT_START + ((baseOffset + candidate) % LOCK_PORT_COUNT);
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOCK_HOST, port, exclusive: true });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function probeLock(port: number, expectedBanner: string): Promise<DesktopTestLockProbeResult> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: LOCK_HOST, port });
    let response = '';
    let settled = false;

    const finish = (result: DesktopTestLockProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };

    socket.setEncoding('utf8');
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\n')) {
        finish(response.trim() === expectedBanner ? 'owner' : 'collision');
      }
    });
    socket.on('end', () => finish(response.trim() === expectedBanner ? 'owner' : 'collision'));
    socket.on('timeout', () => finish('collision'));
    socket.on('error', (error: NodeJS.ErrnoException) => {
      finish(classifyDesktopTestLockProbeError(error.code));
    });
  });
}

export async function acquireDesktopTestLock(repoRoot: string): Promise<DesktopTestLock> {
  const commonDir = await resolveGitCommonDir(repoRoot);
  const identity = lockIdentity(commonDir);
  const banner = `${LOCK_PROTOCOL}:${identity}`;
  let reportedWait = false;
  const ports = Array.from(
    { length: LOCK_PORT_CANDIDATES },
    (_, candidate) => lockPort(identity, candidate),
  );

  while (true) {
    const probes = await Promise.all(ports.map(async (port) => ({
      port,
      result: await probeLock(port, banner),
    })));
    const decision = decideDesktopTestLock(probes);

    if (decision.type === 'wait') {
      if (!reportedWait) {
        reportedWait = true;
        process.stdout.write('WAIT desktop tests: another worktree is using the shared Desktop test budget\n');
      }
      await delay(RETRY_DELAY_MS);
      continue;
    }
    if (decision.type === 'unavailable') {
      // A random or OS-assigned fallback cannot be rediscovered by later
      // worktrees and would silently break mutual exclusion. Fail closed only
      // after the expanded deterministic window is genuinely unavailable.
      throw new Error(
        `All ${LOCK_PORT_CANDIDATES} Desktop test resource-lock ports are occupied by other local services`,
      );
    }

    const server = net.createServer((socket) => {
      socket.end(`${banner}\n`);
    });
    try {
      await listen(server, decision.port);
      return {
        port: decision.port,
        release: () => close(server),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      // Another contender may have won between the probe and listen phases.
      // Re-scan every candidate so its owner banner is observed before retrying.
      await delay(RETRY_DELAY_MS);
    }
  }
}

export default async function setupDesktopTestResourceLock(): Promise<() => Promise<void>> {
  const lock = await acquireDesktopTestLock(REPO_ROOT);
  return lock.release;
}
