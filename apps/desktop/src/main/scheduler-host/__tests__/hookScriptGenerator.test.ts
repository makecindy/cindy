/**
 * hook-script-generator 纯函数与编排测试:代码块提取、slug、路径解析、命令拼装、
 * 修改流复用路径、生成失败不落盘。
 *
 * @vitest-environment node
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Maker } from '@cindy/maker-core';

import {
  buildHookCommand,
  buildHookScriptPrompt,
  extractScriptFromResponse,
  generateHookScript,
  hookScriptSlug,
  installHookScript,
  parseGeneratedScriptPath,
  resolveHookScriptPath,
  stabilizeHookCommand,
} from '../hook-script-generator';

const fakeMaker = {} as Maker;
const utilitySuccess = (text: string) => ({
  ok: true as const,
  text,
  providerId: 'test-provider',
  model: 'test-model',
  transport: 'codex-responses' as const,
});

describe('extractScriptFromResponse', () => {
  it('提取 ```js fenced block', () => {
    const text = '```js\nprocess.exit(2)\n```';
    expect(extractScriptFromResponse(text)).toBe('process.exit(2)');
  });

  it('提取裸 ``` fenced block 并忽略前后解释文字', () => {
    const text = 'Here is the script:\n```\nimport fs from "node:fs";\nprocess.exit(0)\n```\nDone.';
    expect(extractScriptFromResponse(text)).toContain('import fs');
  });

  it('无 fence 但首行是代码形态 → 接受原文', () => {
    expect(extractScriptFromResponse('import x from "node:fs";\nprocess.exit(0)')).toContain('import x');
  });

  it('无 fence 且是散文 → null(不落半成品)', () => {
    expect(extractScriptFromResponse('I cannot write this script, sorry.')).toBeNull();
    expect(extractScriptFromResponse('')).toBeNull();
  });
});

const shellQuote = (p: string): string =>
  process.platform === 'win32' ? `"${p}"` : `'${p}'`;

describe('hookScriptSlug / parseGeneratedScriptPath / buildHookCommand', () => {
  it('slug:ASCII 名字连字化;中文回落 check', () => {
    expect(hookScriptSlug('Check New PRs')).toBe('check-new-prs');
    expect(hookScriptSlug('检查新PR', '有新 PR 才跑')).toBe('check');
    expect(hookScriptSlug(undefined, 'run when ci fails')).toBe('run-when-ci-fails');
  });

  it('parseGeneratedScriptPath 只认本生成器产出的命令形态', () => {
    expect(parseGeneratedScriptPath('node scripts/schedule-checks/x.mjs')).toBe(
      'scripts/schedule-checks/x.mjs',
    );
    expect(parseGeneratedScriptPath('node "C:\\a b\\x.mjs"')).toBe('C:\\a b\\x.mjs');
    // POSIX shellQuotePath 的单引号形态(修改流复用不因转义方式换代而失效)
    expect(parseGeneratedScriptPath("node '/a b/x.mjs'")).toBe('/a b/x.mjs');
    expect(parseGeneratedScriptPath("xdt-node '/Users/x/Library/hooks/check.mjs'")).toBe(
      '/Users/x/Library/hooks/check.mjs',
    );
    expect(parseGeneratedScriptPath('python check.py')).toBeNull();
    expect(parseGeneratedScriptPath('node x.mjs && echo hi')).toBeNull();
    expect(parseGeneratedScriptPath(undefined)).toBeNull();
  });

  it('buildHookCommand:项目内相对路径(正斜杠),项目外绝对路径加引号', () => {
    const wd = path.join(tmpdir(), 'proj');
    const inside = path.join(wd, 'scripts', 'schedule-checks', 'a.mjs');
    expect(buildHookCommand(inside, wd)).toBe('node scripts/schedule-checks/a.mjs');
    const outside = path.join(tmpdir(), 'elsewhere', 'a.mjs');
    expect(buildHookCommand(outside, wd)).toBe(`node ${shellQuote(outside)}`);
    expect(buildHookCommand(outside)).toBe(`node ${shellQuote(outside)}`);
  });

  it('buildHookCommand:相对路径含 shell 元字符(修改流复用的任意旧路径)加引号', () => {
    const wd = path.join(tmpdir(), 'proj');
    const weird = path.join(wd, 'scripts', 'check(weekday).mjs');
    expect(buildHookCommand(weird, wd)).toBe(`node ${shellQuote('scripts/check(weekday).mjs')}`);
    const spaced = path.join(wd, 'my scripts', 'check.mjs');
    expect(buildHookCommand(spaced, wd)).toBe(`node ${shellQuote('my scripts/check.mjs')}`);
  });

  it('stabilizeHookCommand 把支持的相对脚本命令固化为绝对路径', () => {
    const wd = path.join(tmpdir(), 'hook-stable');
    const script = path.join(wd, 'scripts', 'schedule-checks', 'check.mjs');
    expect(
      stabilizeHookCommand('node scripts/schedule-checks/check.mjs', wd, (p) => p === script),
    ).toBe(`node ${shellQuote(script)}`);
  });

  it('stabilizeHookCommand 在文件不存在或缺少原 cwd 时明确报错', () => {
    expect(() => stabilizeHookCommand('node scripts/check.mjs', undefined)).toThrow(
      /original working directory/,
    );
    expect(() => stabilizeHookCommand('node scripts/check.mjs', tmpdir(), () => false)).toThrow(
      /not found/,
    );
  });

  it('stabilizeHookCommand 保留任意 cwd 命令与绝对脚本命令', () => {
    const absolute = path.join(tmpdir(), 'check.mjs');
    expect(stabilizeHookCommand('pnpm check', tmpdir())).toBe('pnpm check');
    expect(stabilizeHookCommand(`node ${shellQuote(absolute)}`, tmpdir())).toBe(
      `node ${shellQuote(absolute)}`,
    );
  });

  it('resolveHookScriptPath:复用修改流路径;新建避让同名文件', () => {
    const taken = new Set([path.join('/fb', 'check.mjs')]);
    const reuse = resolveHookScriptPath({
      fallbackDir: '/fb',
      slug: 'check',
      reusePath: '/old/check.mjs',
      exists: (p) => taken.has(p),
    });
    expect(reuse.filePath).toBe('/old/check.mjs');
    const fresh = resolveHookScriptPath({
      fallbackDir: '/fb',
      slug: 'check',
      reusePath: null,
      exists: (p) => taken.has(p),
    });
    expect(fresh.filePath).toBe(path.join('/fb', 'check-2.mjs'));
  });
});

describe('buildHookScriptPrompt', () => {
  it('包含协议要点、平台、用户需求;修改流附现有脚本', () => {
    const prompt = buildHookScriptPrompt({
      description: '有新 PR 才跑',
      platform: 'win32',
      scheduleName: 'PR 巡检',
      workingDir: 'C:/repo',
      currentScript: 'process.exit(0)',
    });
    expect(prompt).toContain('Exit code 0');
    expect(prompt).toContain('CINDY_PRECHECK_OK as a standalone stdout line before exit 0 or 2');
    expect(prompt).toContain('Never emit it for rate-limit/backoff skips or incomplete/degraded checks');
    expect(prompt).toContain('Windows');
    expect(prompt).toContain('有新 PR 才跑');
    expect(prompt).toContain('C:/repo');
    expect(prompt).toContain('process.exit(0)');
    expect(prompt).toContain('MODIFIED');
  });
});

describe('generateHookScript(编排)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-hookgen-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('生成 → 落盘 workingDir/scripts/schedule-checks → 相对路径命令', async () => {
    const result = await generateHookScript(
      {
        maker: fakeMaker,
        fallbackDir: path.join(dir, 'fb'),
        requestText: async () => utilitySuccess('```js\nprocess.exit(2)\n```'),
      },
      { description: 'run when ci fails', scheduleName: 'CI Watch', workingDir: dir },
    );
    expect(result.command).toBe(`node ${shellQuote(result.filePath)}`);
    expect(existsSync(result.filePath)).toBe(true);
    expect(readFileSync(result.filePath, 'utf8')).toBe('process.exit(2)\n');
  });

  it('把任务 provider / agent / model 透传给 utility 请求', async () => {
    let seen: Record<string, unknown> | undefined;
    await generateHookScript(
      {
        maker: fakeMaker,
        fallbackDir: path.join(dir, 'fb'),
        requestText: async (_maker, _prompt, opts) => {
          seen = opts;
          return utilitySuccess('```js\nprocess.exit(0)\n```');
        },
      },
      {
        description: 'use custom provider',
        providerId: 'tapsvc',
        agentKind: 'codex',
        model: 'custom-mini',
      },
    );
    expect(seen).toMatchObject({ providerId: 'tapsvc', agentKind: 'codex', model: 'custom-mini' });
  });

  it('无 workingDir → 落 fallbackDir + 绝对路径命令', async () => {
    const fb = path.join(dir, 'fb');
    const result = await generateHookScript(
      {
        maker: fakeMaker,
        fallbackDir: fb,
        requestText: async () => utilitySuccess('```\nprocess.exit(0)\n```'),
      },
      { description: 'check something' },
    );
    expect(result.filePath.startsWith(fb)).toBe(true);
    expect(result.command).toBe(`node ${shellQuote(result.filePath)}`);
  });

  it('修改流:命令指向已生成脚本 → 覆写同一路径,现有内容进 prompt', async () => {
    const scriptDir = path.join(dir, 'scripts', 'schedule-checks');
    mkdirSync(scriptDir, { recursive: true });
    const old = path.join(scriptDir, 'ci-watch.mjs');
    writeFileSync(old, 'process.exit(0)\n', 'utf8');
    let seenPrompt = '';
    const result = await generateHookScript(
      {
        maker: fakeMaker,
        fallbackDir: path.join(dir, 'fb'),
        requestText: async (_m, prompt) => {
          seenPrompt = prompt;
          return utilitySuccess('```js\nprocess.exit(2)\n```');
        },
      },
      {
        description: '改成只在工作日跑',
        scheduleName: 'CI Watch',
        workingDir: dir,
        currentCommand: 'node scripts/schedule-checks/ci-watch.mjs',
      },
    );
    expect(result.filePath).toBe(old);
    expect(readFileSync(old, 'utf8')).toBe('process.exit(2)\n');
    expect(seenPrompt).toContain('MODIFIED');
    expect(result.command).toBe(`node ${shellQuote(result.filePath)}`);
  });

  it('模型响应无代码块 → throw 且不落盘', async () => {
    const fb = path.join(dir, 'fb');
    await expect(
      generateHookScript(
        {
          maker: fakeMaker,
          fallbackDir: fb,
          requestText: async () => utilitySuccess('sorry, cannot do that'),
        },
        { description: 'x y z' },
      ),
    ).rejects.toThrow(/code block/);
    expect(existsSync(fb)).toBe(false);
  });

  it('utility model 全不可用 → 抛出共享错误码与结构化诊断', async () => {
    await expect(
      generateHookScript(
        {
          maker: fakeMaker,
          fallbackDir: path.join(dir, 'fb'),
          requestText: async () => ({
            ok: false,
            reason: 'no_candidate',
            attempts: [{
              providerId: 'codex-gpt-5.4-mini',
              model: 'gpt-5.4-mini',
              transport: 'codex-responses',
              status: 'skipped',
              reason: 'not_authenticated',
            }],
          }),
        },
        { description: 'x y z' },
      ),
    ).rejects.toThrow(/\[UTILITY_MODEL_NO_CANDIDATE\].*not_authenticated/);
  });
});

describe('installHookScript(统一安装通道:script/description 双模式 + 自测)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-hookinstall-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('script 模式:agent 提供内容 → 落盘规范路径 + 自测返回 skip(exit 2)', async () => {
    const result = await installHookScript(
      { maker: null, fallbackDir: path.join(dir, 'fb') },
      {
        script: 'process.exit(2)',
        description: undefined,
        scheduleName: 'PR Watch',
        workingDir: dir,
      },
    );
    expect(result.command).toBe(`node ${shellQuote(result.filePath)}`);
    expect(readFileSync(result.filePath, 'utf8')).toBe('process.exit(2)\n');
    expect(result.test.decision).toBe('skip');
    expect(result.test.exitCode).toBe(2);
  });

  it('description 模式:走生成器(stub)+ 自测返回 run(exit 0)', async () => {
    const result = await installHookScript(
      {
        maker: null,
        fallbackDir: path.join(dir, 'fb'),
        requestText: async () => utilitySuccess('```js\nprocess.exit(0)\n```'),
      },
      { description: 'always run' },
    );
    expect(result.test.decision).toBe('run');
    expect(result.test.exitCode).toBe(0);
  });

  it('script 与 description 都缺 → throw', async () => {
    await expect(
      installHookScript(
        { maker: null, fallbackDir: path.join(dir, 'fb') },
        { description: '   ', script: '  ' },
      ),
    ).rejects.toThrow(/required/);
  });

  it('script 模式修改流:currentCommand 指向已生成脚本 → 覆写同一路径', async () => {
    const scriptDir = path.join(dir, 'scripts', 'schedule-checks');
    mkdirSync(scriptDir, { recursive: true });
    const old = path.join(scriptDir, 'pr-watch.mjs');
    writeFileSync(old, 'process.exit(0)\n', 'utf8');
    const result = await installHookScript(
      { maker: null, fallbackDir: path.join(dir, 'fb') },
      {
        script: 'process.exit(2)',
        scheduleName: 'PR Watch',
        workingDir: dir,
        currentCommand: 'node scripts/schedule-checks/pr-watch.mjs',
      },
    );
    expect(result.filePath).toBe(old);
    expect(readFileSync(old, 'utf8')).toBe('process.exit(2)\n');
  });

  it('description 模式且 maker 未就绪(无 stub)→ 明确报错', async () => {
    await expect(
      installHookScript(
        { maker: null, fallbackDir: path.join(dir, 'fb') },
        { description: 'check things' },
      ),
    ).rejects.toThrow(/maker not ready/);
  });
});

describe('运行时探测:系统无 node 时命令用 xdt-node 兜底', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'xdmaker-hookruntime-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('description 模式:hasSystemNode=false → xdt-node 前缀命令', async () => {
    const result = await installHookScript(
      {
        maker: null,
        fallbackDir: path.join(dir, 'fb'),
        requestText: async () => utilitySuccess('```js\nprocess.exit(0)\n```'),
        hasSystemNode: async () => false,
      },
      { description: 'always run', scheduleName: 'X Y', workingDir: dir },
    );
    expect(result.command).toBe(`xdt-node ${shellQuote(result.filePath)}`);
    // 自测走执行器的 xdt-node 解析(测试环境 execPath 即 node),照样能跑
    expect(result.test.exitCode).toBe(0);
  });

  it('script 模式:hasSystemNode=true → 维持 node 前缀', async () => {
    const result = await installHookScript(
      {
        maker: null,
        fallbackDir: path.join(dir, 'fb'),
        hasSystemNode: async () => true,
      },
      { script: 'process.exit(0)', workingDir: dir, scheduleName: 'Plain' },
    );
    expect(result.command).toBe(`node ${shellQuote(result.filePath)}`);
  });

  it('修改流识别 xdt-node 前缀命令并覆写同一路径', async () => {
    const scriptDir = path.join(dir, 'scripts', 'schedule-checks');
    mkdirSync(scriptDir, { recursive: true });
    const old = path.join(scriptDir, 'x-y.mjs');
    writeFileSync(old, 'process.exit(0)\n', 'utf8');
    const result = await installHookScript(
      {
        maker: null,
        fallbackDir: path.join(dir, 'fb'),
        hasSystemNode: async () => false,
      },
      {
        script: 'process.exit(2)',
        scheduleName: 'X Y',
        workingDir: dir,
        currentCommand: 'xdt-node scripts/schedule-checks/x-y.mjs',
      },
    );
    expect(result.filePath).toBe(old);
    expect(readFileSync(old, 'utf8')).toBe('process.exit(2)\n');
  });
});
