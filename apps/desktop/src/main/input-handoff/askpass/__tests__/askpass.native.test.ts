import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalPromptRequest } from '../../service.js';
import { AskpassHost, INPUT_HANDOFF_ROUTE_ENV } from '../host.js';

/**
 * Real processes, no real secrets: git asks a throwaway local server for Basic
 * auth through its HTTPS transport, exactly as it would for a private remote.
 * System and global git config are off, so no credential helper stores anything.
 */
const runnable = process.platform === 'darwin' || process.platform === 'linux';

const hosts: AskpassHost[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.close()));
  servers.splice(0).forEach((s) => s.close());
});

function run(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { env, timeout: 30_000 }, (error, stdout) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout: String(stdout) });
    });
  });
}

async function setup(answers: Record<string, string>, baseEnv: NodeJS.ProcessEnv = {}) {
  const prompts: TerminalPromptRequest[] = [];
  const host = new AskpassHost({
    isDisabledForSession: async () => false,
    baseEnv,
    startTerminalPrompt: (request) => {
      prompts.push(request);
      const key = Object.keys(answers).find((k) => request.prompt.startsWith(k));
      setTimeout(() => request.answer(key ? answers[key] : null), 10);
      return { ok: true };
    },
  });
  hosts.push(host);
  await host.prepare();
  const env = { ...host.envFor('task-1') };
  return { host, prompts, env };
}

describe.runIf(runnable)('代输入 askpass with real programs', () => {
  // Regression: launching a second host from a Cindy task must route git's
  // password to that host, without replacing a user-configured helper.
  it.each([false, true])('answers git over HTTP only in the owning host (nested=%s)', async (nested) => {
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization ?? '');
      if (req.headers.authorization) res.writeHead(404).end();
      else res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' }).end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const parent = nested ? await setup({}) : undefined;
    const { prompts, env } = await setup({ Username: 'someone', Password: 'synthetic-pass' }, parent?.env);

    const result = await run('git', ['-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${port}/r.git`], {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    });

    expect(result.stdout).not.toContain('synthetic-pass');
    expect(seen).toContain(`Basic ${Buffer.from('someone:synthetic-pass').toString('base64')}`);
    expect(prompts.map((p) => p.program)).toEqual(['git', 'git']);
    expect(prompts[0].command).toContain('ls-remote');
    expect(prompts[0].sessionId).toBe('task-1');
    expect(parent?.prompts ?? []).toHaveLength(0);
    if (parent) {
      const custom = await setup({}, { ...parent.env, GIT_ASKPASS: '/usr/bin/false' });
      const declined = await run('git', ['-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${port}/r.git`], {
        PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0', ...parent.env, GIT_ASKPASS: '/usr/bin/false', ...custom.env,
      });
      expect(declined.code).not.toBe(0);
      expect(custom.prompts).toHaveLength(0);
    }
  });

  it('refuses the helper when the agent calls it directly', async () => {
    const { prompts, env, host } = await setup({ Password: 'synthetic-pass' });
    const result = await run('/bin/sh', ['-c', '"$SUDO_ASKPASS" "Password:"'], { PATH: process.env.PATH, ...env });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(prompts).toHaveLength(0);
    expect(env[INPUT_HANDOFF_ROUTE_ENV]).toBeTruthy();
    expect(host.helperPath).toBeTruthy();
  });

  it('refuses a route that was never given to a task', async () => {
    const { prompts, env } = await setup({ Password: 'synthetic-pass' });
    const result = await run('/bin/sh', ['-c', '"$SUDO_ASKPASS" "Password:"'], {
      PATH: process.env.PATH,
      ...env,
      [INPUT_HANDOFF_ROUTE_ENV]: 'forged',
    });
    expect(result.stdout).toBe('');
    expect(prompts).toHaveLength(0);
  });
});
