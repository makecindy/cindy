/**
 * cleanup-cli.test.ts — CLI 参数 / 审阅绑定 / 宿主 comm 的默认单测。
 *
 * Codex P1 on #2561: 默认 unit 层只保留一条 CLI subprocess smoke,
 * 其余走 in-process 辅助函数 (parseCleanupCliArgs / planMemoryCleanup)。
 */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CleanupCliUsageError,
  bindReviewedStaleCandidates,
  isCindyHostComm,
  normalizeProcessComm,
  parseCleanupCliArgs,
  parseReviewedStalePlan,
  planMemoryCleanup,
  requireFromPlanForArchiveStale,
  resolveReviewedKeepDigests,
  runMemoryCleanup,
} from './cleanup.js';

const repoRoot = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const cli = path.join(repoRoot, 'scripts', 'cleanup-maker-memory.mjs');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'memory-cleanup-cli-'));
  await writeFile(
    path.join(dir, 'meta.json'),
    JSON.stringify({
      absPath: dir,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
    }),
    'utf8',
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function shard(
  filename: string,
  type: string,
  title: string,
  description: string,
  body: string,
  updatedAt: string,
): Promise<void> {
  const raw = [
    '---',
    `title: ${title}`,
    `description: ${description}`,
    `type: ${type}`,
    `updatedAt: '${updatedAt}'`,
    '---',
    body,
    '',
  ].join('\n');
  await writeFile(path.join(dir, filename), raw, 'utf8');
}

function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
      cwd: repoRoot,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => {
      stdout += String(b);
    });
    child.stderr.on('data', (b) => {
      stderr += String(b);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function resultJson(stdout: string): Record<string, unknown> {
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith('RESULT '));
  if (!line) throw new Error(`no RESULT line in: ${stdout}`);
  return JSON.parse(line.slice('RESULT '.length)) as Record<string, unknown>;
}

describe('cleanup-maker-memory CLI in-process helpers', () => {
  it('refuses --apply --archive-stale without --from-plan', () => {
    const parsed = parseCleanupCliArgs([
      '--shard',
      dir,
      '--apply',
      '--archive-stale',
      '--force',
      '--json',
    ]);
    expect(parsed.help).toBeUndefined();
    if (parsed.help) throw new Error('unexpected help');
    expect(() => requireFromPlanForArchiveStale(parsed.options)).toThrow(CleanupCliUsageError);
    expect(() => requireFromPlanForArchiveStale(parsed.options)).toThrow(/--from-plan/);
  });

  it('apply --from-plan uses reviewed keep-digests instead of the default 2', async () => {
    await shard('digest_a.md', 'digest', 'A', 'hook', 'a', '2026-01-01T00:00:00.000Z');
    await shard('digest_b.md', 'digest', 'B', 'hook', 'b', '2026-02-01T00:00:00.000Z');
    await shard('digest_c.md', 'digest', 'C', 'hook', 'c', '2026-03-01T00:00:00.000Z');
    await shard('digest_d.md', 'digest', 'D', 'hook', 'd', '2026-04-01T00:00:00.000Z');
    await shard('digest_e.md', 'digest', 'E', 'hook', 'e', '2026-05-01T00:00:00.000Z');
    const parsed = parseReviewedStalePlan({
      version: 1,
      shardDir: dir,
      keepDigests: 5,
      archiveStale: false,
      staleFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      staleCandidates: [],
    });
    const keepDigests = resolveReviewedKeepDigests(null, parsed.keepDigests);
    expect(keepDigests).toBe(5);
    const plan = await planMemoryCleanup(dir, { keepDigests: keepDigests ?? undefined });
    expect(plan.digests.keep).toHaveLength(5);
    expect(plan.digests.archive).toHaveLength(0);
    const result = await runMemoryCleanup(plan);
    expect(result.failed).toHaveLength(0);
    expect(result.archived).toHaveLength(0);
    for (const name of ['digest_a.md', 'digest_b.md', 'digest_c.md', 'digest_d.md', 'digest_e.md']) {
      await expect(readFile(path.join(dir, name), 'utf8')).resolves.toBeTruthy();
    }
  });

  it('rejects --from-plan filenames that escape the shard', () => {
    expect(() =>
      parseReviewedStalePlan({
        version: 1,
        shardDir: dir,
        keepDigests: 2,
        archiveStale: true,
        staleFingerprint: '00',
        staleCandidates: [{ filename: '../other-shard/project_x.md', expectedHash: 'abc' }],
      }),
    ).toThrow(/basename|canonical/);
  });

  it('rejects a reviewed plan whose keepDigests is negative', () => {
    expect(() =>
      parseReviewedStalePlan({
        version: 1,
        shardDir: dir,
        keepDigests: -100,
        archiveStale: false,
        staleFingerprint: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        staleCandidates: [],
      }),
    ).toThrow(/keepDigests/);
  });

  it('declares tsx on the repo-root installer graph for node --import tsx', async () => {
    const pkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    expect(pkg.devDependencies?.tsx).toMatch(/^\^4\./);
  });

  it('parses CLI flags in-process without spawning node', () => {
    const help = parseCleanupCliArgs(['--help']);
    expect(help).toEqual({ help: true });
    const parsed = parseCleanupCliArgs([
      '--shard',
      '/tmp/s',
      '--apply',
      '--from-plan',
      'plan.json',
      '--keep-digests',
      '5',
      '--force',
      '--json',
    ]);
    expect(parsed.help).toBeUndefined();
    if (parsed.help) throw new Error('unexpected help');
    expect(parsed.options).toMatchObject({
      shard: '/tmp/s',
      dryRun: false,
      fromPlan: 'plan.json',
      keepDigests: 5,
      force: true,
      json: true,
    });
    expect(() => parseCleanupCliArgs(['--keep-digests', '-100'])).toThrow(CleanupCliUsageError);
    expect(() =>
      resolveReviewedKeepDigests(2, 5),
    ).toThrow(/keep-digests/);
  });
});

describe('normalizeProcessComm (Codex P1 macOS ps paths)', () => {
  it('matches packaged macOS bundle executables by basename', () => {
    expect(normalizeProcessComm('/Applications/Cindy.app/Contents/MacOS/Cindy')).toBe('cindy');
    expect(isCindyHostComm('/Applications/Cindy.app/Contents/MacOS/Cindy')).toBe(true);
    expect(isCindyHostComm('/Applications/CindyDev.app/Contents/MacOS/CindyDev')).toBe(true);
    expect(isCindyHostComm('/Applications/Electron.app/Contents/MacOS/Electron')).toBe(true);
    expect(isCindyHostComm('out/Cindy-darwin-arm64/Cindy.app/Contents/MacOS/Cindy')).toBe(true);
  });

  it('still matches linux-style bare comm names', () => {
    expect(isCindyHostComm('cindy')).toBe(true);
    expect(isCindyHostComm('electron')).toBe(true);
    expect(isCindyHostComm('  Cindy  ')).toBe(true);
  });

  it('does not treat unrelated apps as the Cindy host', () => {
    expect(isCindyHostComm('/Applications/Codex.app/Contents/MacOS/Codex')).toBe(false);
    expect(isCindyHostComm('/usr/bin/python3')).toBe(false);
    expect(isCindyHostComm('COMM')).toBe(false);
    expect(isCindyHostComm('')).toBe(false);
  });
});

describe('cleanup-maker-memory CLI subprocess smoke', () => {
  it('dry-run --write-plan emits expectedHash + fingerprint via one Node+tsx process', async () => {
    await shard('project_done.md', 'project', 'Done', 'hook', '这个项目已归档',
      '2026-01-01T00:00:00.000Z');
    const planPath = path.join(dir, 'reviewed-plan.json');
    const dry = await runCli([
      '--shard',
      dir,
      '--dry-run',
      '--archive-stale',
      '--write-plan',
      planPath,
      '--json',
    ]);
    expect(dry.code).toBe(0);
    const dryJson = resultJson(dry.stdout);
    expect(typeof dryJson.staleFingerprint).toBe('string');
    const stale = dryJson.staleCandidates as Array<{ filename: string; expectedHash: string }>;
    expect(stale).toHaveLength(1);
    expect(stale[0].filename).toBe('project_done.md');
    expect(stale[0].expectedHash).toMatch(/^[0-9a-f]{64}$/);
    const written = JSON.parse(await readFile(planPath, 'utf8')) as {
      keepDigests: number;
      staleCandidates: Array<{ filename: string }>;
    };
    expect(written.keepDigests).toBe(2);
    expect(written.staleCandidates.map((c) => c.filename)).toEqual(['project_done.md']);

    await shard('project_later.md', 'project', 'Later', 'hook', '这个项目已结束',
      '2026-02-01T00:00:00.000Z');
    const live = await planMemoryCleanup(dir);
    const reviewed = parseReviewedStalePlan(written);
    const { extraLive } = bindReviewedStaleCandidates(live, reviewed.staleCandidates);
    expect(extraLive.map((c) => c.filename)).toEqual(['project_later.md']);
    const result = await runMemoryCleanup(live, { archiveStale: true });
    expect(result.failed).toHaveLength(0);
    expect(result.archived.map((a) => a.filename)).toEqual(['project_done.md']);
    await expect(readFile(path.join(dir, 'project_later.md'), 'utf8')).resolves.toContain('已结束');
  });
});
