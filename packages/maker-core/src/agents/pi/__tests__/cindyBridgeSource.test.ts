import {
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  CINDY_BRIDGE_EXTENSION_SOURCE,
  CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS,
  CINDY_PI_BASH_MAX_TIMEOUT_SECONDS,
} from '../cindy-bridge-source.js';

type ReviewSearchHelpers = {
  filterReviewGrepResult: (
    result: unknown,
    input: unknown,
    allowedPaths: string[],
  ) => { content: Array<{ text?: string }>; details?: unknown };
  reviewSearchPathIsVisible: (
    candidate: string,
    allowedPaths: string[],
    baseDir?: string,
  ) => boolean;
  rgGlob: (
    pattern: string,
    cwd: string,
    options: { ignore: string[]; limit: number },
  ) => Promise<string[]>;
};

function loadReviewSearchHelpers(
  workingDir: string,
  overrides: {
    lstatSync?: typeof lstatSync;
    managedRipgrepPath?: string;
  } = {},
): ReviewSearchHelpers {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const helperStart = source.indexOf("function isInsideRoot");
  const helperEnd = source.indexOf("// ── MCP streamable-HTTP");
  const findStart = source.indexOf("function rgGlob(");
  const findEnd = source.indexOf("export default async function cindyBridge");
  if (
    helperStart < 0 ||
    helperEnd <= helperStart ||
    findStart < 0 ||
    findEnd <= findStart
  ) {
    throw new Error(
      "Review search helpers were not found in the generated bridge",
    );
  }
  const executableSource = [
    "const REVIEW_CREDENTIAL_PATH_PATTERNS: RegExp[] = [/(?:^|[\\\\/])node_modules(?:[\\\\/]|$)/i];",
    "const REVIEW_CREDENTIAL_GLOB_PATTERNS: string[] = [];",
    source.slice(helperStart, helperEnd),
    "function currentPermissionState() {",
    "  return { reviewOnly: true, reviewReadPaths: (globalThis as any).__reviewReadPaths };",
    "}",
    "function managedRipgrepPath() { return (globalThis as any).__managedRipgrepPath; }",
    source.slice(findStart, findEnd),
    "(globalThis as any).filterReviewGrepResult = filterReviewGrepResult;",
    "(globalThis as any).reviewSearchPathIsVisible = reviewSearchPathIsVisible;",
    "(globalThis as any).rgGlob = rgGlob;",
  ].join("\n");
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Partial<ReviewSearchHelpers> & Record<string, unknown> = {
    path,
    process: { cwd: () => workingDir, platform: process.platform },
    Buffer,
    lstatSync: overrides.lstatSync ?? lstatSync,
    readFileSync,
    realpathSync,
    statSync,
    spawn,
    createInterface,
    __reviewReadPaths: [workingDir],
    __managedRipgrepPath: overrides.managedRipgrepPath ?? "",
  };
  runInNewContext(compiled, context);
  if (
    !context.filterReviewGrepResult ||
    !context.reviewSearchPathIsVisible ||
    !context.rgGlob
  ) {
    throw new Error("Review search helpers were not loaded");
  }
  return context as ReviewSearchHelpers;
}

function loadBashTimeoutHelpers(): {
  resolveCindyBashTimeout: (params: unknown) => number;
  applyCindyBashTimeoutParams: (params: unknown) => Record<string, unknown>;
} {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('const CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS =');
  const end = source.indexOf('function cindyBashTimeoutDescription');
  if (start < 0 || end <= start) {
    throw new Error('bash timeout helpers were not found in the generated bridge');
  }
  const factory = new Function(
    `${source.slice(start, end)}; return { resolveCindyBashTimeout, applyCindyBashTimeoutParams };`,
  ) as () => {
    resolveCindyBashTimeout: (params: unknown) => number;
    applyCindyBashTimeoutParams: (params: unknown) => Record<string, unknown>;
  };
  return factory();
}

