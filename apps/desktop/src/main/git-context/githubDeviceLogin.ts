import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { PLUGIN_OAUTH_TTL_MS } from '@cindy/device-link';
import type {
  DeviceAuthorizationHandle,
  DeviceAuthorizationInput,
} from '../plugin-oauth/deviceCard.js';

const helper = '/usr/local/lib/cindy/github-device-login.py';
const fail = () => new Error('GITHUB_AUTH_UNAVAILABLE');
export interface GithubLoginChallenge {
  url: string;
  userCode: string;
}
export interface GithubLoginProcess {
  challenge: Promise<GithubLoginChallenge>;
  ready: Promise<void>;
  opened(): void;
  commit(): Promise<void>;
  dispose(): Promise<void>;
}
export interface GithubLoginDeps {
  available(): boolean;
  probe(): Promise<boolean>;
  start(signal: AbortSignal): GithubLoginProcess;
  openCard(input: DeviceAuthorizationInput): DeviceAuthorizationHandle;
  acquireCommitLease(): () => void;
  invalidateTokenCache(): void;
}
let active = false;
/** Host credential adapter: plugin tools, paths, commands and tokens are never caller inputs. */
export async function connectGithubDevice(
  input: {
    ghost: { id: string; name: string };
    sessionId: string;
    reauthorize?: boolean;
    signal?: AbortSignal;
    assertCurrent(): void;
  },
  deps: GithubLoginDeps,
): Promise<Record<string, unknown>> {
  const unavailable = {
    ok: false,
    errorCode: 'AUTH_FAILED',
    ghostId: input.ghost.id,
    message:
      'GitHub login was not completed. Retry connect_account from the current task; do not put codes or tokens in chat.',
  };
  if (active) return { ...unavailable, errorCode: 'AUTH_IN_PROGRESS' };
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  const assertCurrent = () => {
    if (lifetime.signal.aborted || input.signal?.aborted) throw fail();
    input.assertCurrent();
  };
  let child: GithubLoginProcess | undefined;
  let card: DeviceAuthorizationHandle | undefined;
  let release: (() => void) | undefined;
  active = true;
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, PLUGIN_OAUTH_TTL_MS);
  // Owner/policy changes cancel even while waiting for the next user click.
  const fence = setInterval(() => {
    try {
      assertCurrent();
    } catch {
      abort();
    }
  }, 250);
  timer.unref?.();
  fence.unref?.();
  try {
    assertCurrent();
    if (!input.reauthorize && (await deps.probe())) {
      assertCurrent();
      return { ok: true, status: 'ready', ghostId: input.ghost.id };
    }
    assertCurrent();
    if (!deps.available())
      return {
        ...unavailable,
        errorCode: 'GITHUB_LOGIN_UNAVAILABLE',
        message:
          'This Host does not have the supported GitHub login helper. Update the Host; existing GitHub CLI connections and plugin settings remain available.',
      };
    child = deps.start(lifetime.signal);
    const challenge = await child.challenge;
    assertCurrent();
    card = deps.openCard({
      ...input,
      ...challenge,
      signal: lifetime.signal,
      assertCurrent,
      cancel: abort,
    });
    await card.opened;
    assertCurrent();
    child.opened();
    await child.ready;
    assertCurrent();
    release = deps.acquireCommitLease();
    assertCurrent();
    await child.commit();
    assertCurrent();
    deps.invalidateTokenCache();
    card.finish(true);
    return {
      ok: true,
      status: 'ready',
      ghostId: input.ghost.id,
      message:
        'GitHub login is available on the Host running this task. No repository or organization operation was executed.',
    };
  } catch {
    return unavailable;
  } finally {
    card?.dispose();
    await child?.dispose();
    release?.();
    clearTimeout(timer);
    clearInterval(fence);
    input.signal?.removeEventListener('abort', abort);
    active = false;
  }
}

