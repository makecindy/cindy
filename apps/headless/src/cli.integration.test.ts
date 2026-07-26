import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { HeadlessDaemon } from './daemon.js';
import type { HeadlessPaths } from './paths.js';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cindyBin = path.join(repoRoot, 'apps', 'headless', 'src', 'bin', 'cindy.ts');
const cindyctlBin = path.join(repoRoot, 'apps', 'headless', 'src', 'bin', 'cindyctl.ts');
const dirs: string[] = [];

function testPaths(): HeadlessPaths {
  // Unix sockets have short pathname limits (104 bytes on macOS); keep this
  // integration fixture deliberately close to /tmp as the daemon does in CI.
  const root = fs.mkdtempSync('/tmp/cindy-h-');
  dirs.push(root);
  return {
    configDir: path.join(root, 'config', 'cindy-headless'),
    stateDir: path.join(root, 'state', 'cindy-headless'),
    runtimeDir: path.join(root, 'runtime', 'cindy-headless'),
    configFile: path.join(root, 'config', 'cindy-headless', 'config.json'),
    databaseFile: path.join(root, 'state', 'cindy-headless', 'sessions.db'),
    socketFile: path.join(root, 'runtime', 'cindy-headless', 'control.sock'),
  };
}

function cliEnv(paths: HeadlessPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.dirname(paths.configDir),
    XDG_STATE_HOME: path.dirname(paths.stateDir),
    XDG_RUNTIME_DIR: path.dirname(paths.runtimeDir),
  };
}

async function runCli(program: string, args: string[], env: NodeJS.ProcessEnv): Promise<unknown> {
  const { stdout } = await execFileAsync(process.execPath, [tsxCli, program, ...args], {
    cwd: repoRoot,
    env,
  });
  return JSON.parse(stdout) as unknown;
}

afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe('headless CLI', () => {
  it('uses the daemon socket for status, session creation, and session listing', async () => {
    const paths = testPaths();
    const daemon = new HeadlessDaemon(paths);
    await daemon.start();
    const env = cliEnv(paths);

    await expect(runCli(cindyctlBin, ['status'], env)).resolves.toMatchObject({ ok: true, result: { ok: true } });
    await expect(runCli(cindyBin, ['provider', 'list', '--agent', 'codex'], env)).resolves.toMatchObject({
      ok: true,
      result: expect.arrayContaining([expect.objectContaining({ id: 'openai' })]),
    });
    await expect(runCli(cindyBin, [
      'chat', 'new', '--agent', 'codex', '--provider', 'openai', '--model', 'gpt-5.6', '--workdir', '/srv/work/api',
      '--fast-mode', 'true',
    ], env)).resolves.toMatchObject({
      ok: true,
      result: { agentKind: 'codex', providerId: 'openai', model: 'gpt-5.6', workDir: '/srv/work/api', fastMode: true },
    });
    const listed = await runCli(cindyBin, ['chat', 'list'], env) as { result: Array<{ id: string }> };
    expect(listed).toMatchObject({
      ok: true,
      result: [{ agentKind: 'codex', providerId: 'openai', model: 'gpt-5.6' }],
    });
    await expect(runCli(cindyBin, ['chat', 'events', '--session', listed.result[0].id], env))
      .resolves.toMatchObject({ ok: true, result: [expect.objectContaining({ type: 'session_created' })] });

    await expect(runCli(cindyBin, ['orca', 'start', '--lead-session', listed.result[0].id], env))
      .resolves.toMatchObject({ ok: true, result: { leadSessionId: listed.result[0].id, status: 'active' } });
    const worker = await runCli(cindyBin, [
      'orca', 'add-worker', '--lead-session', listed.result[0].id, '--label', 'api', '--role', 'developer',
    ], env) as { result: { id: string; sessionId: string; label: string } };
    expect(worker).toMatchObject({ result: { id: expect.any(String), sessionId: expect.any(String), label: 'api' } });
    await expect(runCli(cindyBin, ['orca', 'list', '--lead-session', listed.result[0].id], env))
      .resolves.toMatchObject({ ok: true, result: [expect.objectContaining({ id: worker.result.id })] });

    const createdSchedule = await runCli(cindyBin, [
      'schedule', 'create', '--name', 'CI review', '--prompt', 'Review CI', '--cron', '0 * * * *',
      '--timezone', 'UTC', '--agent', 'codex', '--model', 'gpt-5.6', '--workdir', '/srv/work/api', '--manual', 'true',
    ], env) as { result: { id: string } };
    expect(createdSchedule).toMatchObject({ ok: true, result: { id: expect.any(String), manual: true } });
    await expect(runCli(cindyBin, ['schedule', 'pause', '--schedule', createdSchedule.result.id], env))
      .resolves.toMatchObject({ ok: true, result: { status: 'paused' } });
    await expect(runCli(cindyBin, ['schedule', 'list'], env))
      .resolves.toMatchObject({ ok: true, result: [expect.objectContaining({ id: createdSchedule.result.id })] });

    await daemon.stop();
  }, 20_000);

  it('allows a session created by one CLI process to be closed by the next', async () => {
    const paths = testPaths();
    const daemon = new HeadlessDaemon(paths);
    await daemon.start();
    const env = cliEnv(paths);

    const created = await runCli(cindyBin, [
      'chat', 'new', '--agent', 'codex', '--provider', 'openai', '--model', 'gpt-5.6', '--workdir', '/srv/work/one-shot',
    ], env) as { result: { id: string } };
    await expect(runCli(cindyBin, ['chat', 'close', '--session', created.result.id], env))
      .resolves.toMatchObject({ ok: true, result: { closed: true } });
    await expect(runCli(cindyBin, ['chat', 'list'], env))
      .resolves.toMatchObject({ ok: true, result: expect.arrayContaining([
        expect.objectContaining({ id: created.result.id, status: 'archived' }),
      ]) });

    await daemon.stop();
  }, 20_000);
});