describe('cindy-bridge extension source', () => {
  it('is valid standalone TypeScript for the Pi runtime to load', () => {
    const result = ts.transpileModule(CINDY_BRIDGE_EXTENSION_SOURCE, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });
    const errors = (result.diagnostics ?? [])
      .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
    expect(errors).toEqual([]);
  });

  it('overrides find with the managed ripgrep backend instead of runtime fd download', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;

    for (const tool of ['createBashTool', 'createFindTool', 'createGrepTool', 'createLsTool']) {
      expect(source).toContain(tool + ',');
    }
    expect(source).toContain("const args = ['--files', '--hidden', '--no-require-git']");
    expect(source).toContain("if (pattern.includes('/')) {");
    expect(source).toContain('path.basename(relative)');
    expect(source).toContain("effectivePattern = '**/' + pattern");
    expect(source).toContain('path.resolve(cwd, relative)');
    expect(source).toContain('path.matchesGlob(candidate, effectivePattern)');
    expect(source).not.toContain("'--glob', pattern");
    expect(source).toContain('glob: rgGlob');
    expect(source).toContain('const grepTool = createGrepTool(process.cwd())');
    expect(source).toContain(
      'filterReviewGrepResult(result, params, permission.reviewReadPaths)',
    );
    expect(source).toContain(
      'reviewSearchPathIsVisible(relative, permission.reviewReadPaths, cwd)',
    );
    expect(source).toContain('spawn(managedRipgrepPath(), args, {');
    expect(source).not.toContain("spawn('rg'");
    expect(source).toContain("const MANAGED_RG_PATH_ENV = 'CINDY_PI_MANAGED_RG_PATH'");
    expect(source).toContain('const lsTool = createLsTool(process.cwd())');
    expect(source).not.toContain("spawn('fd'");
  });

  it('keeps generated extension source free of template literals', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain('`');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain('${');
  });

  it('normalizes bash timeout at the execute boundary without a host-side timer', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    expect(source).toContain(
      `const CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS = ${CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS};`,
    );
    expect(source).toContain(
      `const CINDY_PI_BASH_MAX_TIMEOUT_SECONDS = ${CINDY_PI_BASH_MAX_TIMEOUT_SECONDS};`,
    );
    expect(source).toContain('const nextParams = applyCindyBashTimeoutParams(params);');
    expect(source).toContain(
      'return bashTool.execute(id, nextParams as any, signal, onUpdate as any);',
    );
    expect(source).toContain('cindyBashTimeoutDescription()');
    const executeSlice = source.slice(
      source.indexOf('applyCindyBashTimeoutParams(params)'),
      source.indexOf('cindy-branch-switch'),
    );
    expect(executeSlice).not.toContain('AbortController');
    expect(executeSlice).not.toContain('setTimeout');

    const { resolveCindyBashTimeout, applyCindyBashTimeoutParams } = loadBashTimeoutHelpers();
    expect(resolveCindyBashTimeout(undefined)).toBe(CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS);
    expect(resolveCindyBashTimeout({})).toBe(CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS);
    expect(resolveCindyBashTimeout({ timeout: 0 })).toBe(CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS);
    expect(resolveCindyBashTimeout({ timeout: -1 })).toBe(CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS);
    expect(resolveCindyBashTimeout({ timeout: 45 })).toBe(45);
    expect(resolveCindyBashTimeout({ timeout: CINDY_PI_BASH_MAX_TIMEOUT_SECONDS })).toBe(
      CINDY_PI_BASH_MAX_TIMEOUT_SECONDS,
    );
    expect(() => resolveCindyBashTimeout({ timeout: CINDY_PI_BASH_MAX_TIMEOUT_SECONDS + 1 })).toThrow(
      /Invalid timeout: timeout is in seconds; maximum is 1800 seconds \(received 1801\)/,
    );
    expect(() => resolveCindyBashTimeout({ timeout: 180000 })).toThrow(
      /Invalid timeout: timeout is in seconds; maximum is 1800 seconds \(received 180000\)/,
    );
    expect(() => resolveCindyBashTimeout({ timeout: Number.NaN })).toThrow(/Invalid timeout/);
    expect(() => resolveCindyBashTimeout({ timeout: Number.POSITIVE_INFINITY })).toThrow(
      /Invalid timeout/,
    );
    expect(applyCindyBashTimeoutParams({ command: 'ls' })).toEqual({
      command: 'ls',
      timeout: CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS,
    });
    expect(applyCindyBashTimeoutParams({ command: 'ls', timeout: 12 })).toEqual({
      command: 'ls',
      timeout: 12,
    });
  });

  it('keeps Pi vision bridge tool security invariants (registration, size, magic-byte, redirect, redaction)', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    // 工具只在已启用且可解析 primary 后端时注册（fallback-only 不注册）。
    expect(source).toContain('piVisionCfg.enabled && piVisionCfg.primary');
    // 图片大小上限（stat 前置 + read 后 TOCTOU 复查）与魔数校验，防止任意本地文件外传。
    expect(source).toContain('MAX_IMAGE_BYTES');
    expect(source).toContain('statSync(imagePath)');
    expect(source).toContain('sniffImageMime');
    // 请求禁止跟随重定向（凭证/图片不流向非预期端点）。
    expect(source).toContain("redirect: 'error'");
    // 路由指定额外头必须合并进请求（anthropic-version / x-api-key / 自定义 provider 头），
    // 缺失会被后端拒（对齐 host 侧 vision-channel 的 headers 合并）。
    expect(source).toContain('...spec.headers');
    // anthropic-messages 视觉请求必须带 max_tokens（/v1/messages 强制要求，缺省会 400）。
    expect(source).toContain('max_tokens: 1024');
    // fallback 去重必须比较 headers——同 (url/model/auth) 但路由头不同（如不同
    // anthropic-beta）的 fallback 是独立后端，不得误判为重复跳过（P2）。
    expect(source).toContain('JSON.stringify(cfg.fallback.headers');
    // 本地图片转 data URL 进请求体，路径字符串不外发。
    expect(source).toContain('image_url:');
    expect(source).toContain("'data:'");
    // 错误脱敏：模型侧只看到泛化文案，不含本地路径 / key / URL。
    expect(source).toContain("'vision: vision backend request failed'");
    expect(source).toContain("'vision HTTP '");
    expect(source).toContain("'vision: unable to read the image file'");
    // host 可关联日志：fallback 行为有结构化 stderr 输出（脱敏，仅 backendRole/model）。
    expect(source).toContain('vision bridge pi primary backend failed');
    expect(source).toContain('vision bridge pi used fallback backend');
    expect(source).toContain('vision bridge pi fallback backend failed');
  });

  it('captures known writes before execution and marks opaque tools only after a result', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("pi.on('tool_call'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('FILE_WRITE_BUILTINS.has(event.toolName)');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("pi.on('tool_result'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("event.toolName !== 'bash'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("startsWith('mcp__')");
  });

  it('checks the Review deny-by-default boundary before ordinary permission handling', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const reviewGate = source.indexOf('if (permission.reviewOnly)');
    const ordinaryWriteHandling = source.indexOf('if (FILE_WRITE_BUILTINS.has(event.toolName))');

    expect(reviewGate).toBeGreaterThan(-1);
    expect(ordinaryWriteHandling).toBeGreaterThan(reviewGate);
    expect(source).toContain(
      "reason: 'Cindy Review only permits read-only access to this task and its explicit artifacts.'",
    );
    expect(source).toContain('normalizeReviewReadInput(');
    expect(source).toContain('collectReviewPathFields(input)');
    expect(source).toContain("new Set(['glob', 'globs', 'pattern', 'patterns'])");
    expect(source).toContain('reviewSelectorTouchesCredential(selector)');
    expect(source).toContain('resolveReviewReadPath(candidate, allowedPaths)');
    expect(source).toContain('(input as Record<string, unknown>).path = resolvedPaths[0]!');
    expect(source).toContain('pathFields[index].write(resolvedPaths[index]!)');
    expect(source).not.toContain("toolName === 'grep' && statSync(target).isDirectory()");
    expect(source).toContain('reviewFileLinkLayoutIsSafe(target, targetStat, allowed)');
    expect(source).toContain("candidates.add(path.join(dependencyRoot, 'node_modules'");
    expect(source).toContain('reviewSearchPathHasUnsafeLinkLayout');
    expect(source).toContain(
      'reviewSearchPathIsVisible(relative, permission.reviewReadPaths, cwd)',
    );
    expect(source).not.toContain('reviewSearchPathHasMultipleLinks');
    expect(source).toContain('REVIEW_CREDENTIAL_PATH_PATTERNS.some');
    expect(source).toContain('REVIEW_CREDENTIAL_GLOB_PATTERNS.some');
  });

  it.skipIf(process.platform === 'win32')(
    'pins every Pi read tool to the real path that passed Review validation',
    () => {
      const source = CINDY_BRIDGE_EXTENSION_SOURCE;
      const helperStart = source.indexOf('function isInsideRoot');
      const helperEnd = source.indexOf('function reviewSearchPathTouchesCredential');
      expect(helperStart).toBeGreaterThan(-1);
      expect(helperEnd).toBeGreaterThan(helperStart);

      const executableSource = [
        "const REVIEW_CREDENTIAL_PATH_PATTERNS: RegExp[] = [/(?:^|[\\\\/])node_modules(?:[\\\\/]|$)/i];",
        source.slice(helperStart, helperEnd),
        '(globalThis as any).normalizeReviewReadInput = normalizeReviewReadInput;',
      ].join('\n');
      const compiled = ts.transpileModule(executableSource, {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;

      const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-review-read-'));
      try {
        const workingDir = path.join(tempRoot, 'workspace');
        const outsideDir = path.join(tempRoot, 'outside');
        mkdirSync(workingDir);
        mkdirSync(outsideDir);
        const approvedPath = path.join(workingDir, 'approved.txt');
        const outsidePath = path.join(outsideDir, 'secret.txt');
        const linkPath = path.join(workingDir, 'review-input.txt');
        writeFileSync(approvedPath, 'approved');
        writeFileSync(outsidePath, 'outside');
        symlinkSync(approvedPath, linkPath);

        type NormalizeReviewReadInput = (
          toolName: string,
          input: unknown,
          allowedPaths: string[],
        ) => boolean;
        const context: {
          normalizeReviewReadInput?: NormalizeReviewReadInput;
        } & Record<string, unknown> = {
          path,
          process: { cwd: () => workingDir, platform: process.platform },
          Buffer,
          lstatSync,
          readFileSync,
          realpathSync,
          statSync,
        };
        runInNewContext(compiled, context);
        const normalizeReviewReadInput = context.normalizeReviewReadInput;
        expect(normalizeReviewReadInput).toBeTypeOf('function');
        if (!normalizeReviewReadInput) throw new Error('Review read normalizer was not loaded');

        const readInput = { path: linkPath };
        const grepInput = { request: { paths: [linkPath] }, pattern: 'approved' };
        const findInput = { options: { filePath: linkPath }, pattern: '*.txt' };
        const lsInput = { filepath: linkPath };
        const inputs = [
          { tool: 'read', input: readInput },
          {
            tool: 'grep',
            input: grepInput,
          },
          {
            tool: 'find',
            input: findInput,
          },
          { tool: 'ls', input: lsInput },
        ];
        for (const { tool, input } of inputs) {
          expect(normalizeReviewReadInput(tool, input, [approvedPath])).toBe(true);
        }

        expect(readInput.path).toBe(realpathSync(approvedPath));
        expect(grepInput.request.paths).toEqual([realpathSync(approvedPath)]);
        expect(findInput.options.filePath).toBe(realpathSync(approvedPath));
        expect(lsInput.filepath).toBe(realpathSync(approvedPath));

        for (const tool of ['read', 'grep', 'find', 'ls']) {
          const defaultInput: Record<string, unknown> = {};
          expect(normalizeReviewReadInput(tool, defaultInput, [workingDir])).toBe(true);
          expect(defaultInput.path).toBe(realpathSync(workingDir));
        }

        const localPackage = path.join(workingDir, 'packages', 'maker-core');
        const localSource = path.join(localPackage, 'src', 'index.ts');
        const localMirror = path.join(
          workingDir,
          'node_modules',
          '@cindy',
          'maker-core',
          'src',
          'index.ts',
        );
        mkdirSync(path.dirname(localSource), { recursive: true });
        mkdirSync(path.dirname(localMirror), { recursive: true });
        writeFileSync(
          path.join(localPackage, 'package.json'),
          '{"name":"@cindy/maker-core"}',
        );
        writeFileSync(localSource, 'export const value = 1;');
        linkSync(localSource, localMirror);
        expect(
          normalizeReviewReadInput('read', { path: localSource }, [workingDir]),
        ).toBe(true);

        const outsideManifest = path.join(outsideDir, 'package.json');
        const localManifest = path.join(localPackage, 'package.json');
        writeFileSync(outsideManifest, '{"name":"@cindy/maker-core"}');
        unlinkSync(localManifest);
        symlinkSync(outsideManifest, localManifest);
        expect(
          normalizeReviewReadInput('read', { path: localSource }, [workingDir]),
        ).toBe(false);
        unlinkSync(localManifest);
        writeFileSync(localManifest, '{"name":"@cindy/maker-core"}');

        linkSync(localSource, path.join(outsideDir, 'third-link.ts'));
        expect(
          normalizeReviewReadInput('read', { path: localSource }, [workingDir]),
        ).toBe(false);

        unlinkSync(linkPath);
        symlinkSync(outsidePath, linkPath);
        expect(readFileSync(readInput.path, 'utf8')).toBe('approved');
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps safe pnpm links visible to Pi Grep and managed Find while rejecting unsafe layouts",
    async () => {
      const tempRoot = mkdtempSync(
        path.join(tmpdir(), "cindy-pi-review-search-"),
      );
      try {
        const workingDir = path.join(tempRoot, "workspace");
        const outsideDir = path.join(tempRoot, "outside");
        mkdirSync(workingDir);
        mkdirSync(outsideDir);

        const sourcePackage = path.join(
          workingDir,
          "packages",
          "maker-core",
        );
        const sourcePath = path.join(sourcePackage, "src", "index.ts");
        const mirrorPath = path.join(
          workingDir,
          "node_modules",
          "@cindy",
          "maker-core",
          "src",
          "index.ts",
        );
        mkdirSync(path.dirname(sourcePath), { recursive: true });
        mkdirSync(path.dirname(mirrorPath), { recursive: true });
        writeFileSync(
          path.join(sourcePackage, "package.json"),
          '{"name":"@cindy/maker-core"}',
        );
        writeFileSync(sourcePath, "export const safe = true;");
        linkSync(sourcePath, mirrorPath);

        const managedRipgrepPath = path.resolve(
          process.cwd(),
          "..",
          "..",
          "apps",
          "ripgrep-bin",
          `${process.platform}-${process.arch}`,
          "rg",
        );
        expect(statSync(managedRipgrepPath).isFile()).toBe(true);
        const helpers = loadReviewSearchHelpers(workingDir, {
          managedRipgrepPath,
        });
        const relativeSource = path.relative(workingDir, sourcePath);
        expect(
          helpers.reviewSearchPathIsVisible(
            relativeSource,
            [workingDir],
            workingDir,
          ),
        ).toBe(true);
        const visibleGrep = helpers.filterReviewGrepResult(
          {
            content: [
              {
                type: "text",
                text: `${relativeSource}:1:export const safe = true;`,
              },
            ],
          },
          { path: workingDir },
          [workingDir],
        );
        expect(visibleGrep.content[0]?.text).toContain(relativeSource);
        expect(
          await helpers.rgGlob("index.ts", workingDir, {
            ignore: [],
            limit: 100,
          }),
        ).toContain(sourcePath);

        const outsideSecret = path.join(outsideDir, "secret.ts");
        const outsideAlias = path.join(workingDir, "outside-alias.ts");
        writeFileSync(outsideSecret, "export const secret = true;");
        linkSync(outsideSecret, outsideAlias);
        expect(
          helpers.reviewSearchPathIsVisible(
            "outside-alias.ts",
            [workingDir],
            workingDir,
          ),
        ).toBe(false);
        expect(
          await helpers.rgGlob("*.ts", workingDir, { ignore: [], limit: 100 }),
        ).not.toContain(outsideAlias);

        const thirdLink = path.join(outsideDir, "third-link.ts");
        linkSync(sourcePath, thirdLink);
        expect(
          helpers.reviewSearchPathIsVisible(
            relativeSource,
            [workingDir],
            workingDir,
          ),
        ).toBe(false);
        expect(
          await helpers.rgGlob("index.ts", workingDir, {
            ignore: [],
            limit: 100,
          }),
        ).not.toContain(sourcePath);
        unlinkSync(thirdLink);

        let replaced = false;
        const sourceIdentity = statSync(sourcePath);
        const replacingHelpers = loadReviewSearchHelpers(workingDir, {
          managedRipgrepPath,
          lstatSync: ((candidate: Parameters<typeof lstatSync>[0]) => {
            const candidateStat = lstatSync(candidate);
            if (
              !replaced &&
              candidateStat.isFile() &&
              candidateStat.ino === sourceIdentity.ino &&
              candidateStat.dev === sourceIdentity.dev
            ) {
              replaced = true;
              const candidatePath = candidate.toString();
              unlinkSync(candidatePath);
              writeFileSync(candidatePath, "export const replacement = true;");
              return lstatSync(candidate);
            }
            return candidateStat;
          }) as typeof lstatSync,
        });
        expect(
          await replacingHelpers.rgGlob("index.ts", workingDir, {
            ignore: [],
            limit: 100,
          }),
        ).not.toContain(sourcePath);
        expect(replaced).toBe(true);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(
    process.platform === "win32" || !process.env.CINDY_REVIEW_REAL_WORKSPACE,
  )(
    "keeps a real pnpm-linked workspace file visible to Pi Grep and managed Find",
    async () => {
      const workingDir = process.env.CINDY_REVIEW_REAL_WORKSPACE!;
      const sourcePath = path.join(
        workingDir,
        "apps",
        "mobile",
        "modules",
        "xdt-ios-app-distribution",
        "src",
        "index.ts",
      );
      expect(statSync(sourcePath).nlink).toBe(2);
      const relativeSource = path.relative(workingDir, sourcePath);
      const managedRipgrepPath = path.resolve(
        process.cwd(),
        "..",
        "..",
        "apps",
        "ripgrep-bin",
        `${process.platform}-${process.arch}`,
        "rg",
      );
      const helpers = loadReviewSearchHelpers(workingDir, {
        managedRipgrepPath,
      });
      expect(
        helpers.reviewSearchPathIsVisible(
          relativeSource,
          [workingDir],
          workingDir,
        ),
      ).toBe(true);
      const visibleGrep = helpers.filterReviewGrepResult(
        {
          content: [
            {
              type: "text",
              text: `${relativeSource}:1:export * from './types';`,
            },
          ],
        },
        { path: workingDir },
        [workingDir],
      );
      expect(visibleGrep.content[0]?.text).toContain(relativeSource);
      expect(
        await helpers.rgGlob("index.ts", workingDir, {
          ignore: [],
          limit: 1000,
        }),
      ).toContain(sourcePath);
    },
  );
});