export function githubDeviceLoginAvailable(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const stat = fs.lstatSync(helper);
    return stat.isFile() && stat.uid === 0 && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Fixed packaged helper; stdout is a private bounded protocol, never a log stream. */
export function startGithubDeviceLogin(signal: AbortSignal): GithubLoginProcess {
  if (!githubDeviceLoginAvailable() || signal.aborted) throw fail();
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'LANG', 'PATH', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
    if (process.env[key]) env[key] = process.env[key];
  // An environment credential must not silently take precedence over the new connection.
  for (const key of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_CONFIG_DIR',
    'GH_ENTERPRISE_TOKEN',
    'GITHUB_ENTERPRISE_TOKEN',
  ])
    if (process.env[key]) throw fail();
  const proc = spawn('/usr/bin/python3', [helper, '--device-login-v1'], {
    env,
    stdio: 'pipe',
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  let phase = 'starting';
  let buffer = '';
  let exited = false;
  let resolveChallenge!: (v: GithubLoginChallenge) => void;
  let resolveReady!: () => void;
  let resolveDone!: () => void;
  let rejectChallenge!: (e: Error) => void;
  let rejectReady!: (e: Error) => void;
  let rejectDone!: (e: Error) => void;
  const challenge = new Promise<GithubLoginChallenge>((y, n) => {
    resolveChallenge = y;
    rejectChallenge = n;
  });
  const ready = new Promise<void>((y, n) => {
    resolveReady = y;
    rejectReady = n;
  });
  const done = new Promise<void>((y, n) => {
    resolveDone = y;
    rejectDone = n;
  });
  // Later stages can fail before their consumer awaits them.
  void challenge.catch(() => {});
  void ready.catch(() => {});
  void done.catch(() => {});
  const reject = () => {
    rejectChallenge(fail());
    rejectReady(fail());
    rejectDone(fail());
  };
  const terminate = () => {
    reject();
    if (!exited) proc.kill('SIGTERM'); // helper reaps its private children and removes tmpfs state
  };
  const closed = new Promise<void>((resolve) => {
    proc.once('close', (code) => {
      exited = true;
      signal.removeEventListener('abort', terminate);
      if (phase === 'done' && code === 0) resolveDone();
      else reject();
      resolve();
    });
  });
  proc.once('error', terminate);
  proc.stdin.on('error', terminate);
  proc.stderr.resume(); // no raw CLI/provider output, credentials or process error in logs
  proc.stdout.on('data', (data: Buffer) => {
    buffer += data.toString('utf8');
    if (buffer.length > 4096) {
      terminate();
      return;
    }
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (
          phase === 'starting' &&
          Object.keys(value).sort().join(',') === 'phase,url,userCode' &&
          value.phase === 'challenge' &&
          value.url === 'https://github.com/login/device' &&
          typeof value.userCode === 'string' &&
          /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(value.userCode)
        ) {
          phase = 'challenge';
          resolveChallenge({ url: value.url, userCode: value.userCode });
        } else if (
          phase === 'opened' &&
          Object.keys(value).join(',') === 'phase' &&
          value.phase === 'ready'
        ) {
          phase = 'ready';
          resolveReady();
        } else if (
          phase === 'committing' &&
          Object.keys(value).join(',') === 'phase' &&
          value.phase === 'done'
        ) {
          phase = 'done';
        } else throw fail();
      } catch {
        terminate();
      }
    }
  });
  signal.addEventListener('abort', terminate, { once: true });
  if (signal.aborted) terminate();
  const send = (expected: string, op: string, next: string) => {
    if (phase !== expected || signal.aborted || exited) throw fail();
    phase = next;
    proc.stdin.write(JSON.stringify({ op }) + '\n');
  };
  return {
    challenge,
    ready,
    opened: () => send('challenge', 'opened', 'opened'),
    commit: () => {
      send('ready', 'commit', 'committing');
      return done;
    },
    dispose: async () => {
      if (!exited) terminate();
      const kill = setTimeout(() => {
        if (!exited && proc.pid) {
          try {
            process.kill(-proc.pid, 'SIGKILL');
          } catch {
            /* already exited */
          }
        }
      }, 10_000);
      kill.unref?.();
      await closed;
      clearTimeout(kill);
    },
  };
}
