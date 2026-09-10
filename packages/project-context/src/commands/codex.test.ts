import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import spawn from 'cross-spawn';
import { resolvePaths } from '../config.js';
import { readKnowledgeFile, writeKnowledgeFile } from '../knowledge.js';
import { rebuildManifestFromDisk, writeManifest } from '../manifest.js';
import { runRefresh } from './refresh.js';
import { runUpdate } from './update.js';
import * as gitApi from '../git.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
const dirs: string[] = [];
const oldBody = '# 示例\n\n## 是什么\n\n旧描述。\n\n## 模块边界\n\n本地模块。\n';
const newBody = oldBody.replace('旧描述。', '新版描述。');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(spawn).mockReset();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(realGit = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-command-test-'));
  dirs.push(cwd);
  if (realGit) {
    // 同时隔离 runRefresh 内 simple-git 启动的子进程。
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(cwd, 'empty-config'));
  }
  // 隔离 Git 全局配置和 hooks，不读取用户 HOME 或 Agent 凭证。
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        'core.hooksPath=' + path.join(cwd, 'empty-hooks'),
        ...args,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: path.join(cwd, 'empty-config'),
        },
      },
    ).trim();
  if (realGit) git('init', '--quiet');
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src', 'index.ts'), 'export const value = 1;\n');
  let base = 'a'.repeat(40);
  if (realGit) {
    git('add', 'src');
    git('commit', '--quiet', '-m', 'fixture');
    base = git('rev-parse', 'HEAD');
  } else {
    vi.spyOn(gitApi, 'findRepoRoot').mockResolvedValue(cwd);
    vi.spyOn(gitApi, 'getCurrentHead').mockResolvedValue('b'.repeat(40));
    vi.spyOn(gitApi, 'getDiff').mockResolvedValue({
      files: ['src/index.ts'],
      fileStats: [{ file: 'src/index.ts', insertions: 1, deletions: 1 }],
      insertions: 1,
      deletions: 1,
    });
    vi.spyOn(gitApi, 'getDiffText').mockResolvedValue(
      '-export const value = 1;\n+export const value = 2;',
    );
  }
  const paths = resolvePaths(cwd);
  fs.mkdirSync(paths.modulesDir, { recursive: true });
  fs.writeFileSync(paths.configPath, 'agent: codex\n');
  const file = path.join(paths.modulesDir, 'example.md');
  writeKnowledgeFile(
    file,
    {
      id: 'example',
      type: 'module',
      covers: ['src/**'],
      last_synced_commit: base,
      last_synced_at: '2026-01-01T00:00:00.000Z',
      stale: false,
      schema_version: 1,
    },
    oldBody,
  );
  const manifest = () => writeManifest(paths.manifestPath, rebuildManifestFromDisk(paths));
  manifest();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  return { cwd, paths, file, manifest };
}

function respond(content: string, terminal = 'turn.completed') {
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    child.stdin.on('finish', () => {
      fs.writeFileSync(args![args!.indexOf('--output-last-message') + 1], content);
      child.stdout.write(JSON.stringify({ type: terminal }) + '\n');
      child.emit('close', 0);
    });
    return child as unknown as ReturnType<typeof spawn>;
  });
}

it.each(['refresh', 'update'] as const)('%s 拒绝改写演进备忘，保留旧正文并可恢复', async (mode) => {
  const f = fixture();
  const history = '- 2026-01-01：保留接口。\n\n```md\n## 历史示例\n旧内容\n```';
  const previous = readKnowledgeFile(f.file);
  writeKnowledgeFile(f.file, previous.frontmatter, oldBody + '\n## 演进备忘\n\n' + history);
  f.manifest();
  const original = readKnowledgeFile(f.file).body;
  const run = () =>
    mode === 'refresh' ? runRefresh({ cwd: f.cwd, all: true }) : runUpdate({ cwd: f.cwd });
  for (const invalid of [
    '',
    history.replace('保留接口', '删除接口'),
    history.replace('旧内容', '新内容'),
    '- 新记录\n' + history,
  ]) {
    respond(newBody + '\n## 演进备忘\n\n' + invalid);
    await run();
    const rejected = readKnowledgeFile(f.file);
    expect(rejected.body).toBe(original);
    expect(rejected.frontmatter.stale).toBe(true);
    expect(rejected.frontmatter.stale_reason).toContain('演进备忘');
  }
  respond(newBody + '\n## 演进备忘\n\n' + history + '\n\n- 2026-09-10：新增记录。');
  await runRefresh({ cwd: f.cwd, stale: true });
  const recovered = readKnowledgeFile(f.file);
  expect(recovered.frontmatter.stale).toBe(false);
  expect(recovered.body).toContain(history + '\n\n- 2026-09-10');
});

