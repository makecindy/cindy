import { createHmac, randomBytes } from 'node:crypto';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { TerminalPromptRequest } from '../service.js';
import { createSystemProcessProbe, verifyAskpassChain, type ProcessProbe } from './processChain.js';

/**
 * Terminal password prompts for 代输入. Each local task's shell gets
 * `SUDO_ASKPASS` / `SSH_ASKPASS` / `GIT_ASKPASS` pointing at a tiny helper.
 * When `sudo -A`, `ssh` or git over HTTPS needs a password, the helper asks
 * Cindy over a private Unix socket; Cindy verifies the asking program, shows
 * the owner a one-step card, and returns the answer to that program only.
 *
 * Nothing here logs prompts, commands or answers.
 */

export const INPUT_HANDOFF_ROUTE_ENV = 'CINDY_INPUT_HANDOFF_ROUTE';
const ROUTE_HEADER = 'x-cindy-route';
const PID_HEADER = 'x-cindy-pid';
const PROMPT_MAX_BYTES = 4096;

export interface AskpassHostDeps {
  startTerminalPrompt(request: TerminalPromptRequest): { ok: true; abandon?(): void } | { ok: false };
  /** Teammate owner switch, current policy. Resolves true when 代输入 is off for the task. */
  isDisabledForSession(sessionId: string): Promise<boolean>;
  probe?: ProcessProbe;
  uid?: number;
  tmpRoot?: string;
  platform?: NodeJS.Platform;
  /** Values already set by the user win; ours fill only what is absent. */
  baseEnv?: NodeJS.ProcessEnv;
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
}

/** POSIX sh helper. It holds no secret; the route value comes from the task env. */
export function askpassHelperScript(socketPath: string): string {
  const quoted = `'${socketPath.replace(/'/g, `'\\''`)}'`;
  return [
    '#!/bin/sh',
    '# Cindy input handoff: asks the owner for the password this program needs.',
    `sock=${quoted}`,
    `route="\${${INPUT_HANDOFF_ROUTE_ENV}:-}"`,
    '[ -n "$route" ] && [ -S "$sock" ] || exit 1',
    'curl=/usr/bin/curl',
    '[ -x "$curl" ] || exit 1',
    // exec keeps this pid, so Cindy can check that the asker is this process's parent.
    `exec "$curl" -sS -f --no-buffer --max-time 3700 --unix-socket "$sock" \\`,
    `  -H "${ROUTE_HEADER}: $route" -H "${PID_HEADER}: $$" \\`,
    '  --data-urlencode "prompt=$1" http://cindy/askpass',
    '',
  ].join('\n');
}

export class AskpassHost {
  private dir: string | null = null;
  private server: http.Server | null = null;
  private preparing: Promise<void> | null = null;
  private readonly key = randomBytes(32);
  private readonly routes = new Map<string, string>();
  private readonly probe: ProcessProbe;
  private readonly uid: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: AskpassHostDeps) {
    this.platform = deps.platform ?? process.platform;
    this.probe = deps.probe ?? createSystemProcessProbe(this.platform);
    this.uid = deps.uid ?? (process.getuid?.() ?? -1);
  }

  get supported(): boolean {
    return (this.platform === 'darwin' || this.platform === 'linux') && this.uid >= 0;
  }

  get socketPath(): string | null {
    return this.dir ? path.join(this.dir, 's') : null;
  }

  get helperPath(): string | null {
    return this.dir ? path.join(this.dir, 'askpass') : null;
  }

  /** Creates the private directory, helper and socket once; recreates them if the OS cleaned tmp. */
  prepare(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    this.preparing ??= this.doPrepare().finally(() => { this.preparing = null; });
    return this.preparing;
  }

  /**
   * Variables for the commands of one local task. Deterministic for a task in
   * this app run, so a respawned agent process gets byte-identical env.
   */
  envFor(sessionId: string): Record<string, string> {
    const helper = this.helperPath;
    if (!this.supported || !helper || !sessionId) return {};
    void this.prepare();
    const route = createHmac('sha256', this.key).update(sessionId).digest('base64url').slice(0, 32);
    this.routes.set(route, sessionId);
    const base = this.deps.baseEnv ?? process.env;
    const wanted: Record<string, string> = {
      [INPUT_HANDOFF_ROUTE_ENV]: route,
      SUDO_ASKPASS: helper,
      SSH_ASKPASS: helper,
      SSH_ASKPASS_REQUIRE: 'force',
      GIT_ASKPASS: helper,
    };
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(wanted)) {
      if (name === INPUT_HANDOFF_ROUTE_ENV || !base[name]) out[name] = value;
    }
    // Without our askpass, forcing it would break the user's own setup.
    if (!out.SSH_ASKPASS) delete out.SSH_ASKPASS_REQUIRE;
    return out;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
    this.dir = null;
  }

  private async doPrepare(): Promise<void> {
    if (this.dir && this.server?.listening) {
      const alive = await stat(this.socketPath!).then((s) => s.isSocket(), () => false)
        && await stat(this.helperPath!).then((s) => s.isFile(), () => false);
      if (alive) return;
      await this.close();
    }
    const dir = await mkdtemp(path.join(this.deps.tmpRoot ?? os.tmpdir(), 'cindy-ih-'));
    await chmod(dir, 0o700);
    const socket = path.join(dir, 's');
    await writeFile(path.join(dir, 'askpass'), askpassHelperScript(socket), { mode: 0o700 });
    const server = http.createServer((req, res) => void this.handle(req, res));
    // Owners may take minutes to answer; the helper bounds its own wait.
    server.requestTimeout = 0;
    server.headersTimeout = 10_000;
    server.timeout = 0;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(socket, 0o600).catch(() => undefined);
    this.dir = dir;
    this.server = server;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const refuse = (reason: string) => {
      if (reason) this.deps.logger?.warn('input handoff askpass refused', { reason });
      if (!res.headersSent) res.writeHead(403, { 'content-type': 'text/plain' });
      res.end();
    };
    if (req.method !== 'POST' || req.url !== '/askpass') return refuse('request');
    const sessionId = this.routes.get(String(req.headers[ROUTE_HEADER] ?? ''));
    const pid = Number(req.headers[PID_HEADER]);
    const prompt = await readPrompt(req).catch(() => null);
    if (!sessionId || !Number.isSafeInteger(pid) || prompt === null) return refuse('request');
    const verdict = await verifyAskpassChain(this.probe, pid, this.socketPath ?? '\u0000', this.uid);
    if (!verdict.ok) return refuse(verdict.reason);
    if (await this.deps.isDisabledForSession(sessionId).catch(() => true)) return refuse('disabled');
    // The body is consumed, so only the connection tells whether the asker is still waiting.
    if (req.socket.destroyed) return;

    let settled = false;
    const started = this.deps.startTerminalPrompt({
      sessionId,
      prompt,
      program: verdict.asker.program,
      command: verdict.asker.command,
      answer: (value) => {
        if (settled) return;
        settled = true;
        if (value === null || res.destroyed) return refuse('');
        const body = Buffer.from(`${value}\n`, 'utf8');
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': body.length });
        res.end(body, () => body.fill(0));
      },
    });
    if (!started.ok) {
      settled = true;
      return refuse('');
    }
    res.on('close', () => {
      if (!settled) {
        settled = true;
        started.abandon?.();
      }
    });
  }
}

async function readPrompt(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > PROMPT_MAX_BYTES) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  const prompt = new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('prompt');
  if (prompt === null) throw new Error('missing');
  return prompt;
}
