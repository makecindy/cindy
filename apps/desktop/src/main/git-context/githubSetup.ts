import { execFile, spawn } from 'node:child_process';
import type { GithubSetupState } from '../../shared/githubSetup.js';
import { installTool } from '../managed-tools/installer.js';
import { ghArtifact, GH_VERSION } from './ghArtifact.js';
import { resolveGhBinary } from './ghBinary.js';

interface SetupDeps {
  resolveBinary(): Promise<string>;
  available(binary: string): Promise<boolean>;
  authenticated(binary: string): Promise<boolean>;
  install(signal: AbortSignal, update: (state: GithubSetupState) => void): Promise<string>;
  login(
    binary: string,
    signal: AbortSignal,
    update: (state: GithubSetupState) => void,
  ): Promise<void>;
  connected(): void;
}

/** One host-owned operation shared by all local windows. Closing a dialog does
 * not lose the device code or stop an installation. Cancellation waits for the
 * child to exit before another operation may start. */
export class GithubSetup {
  private state: GithubSetupState = { phase: 'idle' };
  private controller?: AbortController;
  private operation?: Promise<void>;
  constructor(private readonly deps: SetupDeps) {}
  snapshot(): GithubSetupState {
    return { ...this.state };
  }
  start(): GithubSetupState {
    if (this.controller) return this.snapshot();
    const controller = new AbortController();
    this.controller = controller;
    this.state = { phase: 'checking' };
    this.operation = this.run(controller).finally(() => {
      this.controller = undefined;
    });
    return this.snapshot();
  }
  async cancel(): Promise<GithubSetupState> {
    this.controller?.abort();
    await this.operation;
    return this.snapshot();
  }
  private async run(controller: AbortController): Promise<void> {
    const { signal } = controller;
    let stage: 'install' | 'login' = 'install';
    const update = (state: GithubSetupState) => {
      if (!signal.aborted) this.state = state;
    };
    try {
      let binary = await this.deps.resolveBinary();
      if (!(await this.deps.available(binary))) {
        signal.throwIfAborted();
        binary = await this.deps.install(signal, update);
      }
      signal.throwIfAborted();
      stage = 'login';
      this.state = { phase: 'checking' };
      if (!(await this.deps.authenticated(binary))) {
        signal.throwIfAborted();
        this.state = { phase: 'authorizing' };
        await this.deps.login(binary, signal, update);
        signal.throwIfAborted();
        this.state = { phase: 'checking' };
        if (!(await this.deps.authenticated(binary))) throw new Error('login');
      }
      signal.throwIfAborted();
      this.deps.connected();
      this.state = { phase: 'connected' };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      this.state = signal.aborted
        ? { phase: 'cancelled' }
        : {
            phase: 'error',
            error: code === 'unsupported' || code === 'timeout' ? code : stage,
          };
    }
  }
}

function check(binary: string, args: string[], expected?: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      resolve(!err && (!expected || stdout.startsWith(`gh version ${expected} `)));
    });
  });
}

/** Parse only the documented device-code line. Never forward raw CLI output. */
export function deviceCodeFromOutput(output: string): string | undefined {
  return /(?:one-time code:\s*|One-time code \()([A-Z0-9]{4}-[A-Z0-9]{4})(?=[\s)]|$)/.exec(
    output,
  )?.[1];
}

export function loginWithGh(
  binary: string,
  signal: AbortSignal,
  update: (state: GithubSetupState) => void,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Pipes make gh noninteractive: it prints the code and URL and polls GitHub,
    // without opening a browser or prompting for Enter/SSH/git configuration.
    const child = spawn(
      binary,
      // gh's repo/read:org/gist defaults plus everyday workflow, project,
      // notification and package operations. Approval stays on GitHub's page.
      [
        'auth',
        'login',
        '--hostname',
        'github.com',
        '--web',
        '--git-protocol',
        'https',
        '--scopes',
        'workflow,project,notifications,read:packages,write:packages',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' },
      },
    );
    let output = '';
    let timedOut = false;
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8192);
      const userCode = deviceCodeFromOutput(output);
      if (userCode)
        update({
          phase: 'authorizing',
          userCode,
          verificationUrl: 'https://github.com/login/device',
        });
    };
    child.stderr.on('data', read);
    // Drain stdout too, but do not store or expose it (may contain sensitive data).
    child.stdout.resume();
    const stop = () => {
      child.kill();
    };
    signal.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, 15 * 60_000);
    const clean = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', stop);
      output = '';
    };
    child.once('error', () => {
      clean();
      reject(new Error('login'));
    });
    child.once('close', (code) => {
      clean();
      if (signal.aborted || timedOut || code !== 0)
        reject(new Error(timedOut ? 'timeout' : 'login'));
      else resolve();
    });
    if (signal.aborted) stop();
  });
}

export function createGithubSetup(root: string, connected: () => void): GithubSetup {
  return new GithubSetup({
    resolveBinary: resolveGhBinary,
    available: (binary) => check(binary, ['--version']),
    authenticated: (binary) => check(binary, ['auth', 'status', '--hostname', 'github.com']),
    login: loginWithGh,
    connected,
    async install(signal, update) {
      const artifact = ghArtifact(process.platform, process.arch);
      if (!artifact) throw new Error('unsupported');
      return installTool({
        root,
        artifact,
        signal,
        onProgress: ({ status, progress }) =>
          update({ phase: status, percent: progress?.percent ?? undefined }),
        validate: (binary) => check(binary, ['--version'], GH_VERSION),
      });
    },
  });
}