it.each([1, 2, 3])('接受 %s 个空格缩进的章节并生成正确 TOC', async (spaces) => {
  const f = fixture();
  respond(newBody.replace(/^## /gm, ' '.repeat(spaces) + '## '));
  expect((await runRefresh({ cwd: f.cwd, all: true })).refreshed).toEqual(['example']);
  expect(fs.readFileSync(f.paths.tocPath, 'utf8')).toContain('**example** — 新版描述。');
});

it.each(['```ts\nconst example = 1;\n```', '~~~ts\nconst example = 1;\n~~~'])(
  '拒绝代码围栏开头的摘要：%s',
  async (example) => {
    const f = fixture();
    const original = readKnowledgeFile(f.file).body;
    respond(newBody.replace('新版描述。', example + '\n\n新版描述。'));
    expect((await runRefresh({ cwd: f.cwd, all: true })).failed).toHaveLength(1);
    expect(readKnowledgeFile(f.file).body).toBe(original);
    expect(readKnowledgeFile(f.file).frontmatter.stale).toBe(true);
  },
);

it('摘要后的代码示例保持可用', async () => {
  const f = fixture();
  respond(newBody.replace('新版描述。', '新版描述。\n\n```ts\nconst example = 1;\n```'));
  expect((await runRefresh({ cwd: f.cwd, all: true })).refreshed).toEqual(['example']);
  expect(fs.readFileSync(f.paths.tocPath, 'utf8')).toContain('**example** — 新版描述。');
  expect(fs.readFileSync(f.paths.tocPath, 'utf8')).not.toContain('const example');
});

it('TOC 无法识别的摘要标题保留旧正文并标 stale', async () => {
  const f = fixture();
  const previous = readKnowledgeFile(f.file).body;
  respond(newBody.replace('## 是什么', '## 是什么 ##'));
  expect((await runRefresh({ cwd: f.cwd, all: true })).failed).toHaveLength(1);
  expect(readKnowledgeFile(f.file).body).toBe(previous);
  expect(readKnowledgeFile(f.file).frontmatter.stale).toBe(true);
});

it('真实 Git smoke：刷新失败后 --stale 恢复正文和 TOC', async () => {
  const f = fixture(true);
  const previous = readKnowledgeFile(f.file);
  respond('');
  expect((await runRefresh({ cwd: f.cwd, all: true })).failed).toHaveLength(1);
  expect(readKnowledgeFile(f.file).body).toBe(previous.body);
  expect(readKnowledgeFile(f.file).frontmatter.stale).toBe(true);
  expect(fs.existsSync(f.paths.lockPath)).toBe(false);
  respond(newBody);
  expect((await runRefresh({ cwd: f.cwd, stale: true })).refreshed).toEqual(['example']);
  const updated = readKnowledgeFile(f.file);
  expect(updated.body.trim()).toBe(newBody.trim());
  expect(updated.frontmatter.stale).toBe(false);
  expect(updated.frontmatter.last_synced_commit).toBe(previous.frontmatter.last_synced_commit);
  expect(fs.readFileSync(f.paths.tocPath, 'utf8')).toContain('新版描述');
  // 原生 realpath 才会展开 Windows 8.3 短路径，与 Git 返回的长路径一致。
  expect(fs.realpathSync.native(String(vi.mocked(spawn).mock.calls[0][2]?.cwd))).toBe(
    fs.realpathSync.native(f.cwd),
  );
});

it.each([true, false])('小 diff 更新成功=%s，宿主维护同步元数据并从仓库根启动', async (success) => {
  const f = fixture();
  fs.writeFileSync(path.join(f.cwd, 'src', 'index.ts'), 'export const value = 2;\n');
  const previous = readKnowledgeFile(f.file);
  respond(newBody, success ? 'turn.completed' : 'turn.failed');
  const result = await runUpdate({ cwd: path.join(f.cwd, 'src') });
  expect(success ? result.updated : result.staled).toEqual(['example']);
  const updated = readKnowledgeFile(f.file);
  expect(updated.body.trim()).toBe((success ? newBody : previous.body).trim());
  expect(updated.frontmatter.stale).toBe(!success);
  expect(updated.frontmatter.last_synced_commit).toBe('b'.repeat(40));
  expect(path.resolve(String(vi.mocked(spawn).mock.calls[0][2]?.cwd))).toBe(f.cwd);
  expect(fs.existsSync(f.paths.lockPath)).toBe(false);
});

it.each(['check-only', 'frozen'] as const)(
  '%s 下 refresh/update 不启动 Agent、不修改知识',
  async (mode) => {
    const f = fixture();
    if (mode === 'frozen') {
      const knowledge = readKnowledgeFile(f.file);
      writeKnowledgeFile(f.file, { ...knowledge.frontmatter, auto_update: false }, knowledge.body);
      f.manifest();
    }
    const before = fs.readFileSync(f.file, 'utf8');
    fs.writeFileSync(path.join(f.cwd, 'src', 'index.ts'), 'export const value = 2;\n');
    await runRefresh({ cwd: f.cwd, all: true, checkOnly: mode === 'check-only' });
    await runUpdate({ cwd: f.cwd, checkOnly: mode === 'check-only' });
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
    expect(fs.existsSync(f.paths.lockPath)).toBe(false);
  },
);
