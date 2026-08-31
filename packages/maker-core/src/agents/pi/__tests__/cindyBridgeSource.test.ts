import {
  globSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  opendirSync,
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

const canLinkFile = (() => {
  const root = mkdtempSync(path.join(tmpdir(), 'cindy-bridge-file-link-probe-'));
  try {
    const target = path.join(root, 'target');
    writeFileSync(target, 'probe');
    symlinkSync(target, path.join(root, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

type ReviewSearchHelpers = {
  collectReadonlyCredentialEvidence: (
    toolName: string,
    input: unknown,
  ) => { paths: string[]; touchesCredential: boolean };
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

function loadBashIsolationHelper(
  pathImpl: typeof path,
): (
  env: Record<string, string | undefined>,
  home: string | undefined,
) => Record<string, string | undefined> {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('function withoutPiSecrets');
  const end = source.indexOf('function managedRipgrepPath');
  if (start < 0 || end <= start) throw new Error('bash isolation helper was not found');
  const executableSource = [
    "const SECRET_ENV_NAMES = new Set(['PI_CODING_AGENT_DIR', 'CINDY_PI_PACKAGE_MANAGEMENT', 'CINDY_PI_BASH_PACKAGE_HOME']);",
    source.slice(start, end),
    '(globalThis as any).isolatedBashEnvironment = isolatedBashEnvironment;',
  ].join('\n');
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = { path: pathImpl };
  runInNewContext(compiled, context);
  return context.isolatedBashEnvironment as (
    env: Record<string, string | undefined>,
    home: string | undefined,
  ) => Record<string, string | undefined>;
}

function loadFileWriteTargetHelper(): (targetPath: string) => string | null {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('function resolveFileWriteTargetPath');
  const end = source.indexOf('function reviewAncestorsWithin', start);
  if (start < 0 || end <= start) throw new Error('file-write target helper was not found');
  const executableSource = [
    source.slice(start, end),
    '(globalThis as any).resolveFileWriteTargetPath = resolveFileWriteTargetPath;',
  ].join('\n');
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = { path, lstatSync, realpathSync };
  runInNewContext(compiled, context);
  return context.resolveFileWriteTargetPath as (targetPath: string) => string | null;
}

function loadWritableRootResolver(
  workingDir: string,
): (writableRoots: string[]) => string[] | null {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('function resolveWritableRootsForHost');
  const end = source.indexOf('function reviewAncestorsWithin', start);
  if (start < 0 || end <= start) throw new Error('writable-root resolver was not found');
  const executableSource = [
    source.slice(start, end),
    '(globalThis as any).resolveWritableRootsForHost = resolveWritableRootsForHost;',
  ].join('\n');
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = {
    process: { cwd: () => workingDir },
    realpathSync,
  };
  runInNewContext(compiled, context);
  return context.resolveWritableRootsForHost as (writableRoots: string[]) => string[] | null;
}

function loadBashPackageHomeHelper(): {
  resolveBashPackageHome: () => string | undefined;
  env: Record<string, string | undefined>;
  globalThis: Record<string, unknown>;
} {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('const BRIDGE_RELOAD_STASH_GLOBAL');
  const end = source.indexOf('// 凭证/密钥路径特征由 maker-core 的单一来源生成');
  if (start < 0 || end <= start) throw new Error('bash package home helper was not found');
  const executableSource = [
    "const PI_BASH_PACKAGE_HOME_ENV = 'CINDY_PI_BASH_PACKAGE_HOME';",
    source.slice(start, end),
    '(globalThis as any).resolveBashPackageHome = resolveBashPackageHome;',
  ].join('\n');
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = {
    process: { env: {} },
    path,
  };
  // runInNewContext 的 context 即该 realm 的 globalThis,stash 会落在上面。
  runInNewContext(compiled, context);
  const resolveBashPackageHome = context.resolveBashPackageHome as () => string | undefined;
  if (typeof resolveBashPackageHome !== 'function') {
    throw new Error('bash package home helper was not loaded');
  }
  return {
    resolveBashPackageHome,
    env: context.process.env as Record<string, string | undefined>,
    globalThis: context,
  };
}

function powerShellOverlayEnabled(platform: NodeJS.Platform, factory: unknown): boolean {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('const createPowerShellTool =');
  const end = source.indexOf('// Cindy owns a separate Pi extension store.', start);
  if (start < 0 || end <= start) throw new Error('PowerShell overlay was not found');
  const condition = /^\s*if \((.*createPowerShellTool.*)\) \{$/m.exec(source.slice(start, end))?.[1];
  if (!condition) throw new Error('PowerShell overlay condition was not found');
  return Boolean(runInNewContext(condition, {
    createPowerShellTool: factory,
    process: { platform },
  }));
}

function loadPowerShellReadEvidence(
  cwd: string,
): (input: unknown) => { targets: string[]; unresolved: boolean } {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('const POWERSHELL_DIRECT_FILE_READ_COMMANDS');
  const end = source.indexOf('function bashInputReadEvidence', start);
  if (start < 0 || end <= start) throw new Error('PowerShell read evidence helper was not found');
  const executableSource = [
    'type BashInputReadEvidence = { targets: string[]; unresolved: boolean };',
    source.slice(start, end),
    '(globalThis as any).powershellInputReadEvidence = powershellInputReadEvidence;',
  ].join('\n');
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = {
    path,
    process: { cwd: () => cwd },
  };
  runInNewContext(compiled, context);
  return context.powershellInputReadEvidence as (
    input: unknown,
  ) => { targets: string[]; unresolved: boolean };
}

function loadPiPackageMutationCommandHelper(): (input: unknown) => boolean {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const parserStart = source.indexOf('function readShellRedirectionTarget');
  const parserEnd = source.indexOf('type BashPathCandidates');
  const helperStart = source.indexOf('const PI_PACKAGE_MUTATION_SUBCOMMANDS');
  const helperEnd = source.indexOf('function managedRipgrepPath');
  const redirectionStart = source.indexOf('function bashLeadingRedirectionAt');
  const redirectionEnd = source.indexOf('function bashAssignmentPrefixAt');
  if (parserStart < 0 || parserEnd <= parserStart
    || helperStart < 0 || helperEnd <= helperStart
    || redirectionStart < 0 || redirectionEnd <= redirectionStart) {
    throw new Error('Pi package mutation command helper was not found');
  }
  const executableSource = [
    source.slice(parserStart, parserEnd),
    source.slice(redirectionStart, redirectionEnd),
    source.slice(helperStart, helperEnd),
    '(globalThis as any).bashCommandMutatesPiPackages = bashCommandMutatesPiPackages;',
  ].join('\n');
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = {};
  runInNewContext(compiled, context);
  return context.bashCommandMutatesPiPackages as (input: unknown) => boolean;
}

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
  const selectorGlobs = /^const CREDENTIAL_SELECTOR_GLOBS = .*;$/m.exec(source)?.[0];
  if (
    helperStart < 0 ||
    helperEnd <= helperStart ||
    findStart < 0 ||
    findEnd <= findStart ||
    !selectorGlobs
  ) {
    throw new Error(
      "Review search helpers were not found in the generated bridge",
    );
  }
  const executableSource = [
    "const CREDENTIAL_PATH_PATTERNS: RegExp[] = [/(?:^|[\\\\/])\\.env(?:\\.[^\\\\/]+)?$/i, /\\.pem$/i];",
    "const REVIEW_CREDENTIAL_PATH_PATTERNS: RegExp[] = [/(?:^|[\\\\/])node_modules(?:[\\\\/]|$)/i];",
    "const REVIEW_CREDENTIAL_GLOB_PATTERNS: string[] = [];",
    selectorGlobs,
    "function touchesCredentialPath(input: unknown): boolean {",
    "  if (typeof input === 'string') return CREDENTIAL_PATH_PATTERNS.some((re) => re.test(input));",
    "  if (Array.isArray(input)) return input.some(touchesCredentialPath);",
    "  return false;",
    "}",
    source.slice(helperStart, helperEnd),
    "function currentPermissionState() {",
    "  return { reviewOnly: true, reviewReadPaths: (globalThis as any).__reviewReadPaths };",
    "}",
    "function managedRipgrepPath() { return (globalThis as any).__managedRipgrepPath; }",
    source.slice(findStart, findEnd),
    "(globalThis as any).collectReadonlyCredentialEvidence = collectReadonlyCredentialEvidence;",
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
    !context.collectReadonlyCredentialEvidence ||
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

  it('restricts readonly credential evidence to path and selector fields', () => {
    const helpers = loadReviewSearchHelpers('/repo');
    const evidence = (toolName: string, input: unknown) => {
      const value = helpers.collectReadonlyCredentialEvidence(toolName, input);
      return { paths: [...value.paths], touchesCredential: value.touchesCredential };
    };

    expect(evidence('grep', { pattern: '.env', path: 'src', context: '.env.local' })).toEqual({
      paths: ['src'],
      touchesCredential: false,
    });
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.env*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.n?trc' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: 'src/.n?trc' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '*.p?m' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.config/g?/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '?.key' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.env.?' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.ssh-*/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', globs: ['*.key', '!secret.key'] }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '**/.cargo/credentia?s.bak' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '**/.m2/settings.xml.bak' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.s?h' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: 'id_rsa.*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.s?h/config' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.config/g?/hosts.yml' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.a?s/credentials' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: '.config/g?-*/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: '.', glob: 'nested/.config/g?-*/**' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.e[n-o]v' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '[.-0]env*' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '.e{n,foo}v', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '{safe,.e[n-o]v}', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '@(safe|.env)', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '.e{o,p}v', path: 'src' }).touchesCredential).toBe(false);
    expect(evidence('find', { pattern: '.e[o-p]v', path: 'src' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.environment*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '!.env*' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', globs: ['*', '!.env*'] }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', globs: ['source.ts', '!.env*'] }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '[!.]*.ts' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '*.ts' }).touchesCredential).toBe(true);
    expect(evidence('find', { pattern: '*.ts', path: 'src' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.n?tes' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '[!.]*.png' }).touchesCredential).toBe(true);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '?.txt' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.envrc?' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.netrcfoo' }).touchesCredential).toBe(false);
    expect(evidence('grep', { pattern: 'KEY', path: 'src', glob: '.sshhelper' }).touchesCredential).toBe(false);
    expect(evidence('find', { pattern: '.env', path: 'src' }).touchesCredential).toBe(true);
    expect(evidence('read', { path: '.env.local', offset: 1 }).touchesCredential).toBe(true);
    expect(evidence('ls', { path: 'src/.environment' }).touchesCredential).toBe(false);
    expect(evidence('read', { path: 42 }).touchesCredential).toBe(true);
  });

  it('canonicalizes direct PowerShell read operands through a directory symlink or junction', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-powershell-link-'));
    try {
      const sshDir = path.join(tempRoot, 'secrets', '.ssh');
      const keyPath = path.join(sshDir, 'id_rsa');
      const innocentLink = path.join(tempRoot, 'innocent');
      mkdirSync(sshDir, { recursive: true });
      writeFileSync(keyPath, 'secret');
      symlinkSync(sshDir, innocentLink, process.platform === 'win32' ? 'junction' : 'dir');
      const operand = process.platform === 'win32'
        ? '.\\innocent\\id_rsa'
        : './innocent/id_rsa';
      const evidence = loadPowerShellReadEvidence(tempRoot);

      const commands = [
        ...['Get-Content', 'gc', 'cat', 'type', 'Microsoft.PowerShell.Management\\Get-Content']
          .map((commandName) => commandName + ' ' + operand),
        'Get-Content -Path ' + operand,
        "Get-Content -LiteralPath '" + operand + "' -Raw",
        'Write-Output ok; Get-Content ' + operand,
        'Get-Content ' + operand + ' | Out-String',
        'Write-Output ok | Get-Content ' + operand,
        'Write-Output "ok; still"; Get-Content ' + operand,
        'Write-Output ok\nGet-Content ' + operand,
        'Write-Output ok\rGet-Content ' + operand,
        '# harmless preface\nGet-Content ' + operand,
      ];
      for (const command of commands) {
        const result = evidence({ command });
        expect(result.unresolved, command).toBe(false);
        expect(result.targets, command).toHaveLength(1);
        expect(realpathSync(result.targets[0]), command).toBe(realpathSync(keyPath));
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails closed for relative PowerShell reads after a directory change', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-powershell-cwd-'));
    try {
      const sshDir = path.join(tempRoot, 'secrets', '.ssh');
      const keyPath = path.join(sshDir, 'work');
      const innocentLink = path.join(tempRoot, 'innocent');
      mkdirSync(sshDir, { recursive: true });
      writeFileSync(keyPath, 'secret');
      symlinkSync(sshDir, innocentLink, process.platform === 'win32' ? 'junction' : 'dir');
      const location = process.platform === 'win32' ? '.\\innocent' : './innocent';
      const evidence = loadPowerShellReadEvidence(tempRoot);

      for (const locationCommand of [
        `Set-Location ${location}`,
        `cd ${location}`,
        `chdir ${location}`,
        `sl ${location}`,
        `Push-Location ${location}`,
        `pushd ${location}`,
        'Pop-Location',
        'popd',
      ]) {
        const command = `${locationCommand}; Get-Content work`;
        expect(evidence({ command }), command).toEqual({ targets: [], unresolved: true });
      }

      expect(evidence({ command: `Set-Location ${location}` })).toEqual({
        targets: [],
        unresolved: false,
      });
      expect(evidence({ command: `Set-Location ${location}; Get-Content '${keyPath}'` })).toEqual({
        targets: [path.normalize(keyPath)],
        unresolved: false,
      });

      expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
        'isCindyShellTool(event.toolName) && (bashReadEvidence.unresolved || touchesCredentialPath(bashReadTargets))',
      );
      expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
        "if (credentialRead && permission.mode === 'bypassPermissions')",
      );
      expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('await ctx.ui.input(');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('fails closed when a direct PowerShell read operand is not statically resolvable', () => {
    const evidence = loadPowerShellReadEvidence(process.cwd());
    for (const command of [
      'Get-Content $target',
      'Get-Content "${target}"',
      'Get-Content (Join-Path . id_rsa)',
      'Get-Content ./safe"name".txt',
      "Get-Content ./safe'name'.txt",
      'Get-Content ./safe*.txt',
      'Get-Content -Encoding utf8 ./safe.txt',
      'Get-Content\u00a0./safe.txt',
      'Write-Output ok; Get-Content $target',
      'Write-Output ok; Get-Content (Join-Path . id_rsa)',
      'git status | Get-Content $target',
      'git status > status.txt; Get-Content ./safe.txt',
      '(Get-Content ./safe.txt)',
      '{ Get-Content ./safe.txt }',
      'git status & Get-Content ./safe.txt',
      'Get-`Content ./safe.txt',
      'Write-Output ok && Get-Content ./safe.txt',
      'Write-Output ok\u2028Get-Content ./safe.txt',
      "Write-Output ok; Get-Content './unterminated",
    ]) {
      expect(evidence({ command }), command).toEqual({ targets: [], unresolved: true });
    }
    expect(evidence({ command: 'Write-Output ok' })).toEqual({ targets: [], unresolved: false });
  });

  it('keeps ordinary PowerShell operators out of credential-read evidence', () => {
    const evidence = loadPowerShellReadEvidence(process.cwd());
    for (const command of [
      'git status | Out-String',
      'git status > status.txt',
      '(git status)',
      '{ git status }',
      'git status &',
      'Write-Output foo`nbar',
      "Write-Output '(Get-Content ./safe.txt)'",
      'Write-Output ok && Write-Output done',
      'Write-Output ok\u2028Write-Output done',
    ]) {
      expect(evidence({ command }), command).toEqual({ targets: [], unresolved: false });
    }
  });

  // symlink-platform-skip: This case validates POSIX shell and filename semantics that Windows cannot represent.
  it.skipIf(process.platform === 'win32')(
    'collects canonical credential targets without flagging ordinary symlinks',
    () => {
      const source = CINDY_BRIDGE_EXTENSION_SOURCE;
      const helperStart = source.indexOf('const CREDENTIAL_PATH_PATTERNS');
      const helperEnd = source.indexOf('// 从 bash 子进程读取任意进程的初始环境');
      expect(helperStart).toBeGreaterThan(-1);
      expect(helperEnd).toBeGreaterThan(helperStart);

      const executableSource = [
        source.slice(helperStart, helperEnd),
        '(globalThis as any).collectResolvedCredentialPaths = collectResolvedCredentialPaths;',
        '(globalThis as any).bashInputReadTargets = bashInputReadTargets;',
        '(globalThis as any).bashInputReadEvidence = bashInputReadEvidence;',
        '(globalThis as any).parseShellInputRedirections = parseShellInputRedirections;',
        '(globalThis as any).resolvedCredentialEvidenceForHost = resolvedCredentialEvidenceForHost;',
      ].join('\n');
      const compiled = ts.transpileModule(executableSource, {
        compilerOptions: {
          module: ts.ModuleKind.None,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText;
      const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-credential-link-'));
      const context: {
        globSync: typeof globSync;
        opendirSync: typeof opendirSync;
        realpathSync: typeof realpathSync;
        statSync: typeof statSync;
        path: typeof path;
        process: { cwd: () => string; env: NodeJS.ProcessEnv };
        collectResolvedCredentialPaths?: (input: unknown) => string[];
        bashInputReadTargets?: (input: unknown) => string[];
        bashInputReadEvidence?: (input: unknown) => { targets: string[]; unresolved: boolean };
        parseShellInputRedirections?: (command: string) => {
          command: string;
          targets: string[];
          targetPrefixes: string[];
          targetMayExpand: boolean[];
          hasUnresolvedTarget: boolean;
        };
        resolvedCredentialEvidenceForHost?: (
          paths: readonly string[],
          credentialRead: boolean,
        ) => string[] | null;
      } = {
        globSync,
        opendirSync,
        realpathSync,
        statSync,
        path,
        process: { cwd: () => tempRoot, env: { HOME: tempRoot, PATH: process.env.PATH } },
      };
      runInNewContext(compiled, context);

      try {
        const secretPath = path.join(tempRoot, 'secrets', '.env');
        const ordinaryPath = path.join(tempRoot, 'ordinary.txt');
        const secretLink = path.join(tempRoot, 'innocent.txt');
        const ordinaryLink = path.join(tempRoot, 'ordinary-link.txt');
        const escapedSecretLink = path.join(tempRoot, 'innocent\\q');
        const nestedDir = path.join(tempRoot, 'nested');
        const dashDir = path.join(tempRoot, '-credential-dir');
        const nestedSecretLink = path.join(nestedDir, 'nested-innocent.txt');
        const dashSecretLink = path.join(dashDir, 'innocent.txt');
        const lateSecretLink = path.join(nestedDir, 'late-only-secret-link');
        const scopedLinkName = 'scoped-innocent.txt';
        const rootScopedSecretLink = path.join(tempRoot, scopedLinkName);
        const nestedScopedOrdinaryLink = path.join(nestedDir, scopedLinkName);
        const cdRedirectName = 'cd-innocent';
        const rootCdRedirectSecretLink = path.join(tempRoot, cdRedirectName);
        const nestedCdRedirectOrdinaryLink = path.join(nestedDir, cdRedirectName);
        const nestedOrdinaryReadName = 'ordinary-after-cd.txt';
        const nestedOrdinaryReadLink = path.join(nestedDir, nestedOrdinaryReadName);
        const cdPathRoot = path.join(tempRoot, 'cdpath-root');
        const cdPathSubDir = path.join(cdPathRoot, 'sub');
        const cdPathSecretLink = path.join(cdPathSubDir, 'link');
        const cwdSwitchName = 'cwd-switch-link';
        const rootCwdSwitchOrdinaryLink = path.join(tempRoot, cwdSwitchName);
        const nestedCwdSwitchSecretLink = path.join(nestedDir, cwdSwitchName);
        const stackOtherDir = path.join(tempRoot, 'stack-other');
        const stackOtherOrdinaryLink = path.join(stackOtherDir, cwdSwitchName);
        const ordinaryGlobDir = path.join(tempRoot, 'ordinary-glob');
        const ordinaryGlobPath = path.join(ordinaryGlobDir, 'ordinary.txt');
        const dotglobDir = path.join(tempRoot, 'dotglob-only');
        const dotglobSecretPath = path.join(dotglobDir, '.env');
        const largeGlobDir = path.join(tempRoot, 'large-glob');
        const workGlobDir = path.join(tempRoot, 'work-glob');
        const deepGlobDir = path.join(tempRoot, 'deep-glob');
        mkdirSync(path.dirname(secretPath), { recursive: true });
        mkdirSync(nestedDir, { recursive: true });
        mkdirSync(dashDir, { recursive: true });
        mkdirSync(cdPathSubDir, { recursive: true });
        mkdirSync(stackOtherDir);
        mkdirSync(ordinaryGlobDir);
        mkdirSync(dotglobDir);
        mkdirSync(largeGlobDir);
        mkdirSync(workGlobDir);
        mkdirSync(deepGlobDir);
        writeFileSync(secretPath, 'FAKE PRIVATE KEY');
        writeFileSync(ordinaryPath, 'ordinary');
        writeFileSync(ordinaryGlobPath, 'ordinary glob content');
        writeFileSync(dotglobSecretPath, 'DOTGLOB_SECRET=must-not-leak');
        for (let index = 0; index <= 1_024; index += 1) {
          writeFileSync(path.join(largeGlobDir, `match-${index}.txt`), 'ordinary');
        }
        for (let index = 0; index < 4_096; index += 1) {
          writeFileSync(path.join(workGlobDir, `nonmatch-${index}.txt`), 'ordinary');
        }
        let deepCursor = deepGlobDir;
        for (let depth = 0; depth <= 64; depth += 1) {
          deepCursor = path.join(deepCursor, `level-${depth}`);
          mkdirSync(deepCursor);
        }
        writeFileSync(path.join(deepCursor, 'ordinary.txt'), 'ordinary');
        symlinkSync(secretPath, secretLink);
        symlinkSync(secretPath, nestedSecretLink);
        symlinkSync(secretPath, dashSecretLink);
        symlinkSync(secretPath, lateSecretLink);
        symlinkSync(secretPath, rootScopedSecretLink);
        symlinkSync(secretPath, escapedSecretLink);
        symlinkSync(secretPath, rootCdRedirectSecretLink);
        symlinkSync(ordinaryPath, nestedScopedOrdinaryLink);
        symlinkSync(ordinaryPath, nestedCdRedirectOrdinaryLink);
        symlinkSync(ordinaryPath, nestedOrdinaryReadLink);
        symlinkSync(secretPath, cdPathSecretLink);
        symlinkSync(ordinaryPath, rootCwdSwitchOrdinaryLink);
        symlinkSync(secretPath, nestedCwdSwitchSecretLink);
        symlinkSync(ordinaryPath, stackOtherOrdinaryLink);
        symlinkSync(ordinaryPath, ordinaryLink);

        expect(context.collectResolvedCredentialPaths?.({ path: secretLink })).toEqual([
          realpathSync(secretPath),
        ]);
        expect(context.collectResolvedCredentialPaths?.({ path: ordinaryLink })).toEqual([]);
        expect(context.resolvedCredentialEvidenceForHost?.([], true)).toBeNull();
        expect(context.resolvedCredentialEvidenceForHost?.([], false)).toEqual([]);
        expect(context.resolvedCredentialEvidenceForHost?.([secretPath], true)).toEqual([secretPath]);

        const secretCommand = `cat<${secretLink}`;
        const ordinaryCommand = `cat<${ordinaryLink}`;
        expect(context.parseShellInputRedirections?.(secretCommand).command.trim()).toBe('cat');
        expect(context.bashInputReadTargets?.({ command: secretCommand })).toEqual([secretLink]);
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: secretCommand }),
        )).toEqual([realpathSync(secretPath)]);
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: ordinaryCommand }),
        )).toEqual([]);
        const escapedBackslashCommand = 'cat <"innocent\\\\q"';
        expect(context.bashInputReadEvidence?.({ command: escapedBackslashCommand })).toEqual({
          targets: [escapedSecretLink],
          unresolved: true,
        });
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: escapedBackslashCommand }),
        )).toEqual([realpathSync(secretPath)]);
        for (const cdRedirectOperator of ['<>', '<']) {
          const command = `cd ${nestedDir} ${cdRedirectOperator}${cdRedirectName} && cat <${nestedOrdinaryReadName}`;
          const evidence = context.bashInputReadEvidence?.({ command });
          expect(evidence?.unresolved, command).toBe(false);
          expect(evidence?.targets, command).toEqual([
            rootCdRedirectSecretLink,
            nestedOrdinaryReadLink,
          ]);
          expect(context.collectResolvedCredentialPaths?.(evidence?.targets), command)
            .toEqual([realpathSync(secretPath)]);
        }
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({
            command: `cd ${nestedDir} <ordinary-link.txt && cat <${nestedOrdinaryReadName}`,
          }),
        )).toEqual([]);
        const readWriteSecretCommand = `cat 3<>${secretLink}`;
        expect(context.parseShellInputRedirections?.(readWriteSecretCommand)).toEqual({
          command: readWriteSecretCommand,
          targets: [secretLink],
          targetPrefixes: ['cat 3'],
          targetMayExpand: [false],
          hasUnresolvedTarget: false,
        });
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: readWriteSecretCommand }),
        )).toEqual([realpathSync(secretPath)]);
        for (const expandedCommand of [
          `cat <>${path.join(tempRoot, 'innocent.*')}`,
          'cat <>~/innocent.*',
        ]) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: expandedCommand }),
          ), expandedCommand).toEqual([realpathSync(secretPath)]);
        }
        expect(context.bashInputReadEvidence?.({
          command: `cd ${ordinaryGlobDir} && cat <*.txt`,
        })).toEqual({ targets: [ordinaryGlobPath], unresolved: false });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${largeGlobDir} && cat <*.txt`,
        })).toEqual({ targets: [], unresolved: true });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${workGlobDir} && cat <*.json`,
        })).toEqual({ targets: [], unresolved: true });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${deepGlobDir} && cat <**/*`,
        })).toEqual({ targets: [], unresolved: true });
        context.process.env.BASHOPTS = 'checkwinsize:dotglob';
        expect(context.bashInputReadEvidence?.({
          command: `cd ${dotglobDir} && cat <*>`,
        })).toEqual({ targets: [], unresolved: true });
        delete context.process.env.BASHOPTS;
        for (const command of [
          `cd ${dotglobDir} && shopt -s dotglob; cat <*>`,
          `cd ${dotglobDir} && builtin shopt -s nullglob dotglob && cat <*>`,
          `cd ${dotglobDir} && builtin 2>/dev/null shopt -s dotglob; cat <*>`,
          `cd ${dotglobDir} && command shopt -u dotglob; cat <*>`,
          `cd ${dotglobDir} && set +f; cat <*>`,
          `cd ${dotglobDir} && set -o noglob; cat <*>`,
          `cd ${dotglobDir} && GLOBIGNORE=ordinary; cat <*>`,
          `cd ${dotglobDir} && export GLOBIGNORE=ordinary; cat <*>`,
          `cd ${dotglobDir} && declare GLOBIGNORE=ordinary; cat <*>`,
          `cd ${dotglobDir} && printf -v GLOBIGNORE ordinary; cat <*>`,
          `cd ${dotglobDir} && read GLOBIGNORE <<<ordinary; cat <*>`,
          `cd ${dotglobDir} && unset GLOBIGNORE; cat <*>`,
          `cd ${dotglobDir} && trap 'shopt -s dotglob' DEBUG; cat <*>`,
          `cd ${dotglobDir} && LC_COLLATE=C; cat <[.-0]env`,
          `HOME=${dotglobDir}; cat <~/*`,
        ]) {
          expect(context.bashInputReadEvidence?.({ command }), command)
            .toEqual({ targets: [], unresolved: true });
        }
        for (const command of [
          `cd ${ordinaryGlobDir} && shopt -q dotglob; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && shopt -p dotglob; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && set -euo pipefail; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && printf '%s' GLOBIGNORE; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && printf '%s' "$GLOBIGNORE"; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && >$LOG shopt -q dotglob; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && GLOBIGNORE_TEXT=x; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && trap; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && (shopt -s dotglob); cat <ordinary*`,
          `cd ${ordinaryGlobDir} && bash -O dotglob -c true; cat <ordinary*`,
          `cd ${ordinaryGlobDir} && shopt -s dotglob <ordinary*`,
        ]) {
          expect(context.bashInputReadEvidence?.({ command }), command)
            .toEqual({ targets: [ordinaryGlobPath], unresolved: false });
        }
        expect(context.bashInputReadEvidence?.({
          command: `cd ${ordinaryGlobDir} && cat <*.txt`,
        })).toEqual({ targets: [ordinaryGlobPath], unresolved: false });
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: "cat <>'innocent.*'" }),
        )).toEqual([]);
        const nestedCommand = `cd ${nestedDir} && cat <nested-innocent.txt`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: nestedCommand }),
        )).toEqual([realpathSync(secretPath)]);

        context.process.env.CDPATH = cdPathRoot;
        for (const cdRedirectOperator of ['<', '<>']) {
          const command = `cd sub ${cdRedirectOperator}ordinary-link.txt && cat <link`;
          expect(context.bashInputReadEvidence?.({ command }), command).toEqual({
            targets: [ordinaryLink, path.join(tempRoot, 'link')],
            unresolved: true,
          });
        }
        expect(context.bashInputReadEvidence?.({
          command: `cd ./nested <ordinary-link.txt && cat <${nestedOrdinaryReadName}`,
        })).toEqual({
          targets: [ordinaryLink, nestedOrdinaryReadLink],
          unresolved: false,
        });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} && cat <${nestedOrdinaryReadName}`,
        })).toEqual({ targets: [nestedOrdinaryReadLink], unresolved: false });
        context.process.env.CDPATH = '.:';
        expect(context.bashInputReadEvidence?.({ command: 'cd nested && cat <nested-innocent.txt' }))
          .toEqual({ targets: [nestedSecretLink], unresolved: false });
        delete context.process.env.CDPATH;

        context.process.env.BASHOPTS = 'checkwinsize:cdable_vars';
        context.process.env.sub = cdPathSubDir;
        expect(context.bashInputReadEvidence?.({ command: 'cd sub && cat <link' }))
          .toEqual({ targets: [path.join(tempRoot, 'link')], unresolved: true });
        delete context.process.env.BASHOPTS;
        delete context.process.env.sub;

        context.process.env.BASH_ENV = path.join(tempRoot, 'shell-startup');
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} && cat <${nestedOrdinaryReadName}`,
        })).toEqual({
          targets: [path.join(tempRoot, nestedOrdinaryReadName)],
          unresolved: true,
        });
        delete context.process.env.BASH_ENV;
        context.process.env.ENV = 'development';
        expect(context.bashInputReadEvidence?.({ command: nestedCommand }))
          .toEqual({ targets: [nestedSecretLink], unresolved: false });
        delete context.process.env.ENV;
        for (const builtin of ['cd', 'pushd']) {
          context.process.env[`BASH_FUNC_${builtin}%%`] = '() { builtin cd "$HOME"; }';
          expect(context.bashInputReadEvidence?.({
            command: `${builtin} ${nestedDir} && cat <${nestedOrdinaryReadName}`,
          }), builtin).toEqual({ targets: [path.join(tempRoot, nestedOrdinaryReadName)], unresolved: true });
          delete context.process.env[`BASH_FUNC_${builtin}%%`];
        }

        const redirectedDirectoryCommands = [
          `cd ${nestedDir} >/dev/null && cat <nested-innocent.txt`,
          `cd ${nestedDir} 2>/dev/null 3>&1 && cat <nested-innocent.txt`,
          `pushd ${nestedDir} &>/dev/null && cat <nested-innocent.txt`,
          `cd ${nestedDir} </dev/null >>redirect.log && cat <nested-innocent.txt`,
          `cd ${nestedDir} <<<ready && cat <nested-innocent.txt`,
          `cd ${nestedDir} >/dev/null \\\n&& cat <nested-innocent.txt`,
          `cd ${nestedDir} >/dev/null # quiet\ncat <nested-innocent.txt`,
        ];
        for (const redirectedCommand of redirectedDirectoryCommands) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: redirectedCommand }),
          ), redirectedCommand).toEqual([realpathSync(secretPath)]);
        }
        for (const command of [
          `X=1 cd ${nestedDir} && cat <${cwdSwitchName}`,
          `X=1 Y=2 builtin cd ${nestedDir} && cat <${cwdSwitchName}`,
          `X='hello world' 2>/dev/null command -- cd ${nestedDir} && cat <${cwdSwitchName}`,
          `X=1 2>/dev/null builtin cd ${nestedDir} && cat <${cwdSwitchName}`,
          `2>/dev/null X=1 command -- cd ${nestedDir} && cat <${cwdSwitchName}`,
          `X=1 command builtin 2>/dev/null pushd ${nestedDir} && cat <${cwdSwitchName}`,
          `2>/dev/null cd ${nestedDir} && cat <${cwdSwitchName}`,
          `>/dev/null builtin cd ${nestedDir} && cat <${cwdSwitchName}`,
          `builtin 2>/dev/null cd ${nestedDir} && cat <${cwdSwitchName}`,
          `command -p 2>/dev/null cd ${nestedDir} && cat <${cwdSwitchName}`,
          `command -- cd ${nestedDir} && cat <${cwdSwitchName}`,
          `builtin -- cd ${nestedDir} && cat <${cwdSwitchName}`,
          `builtin command cd ${nestedDir} && cat <${cwdSwitchName}`,
          `command builtin 2>/dev/null pushd ${nestedDir} && cat <${cwdSwitchName}`,
          `{saved}>/dev/null builtin cd ${nestedDir} && cat <${cwdSwitchName}`,
          `(2>/dev/null builtin cd ${nestedDir} && cat <${cwdSwitchName})`,
        ]) {
          const evidence = context.bashInputReadEvidence?.({ command });
          expect(evidence, command).toEqual({ targets: [nestedCwdSwitchSecretLink], unresolved: false });
          expect(context.collectResolvedCredentialPaths?.(evidence?.targets), command)
            .toEqual([realpathSync(secretPath)]);
        }
        for (const command of [
          `source change-dir.sh; cat <${cwdSwitchName}`,
          `. ./change-dir.sh && cat <${cwdSwitchName}`,
          `builtin source change-dir.sh; cat <${cwdSwitchName}`,
          `builtin -- . ./change-dir.sh; cat <${cwdSwitchName}`,
          `command eval 'cd nested'; cat <${cwdSwitchName}`,
          `X=1 2>/dev/null source change-dir.sh; cat <${cwdSwitchName}`,
          `false || source change-dir.sh; cat <${cwdSwitchName}`,
        ]) {
          expect(context.bashInputReadEvidence?.({ command }), command).toEqual({
            targets: [rootCwdSwitchOrdinaryLink],
            unresolved: true,
          });
        }
        expect(context.bashInputReadEvidence?.({
          command: 'source change-dir.sh <ordinary-link.txt',
        })).toEqual({ targets: [ordinaryLink], unresolved: false });
        expect(context.bashInputReadEvidence?.({
          command: '(source change-dir.sh); cat <ordinary-link.txt',
        })).toEqual({ targets: [ordinaryLink], unresolved: false });
        expect(context.bashInputReadEvidence?.({
          command: 'bash change-dir.sh; cat <ordinary-link.txt',
        })).toEqual({ targets: [ordinaryLink], unresolved: false });
        expect(context.bashInputReadEvidence?.({
          command: `(source change-dir.sh; cat <${cwdSwitchName})`,
        })).toEqual({ targets: [rootCwdSwitchOrdinaryLink], unresolved: true });
        expect(context.bashInputReadEvidence?.({ command: 'source change-dir.sh' }))
          .toEqual({ targets: [], unresolved: false });
        expect(context.bashInputReadEvidence?.({
          command: `printf '%s' 'source change-dir.sh'; cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: false });

        expect(context.bashInputReadEvidence?.({
          command: `CDPATH=${cdPathRoot} cd sub && cat <${cwdSwitchName}`,
        })).toEqual({
          targets: [rootCwdSwitchOrdinaryLink],
          unresolved: true,
        });
        for (const dynamicAssignmentCommand of [
          `X=$TARGET cd ${nestedDir} && cat <${cwdSwitchName}`,
          `X=$(printf value) cd ${nestedDir} && cat <${cwdSwitchName}`,
          `X=\`printf value\` cd ${nestedDir} && cat <${cwdSwitchName}`,
        ]) {
          const evidence = context.bashInputReadEvidence?.({ command: dynamicAssignmentCommand });
          expect(evidence?.unresolved, dynamicAssignmentCommand).toBe(true);
          expect(evidence?.targets.every((target) =>
            target === rootCwdSwitchOrdinaryLink || target === nestedCwdSwitchSecretLink),
          dynamicAssignmentCommand).toBe(true);
        }
        expect(context.bashInputReadEvidence?.({
          command: `X=1 printf '%s' cd; cat <${cwdSwitchName}`,
        })).toEqual({
          targets: [rootCwdSwitchOrdinaryLink],
          unresolved: false,
        });
        expect(context.bashInputReadEvidence?.({
          command: `X=\`printf cd\` printf ok; cat <${cwdSwitchName}`,
        })).toEqual({
          targets: [rootCwdSwitchOrdinaryLink],
          unresolved: false,
        });
        for (const rotation of ['+1', '-1']) {
          const command = `pushd ${nestedDir} >/dev/null; pushd ${stackOtherDir} >/dev/null; pushd ${rotation} >/dev/null; cat <${cwdSwitchName}`;
          const evidence = context.bashInputReadEvidence?.({ command });
          expect(evidence?.unresolved, command).toBe(true);
          expect(evidence?.targets, command).toContain(stackOtherOrdinaryLink);
          expect(evidence?.targets.every((target) => [
            rootCwdSwitchOrdinaryLink,
            nestedCwdSwitchSecretLink,
            stackOtherOrdinaryLink,
          ].includes(target)), command).toBe(true);
        }
        for (const command of [
          `D=cd; $D ${nestedDir} && cat <${cwdSwitchName}`,
          `UNSET=; c${'${UNSET}'}d ${nestedDir} && cat <${cwdSwitchName}`,
          `UNSET=; bu${'${UNSET}'}iltin -- cd ${nestedDir} && cat <${cwdSwitchName}`,
        ]) {
          expect(context.bashInputReadEvidence?.({ command }), command)
            .toEqual({ targets: [rootCwdSwitchOrdinaryLink], unresolved: true });
        }
        const mixedConditionalCommand = `true || cd ${nestedDir} && cat <${scopedLinkName}`;
        const mixedConditionalEvidence = context.bashInputReadEvidence?.({ command: mixedConditionalCommand });
        expect(mixedConditionalEvidence?.targets, mixedConditionalCommand)
          .toEqual([rootScopedSecretLink, nestedScopedOrdinaryLink]);
        expect(context.collectResolvedCredentialPaths?.(mixedConditionalEvidence?.targets))
          .toEqual([realpathSync(secretPath)]);
        for (const command of [
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && builtin popd +0 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd -2 && cat <${cwdSwitchName}`,
          `pushd -n ${nestedDir} && popd && cat <${cwdSwitchName}`,
        ]) {
          const evidence = context.bashInputReadEvidence?.({ command });
          expect(evidence, command).toEqual({ targets: [nestedCwdSwitchSecretLink], unresolved: false });
          expect(context.collectResolvedCredentialPaths?.(evidence?.targets), command)
            .toEqual([realpathSync(secretPath)]);
        }
        for (const command of [
          `pushd ${nestedDir} && popd && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd && popd && cat <${cwdSwitchName}`,
        ]) {
          expect(context.bashInputReadEvidence?.({ command }), command).toEqual({
            targets: [rootCwdSwitchOrdinaryLink],
            unresolved: false,
          });
        }
        for (const command of [
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd +1 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd +2 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd -0 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd -1 && cat <${cwdSwitchName}`,
        ]) {
          expect(context.bashInputReadEvidence?.({ command }), command).toEqual({
            targets: [stackOtherOrdinaryLink],
            unresolved: false,
          });
        }
        for (const command of [
          `pushd +0 && cat <ordinary-link.txt`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && pushd +0 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd -n +0 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd -n +1 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd -n -0 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && popd -n +0 && pushd +0 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && pushd -n +0 && cat <${cwdSwitchName}`,
          `pushd ${nestedDir} && pushd ${stackOtherDir} && pushd -n +1 && cat <${cwdSwitchName}`,
        ]) {
          expect(context.bashInputReadEvidence?.({ command }), command).toEqual({
            targets: [command.startsWith('pushd +0') ? ordinaryLink : stackOtherOrdinaryLink],
            unresolved: false,
          });
        }
        const pushdRotationCommand = `pushd ${nestedDir} && pushd ${stackOtherDir} && pushd +1 && cat <${cwdSwitchName}`;
        const pushdRotationEvidence = context.bashInputReadEvidence?.({ command: pushdRotationCommand });
        expect(pushdRotationEvidence, pushdRotationCommand)
          .toEqual({ targets: [nestedCwdSwitchSecretLink], unresolved: false });
        expect(context.collectResolvedCredentialPaths?.(pushdRotationEvidence?.targets))
          .toEqual([realpathSync(secretPath)]);
        const sequentialPopdCommand = `pushd ${nestedDir}; pushd ${stackOtherDir}; popd; cat <${cwdSwitchName}`;
        const sequentialPopdEvidence = context.bashInputReadEvidence?.({ command: sequentialPopdCommand });
        expect(sequentialPopdEvidence?.unresolved, sequentialPopdCommand).toBe(true);
        expect(sequentialPopdEvidence?.targets, sequentialPopdCommand)
          .toContain(nestedCwdSwitchSecretLink);
        expect(context.collectResolvedCredentialPaths?.(sequentialPopdEvidence?.targets))
          .toEqual([realpathSync(secretPath)]);
        expect(context.bashInputReadEvidence?.({
          command: `popd >/dev/null; cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        context.process.env['BASH_FUNC_popd%%'] = '() { builtin cd "$HOME"; }';
        expect(context.bashInputReadEvidence?.({
          command: `popd >/dev/null; cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        delete context.process.env['BASH_FUNC_popd%%'];
        expect(context.bashInputReadEvidence?.({
          command: `pushd -n ${nestedDir} >/dev/null && cat <ordinary-link.txt`,
        })).toEqual({
          targets: [ordinaryLink],
          unresolved: false,
        });
        expect(context.bashInputReadEvidence?.({
          command: `true && 2>/dev/null builtin pushd ${nestedDir} && cat <${cwdSwitchName}`,
        })).toEqual({
          targets: [nestedCwdSwitchSecretLink],
          unresolved: false,
        });
        expect(context.bashInputReadEvidence?.({
          command: `2>/missing builtin cd ${nestedDir}; cat <${cwdSwitchName}`,
        })).toEqual({
          targets: [rootCwdSwitchOrdinaryLink, nestedCwdSwitchSecretLink],
          unresolved: false,
        });
        const dynamicPrefixedEvidence = context.bashInputReadEvidence?.({
          command: `>$(printf out) builtin cd ${nestedDir} && cat <ordinary-link.txt`,
        });
        expect(dynamicPrefixedEvidence?.unresolved).toBe(true);
        expect(context.collectResolvedCredentialPaths?.(dynamicPrefixedEvidence?.targets)).toEqual([]);
        expect(context.bashInputReadEvidence?.({
          command: '>$(printf cd) cat <ordinary-link.txt',
        })).toEqual({ targets: [ordinaryLink], unresolved: false });
        const ordinaryPrefixedCommand = `2>/dev/null builtin -- cd ${nestedDir} && cat <${nestedOrdinaryReadName}`;
        const ordinaryPrefixedEvidence = context.bashInputReadEvidence?.({ command: ordinaryPrefixedCommand });
        expect(ordinaryPrefixedEvidence).toEqual({ targets: [nestedOrdinaryReadLink], unresolved: false });
        expect(context.collectResolvedCredentialPaths?.(ordinaryPrefixedEvidence?.targets)).toEqual([]);
        expect(context.bashInputReadEvidence?.({
          command: `builtin $BUILTIN_OPTION cd ${nestedDir} && cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });

        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} >/dev/null && cat <${scopedLinkName}`,
        })).toEqual({ targets: [nestedScopedOrdinaryLink], unresolved: false });
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({
            command: `cd ${nestedDir} >/missing/output; cat <${scopedLinkName}`,
          }),
        )).toEqual([realpathSync(secretPath)]);
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} >$LOG && cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} {fd}>/dev/null && cat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        expect(context.bashInputReadEvidence?.({
          command: `cd ${nestedDir} <<EOF\nignored\nEOF\ncat <ordinary-link.txt`,
        })).toEqual({ targets: [ordinaryLink], unresolved: true });
        for (const groupedCommand of [
          `(cd ${nestedDir} && cat <>nested-innocent.txt)`,
          `{ cd ${nestedDir} && cat 3<>nested-innocent.txt; }`,
          `if cd ${nestedDir}; then cat 7<>nested-innocent.txt; fi`,
          'cd ~/nested && cat 8<>nested-innocent.txt',
          'cd nest* && cat 9<>nested-innocent.txt',
        ]) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: groupedCommand }),
          ), groupedCommand).toEqual([realpathSync(secretPath)]);
        }
        for (const scopedCommand of [
          `(cd ${nestedDir} && true); cat <>${scopedLinkName}`,
          `if false; then cd ${nestedDir}; fi; cat 3<>${scopedLinkName}`,
          `false && cd ${nestedDir}; cat 4<>${scopedLinkName}`,
          `true || cd ${nestedDir}; cat 5<>${scopedLinkName}`,
          `cd ${path.join(tempRoot, 'missing')} && :; cat 6<>${scopedLinkName}`,
          `case x in y) cd ${nestedDir};; esac; cat 7<>${scopedLinkName}`,
        ]) {
          expect(context.collectResolvedCredentialPaths?.(
            context.bashInputReadTargets?.({ command: scopedCommand }),
          ), scopedCommand).toEqual([realpathSync(secretPath)]);
        }
        const optionTerminatedCdCommand = 'cd -- -credential-dir && cat <innocent.txt';
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: optionTerminatedCdCommand }),
        )).toEqual([realpathSync(secretPath)]);
        const quotedNoiseCommand = `printf '%s' '; cd a; cd b; cd c; cd d; cd e; cd f'; cd ${nestedDir}; cat <nested-innocent.txt`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: quotedNoiseCommand }),
        )).toEqual([realpathSync(secretPath)]);
        const targetBeforeCdCommand = `cat <late-only-secret-link; cd ${nestedDir}`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: targetBeforeCdCommand }),
        )).toEqual([]);
        const multilineCommand = `true # cat <ignored\ncd ${nestedDir}\ncat <nested-innocent.txt`;
        expect(context.collectResolvedCredentialPaths?.(
          context.bashInputReadTargets?.({ command: multilineCommand }),
        )).toEqual([realpathSync(secretPath)]);
        const dynamicCommand = 'cat <$(printf .env)';
        expect(context.parseShellInputRedirections?.(dynamicCommand)).toEqual({
          command: dynamicCommand,
          targets: [],
          targetPrefixes: [],
          targetMayExpand: [],
          hasUnresolvedTarget: true,
        });
        expect(context.bashInputReadTargets?.({ command: dynamicCommand })).toEqual([]);
        expect(context.bashInputReadEvidence?.({ command: dynamicCommand })).toEqual({
          targets: [],
          unresolved: true,
        });
        expect(context.bashInputReadEvidence?.({ command: 'cat <>~cindy-no-such-user/innocent.txt' }))
          .toEqual({ targets: [], unresolved: true });
        expect(context.parseShellInputRedirections?.('cat <>created')).toEqual({
          command: 'cat <>created',
          targets: ['created'],
          targetPrefixes: ['cat '],
          targetMayExpand: [false],
          hasUnresolvedTarget: false,
        });
        expect(source).toContain("event.toolName === 'bash'\n      ? bashInputReadEvidence(event.input)");
        expect(source).toContain("event.toolName === 'powershell'\n        ? powershellInputReadEvidence(event.input)");
        expect(source).toContain('isCindyShellTool(event.toolName) && (bashReadEvidence.unresolved || touchesCredentialPath(bashReadTargets))');
        expect(source).toContain('resolvedCredentialPaths: credentialEvidenceForHost');
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it('overrides find with the managed ripgrep backend instead of runtime fd download', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;

    for (const tool of ['createBashTool', 'createFindTool', 'createGrepTool', 'createLsTool']) {
      expect(source).toContain(tool + ',');
    }
    expect(source).toContain('import * as piCodingAgent from');
    expect(source).toContain('createPowerShellTool');
    expect(source).toContain('function isCindyShellTool');
    expect(source).toContain('function powershellInputReadEvidence');
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

  it('preserves the permission denial source across the private Pi UI envelope', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    expect(source).toContain('await ctx.ui.input(');
    expect(source).toContain("const PERMISSION_USER_DENY = 'user-deny'");
    expect(source).toContain("const PERMISSION_AUTO_REVIEW_DENY = 'auto-review-deny'");
    expect(source).toContain('User denied this tool call via Cindy.');
    expect(source).toContain('Cindy Auto-review denied this tool call.');
    expect(source).toContain('Cindy could not approve this tool call.');
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

  it('registers the native PowerShell overlay on Windows when Pi exports its factory', () => {
    expect(powerShellOverlayEnabled('win32', () => undefined)).toBe(true);
    expect(powerShellOverlayEnabled('win32', undefined)).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)(
    'does not register the native PowerShell overlay on %s',
    (platform) => {
      expect(powerShellOverlayEnabled(platform, () => undefined)).toBe(false);
    },
  );

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
    expect(source).toContain("'vision: wire protocol is not configured'");
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
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("String(captureToolName ?? '').startsWith('mcp__')");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('captureToolName = gatewayCall?.qualifiedName');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('captureInput = gatewayCall?.args');
  });

  it('routes PowerShell results through the same opaque turn-change capture as bash', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const handlerStart = source.indexOf("pi.on('tool_result'");
    const handlerEnd = source.indexOf('// ── 视觉桥工具', handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(source).toContain("return toolName === 'bash' || toolName === 'powershell';");
    expect(handler).toContain('if (!isCindyShellTool(captureToolName)');
    expect(handler).toContain('TURN_CHANGE_CAPTURE_TITLE');
  });

  it('exposes a constant two-tool MCP gateway while preserving the real MCP identity for approval', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("const CINDY_MCP_LIST_TOOLS = 'cindy_mcp_list_tools'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("const CINDY_MCP_CALL_TOOL = 'cindy_mcp_call_tool'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('mcpGateway.register(pi)');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("qualifiedName: 'mcp__' + serverName + '__' + toolName");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('private readonly disclosedSchemas');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('mcpGateway.isSchemaDisclosed(resolvedGatewayCall)');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('Inspect this tool before execution');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('permissionToolName = gatewayCall?.qualifiedName');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('permissionInput = gatewayCall?.args');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain("name: qualifiedName,\n        label: server.name + ': ' + tool.name");
  });

  it('resolves the bash package home across reloads with a tamper-proof stash and keeps the package token out of globalThis', () => {
    // #3070 回归:首次加载读 env → 删 → 防篡改 stash;重载时 env 已被消费,
    // 经 stash 与 PI_CODING_AGENT_DIR 派生值双重验证后取回,bash 不再永久 fail-closed。
    const helper = loadBashPackageHomeHelper();
    const injected = '/host/agent-home/run-tmp/abc/bash-package-home';

    // 首次加载:读到 host 注入值,env 随即被删,stash 以 non-writable /
    // non-configurable 属性建立。
    helper.env.CINDY_PI_BASH_PACKAGE_HOME = injected;
    helper.env.PI_CODING_AGENT_DIR = '/host/agent-home/run-tmp/abc';
    expect(helper.resolveBashPackageHome()).toBe(injected);
    expect(helper.env.CINDY_PI_BASH_PACKAGE_HOME).toBeUndefined();
    const descriptor = Object.getOwnPropertyDescriptor(
      helper.globalThis,
      '__cindyBridgeBashPackageHome',
    );
    expect(descriptor?.writable).toBe(false);
    expect(descriptor?.configurable).toBe(false);
    expect(descriptor?.value).toBe(injected);

    // 重载(#3070 现场):env 已被首次加载删除,stash 与 PI_CODING_AGENT_DIR 派生值
    // 双重一致 → 取回原始值。
    expect(helper.resolveBashPackageHome()).toBe(injected);
    expect(helper.env.CINDY_PI_BASH_PACKAGE_HOME).toBeUndefined();

    // 进程内代码事后改写注入 env:被删除并忽略,stash 值不变。
    helper.env.CINDY_PI_BASH_PACKAGE_HOME = '/attacker/home';
    expect(helper.resolveBashPackageHome()).toBe(injected);
    expect(helper.env.CINDY_PI_BASH_PACKAGE_HOME).toBeUndefined();

    // 事后改写 PI_CODING_AGENT_DIR(canary 失配)→ 重载 fail-closed。
    helper.env.PI_CODING_AGENT_DIR = '/attacker/controlled';
    expect(helper.resolveBashPackageHome()).toBeUndefined();
    helper.env.PI_CODING_AGENT_DIR = '/host/agent-home/run-tmp/abc';
    expect(helper.resolveBashPackageHome()).toBe(injected);

    // stash 属性被替换成 plain 赋值(可写可配置)→ 不被信任 → 走首次加载路径。
    // (defineProperty 定义 non-configurable 属性后无法 redefine,这里用一个
    // fresh context 模拟「攻击者抢跑预置了 plain stash」的形态。)
    const hostile = loadBashPackageHomeHelper();
    hostile.env.PI_CODING_AGENT_DIR = '/attacker/agent-home';
    Object.defineProperty(hostile.globalThis, '__cindyBridgeBashPackageHome', {
      value: '/attacker/agent-home/bash-package-home',
      writable: true,
      configurable: true,
      enumerable: false,
    });
    // 攻击者形态 stash 不被信任 → 走首次加载路径;env 未注入 → 从 PI_CODING_AGENT_DIR 派生。
    // PI_CODING_AGENT_DIR 本就常驻可写,控制它与控制注入 env 同级,不新增威胁面。
    expect(hostile.resolveBashPackageHome()).toBe('/attacker/agent-home/bash-package-home');

    // 非 Cindy 初始化的进程(env 从未注入、无 stash、PI_CODING_AGENT_DIR 未设置)保持 fail-closed。
    const fresh = loadBashPackageHomeHelper();
    expect(fresh.resolveBashPackageHome()).toBeUndefined();

    // 结构断言:入口走 resolveBashPackageHome,注入 env 的裸 delete 只在 helper 内。
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    expect(source).toContain('const bashPackageHome = resolveBashPackageHome();');
    expect(source.match(/delete process\.env\[PI_BASH_PACKAGE_HOME_ENV\];/g)).toHaveLength(1);
    expect(source.indexOf('delete process.env[PI_BASH_PACKAGE_HOME_ENV];')).toBeLessThan(
      source.indexOf('export default async function cindyBridge'),
    );

    // 凭证不进 globalThis stash(review P1):包管理 token 保持读一次即删、
    // 仅闭包持有 —— 同进程的第三方托管扩展与 bridge 共享 globalThis,stash
    // 等于把 bearer token 暴露给任意托管代码。重载后工具退场是可接受代价。
    expect(source).toContain('const piPackageManagementToken = process.env[PI_PACKAGE_MANAGEMENT_ENV];');
    expect(source).toContain('delete process.env[PI_PACKAGE_MANAGEMENT_ENV];');
    expect(source.indexOf('delete process.env[PI_PACKAGE_MANAGEMENT_ENV];')).toBeGreaterThan(
      source.indexOf('export default async function cindyBridge'),
    );
    const helperSlice = source.slice(
      source.indexOf('const BRIDGE_RELOAD_STASH_GLOBAL'),
      source.indexOf('// 凭证/密钥路径特征由 maker-core 的单一来源生成'),
    );
    expect(helperSlice).not.toContain('CINDY_PI_PACKAGE_MANAGEMENT');
  });

  it('falls back to PI_CODING_AGENT_DIR derivation when neither env nor stash is available (subagent subprocess, #3132)', () => {
    // subagent 子进程：父 bridge 已消费并删除 CINDY_PI_BASH_PACKAGE_HOME，子进程无 stash。
    // PI_CODING_AGENT_DIR 存在且为绝对路径时从中派生；否则 fail-closed。
    const sub = loadBashPackageHomeHelper();
    sub.env.PI_CODING_AGENT_DIR = '/host/agent-home/run-tmp/abc';
    expect(sub.resolveBashPackageHome()).toBe('/host/agent-home/run-tmp/abc/bash-package-home');
    expect(sub.env.CINDY_PI_BASH_PACKAGE_HOME).toBeUndefined();

    // 相对路径 fail-closed。
    const rel = loadBashPackageHomeHelper();
    rel.env.PI_CODING_AGENT_DIR = 'relative/path';
    expect(rel.resolveBashPackageHome()).toBeUndefined();

    // PI_CODING_AGENT_DIR 缺失 fail-closed。
    const noDir = loadBashPackageHomeHelper();
    expect(noDir.resolveBashPackageHome()).toBeUndefined();
  });

  it('blocks Pi package mutations before bash while preserving ordinary commands', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('bashCommandMutatesPiPackages(nextParams)');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "const PI_BASH_PACKAGE_HOME_ENV = 'CINDY_PI_BASH_PACKAGE_HOME'",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('clean.PI_CODING_AGENT_DIR = bashPackageHome');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('delete clean.PI_PACKAGE_DIR');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('token: piPackageManagementToken');

    const mutatesPiPackages = loadPiPackageMutationCommandHelper();
    const commands = [
      'pi install npm:context-mode',
      "sh -c 'pi install npm:context-mode'",
      'p=pi; "$p" install npm:context-mode',
      '/opt/cindy/pi install npm:context-mode',
      'C:/Cindy/pi.exe remove npm:context-mode',
      'PI_CODING_AGENT_DIR=/tmp/elsewhere pi update npm:context-mode',
      'env -u PI_CODING_AGENT_DIR pi install npm:context-mode',
      'env PI_CODING_AGENT_DIR=/tmp/elsewhere /opt/cindy/pi update npm:context-mode',
      'command -p pi remove npm:context-mode',
      'exec -- /opt/cindy/pi install npm:context-mode',
      'exec -a managed-pi /opt/cindy/pi update npm:context-mode',
      'sudo -u root env -u PI_CODING_AGENT_DIR pi update npm:context-mode',
      'sudo --user root /opt/cindy/pi remove npm:context-mode',
      "bash -lc 'command pi remove npm:context-mode'",
      "eval 'unset PI_CODING_AGENT_DIR; pi install npm:context-mode'",
      "command eval 'pi update npm:context-mode'",
      "builtin eval 'pi remove npm:context-mode'",
      "exec eval 'pi install npm:context-mode'",
      "env eval 'pi update npm:context-mode'",
      "sudo env eval 'pi remove npm:context-mode'",
      "bash -lc \"eval 'pi install npm:context-mode'\"",
      "eval \"eval 'pi update npm:context-mode'\"",
      "eval 'env -u PI_CODING_AGENT_DIR pi remove npm:context-mode'",
      'eval "$DYNAMIC_COMMAND"',
      'eval "$(printf pi) install npm:context-mode"',
      "printf '%s\\0' '-u PI_CODING_AGENT_DIR pi install npm:context-mode' | xargs -0 env",
      "printf '%s\\0' 'pi update npm:context-mode' | xargs -0 sh -c",
      "printf '%s\\0' 'pi remove npm:context-mode' | parallel",
      'find . -exec env -u PI_CODING_AGENT_DIR pi install npm:context-mode +',
      '$(printf pi) install npm:context-mode',
      'echo safe && pi install npm:context-mode',
    ];
    for (const command of commands) {
      expect(mutatesPiPackages({ command }), command).toBe(true);
      const isolate = loadBashIsolationHelper(path);
      const env = isolate(
        {
          PI_CODING_AGENT_DIR: '/real/runtime-home',
          PI_PACKAGE_DIR: '/cindy/managed-package-home',
          CINDY_PI_PACKAGE_MANAGEMENT: 'secret',
          COMMAND_CANARY: command,
        },
        '/isolated/bash-pi-home',
      );
      expect(env).toMatchObject({
        PI_CODING_AGENT_DIR: '/isolated/bash-pi-home',
        COMMAND_CANARY: command,
      });
      expect(env.PI_PACKAGE_DIR).toBeUndefined();
      expect(env.CINDY_PI_PACKAGE_MANAGEMENT).toBeUndefined();
      expect(JSON.stringify(env)).not.toContain('/real/runtime-home');
      expect(JSON.stringify(env)).not.toContain('/cindy/managed-package-home');
    }

    for (const command of [
      'pi --version',
      'pi help install',
      'npm install context-mode',
      'echo pi install npm:context-mode',
      "printf '%s\\n' 'pi install npm:context-mode'",
      "eval 'printf safe'",
      "eval -- 'printf safe'",
      "eval 'echo pi install npm:context-mode'",
      "printf '%s\\0' safe | xargs -0 echo",
      "printf '%s\\n' safe | parallel echo {}",
      "find . -name '*.ts' -print",
      'bash --version',
      'source ./ordinary-script.sh',
      '. ./ordinary-script.sh',
      'command source ./ordinary-script.sh',
      'builtin . ./ordinary-script.sh',
      'bash ./ordinary-script.sh',
      'cat ./pi',
      'curl https://example.test/pi-install-notes',
      'sudo whoami',
      'ps aux',
      'cat ~/.ssh/id_ed25519',
      'rm -rf ./ordinary-worktree-directory',
    ]) {
      expect(mutatesPiPackages({ command }), command).toBe(false);
    }
    expect(mutatesPiPackages({})).toBe(false);
    expect(mutatesPiPackages({ command: 42 })).toBe(false);

    const isolateWindows = loadBashIsolationHelper(path.win32);
    expect(
      isolateWindows({ PI_CODING_AGENT_DIR: 'C:\\real' }, 'D:\\isolated').PI_CODING_AGENT_DIR,
    ).toBe('D:\\isolated');
    expect(() => isolateWindows({}, 'relative\\home')).toThrow(/unavailable/);
  });

  it('does not let Full Access bypass Cindy-managed extension confirmation', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "if (event.toolName === 'cindy_pi_extension') return;",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "if (permission.mode === 'bypassPermissions') return;",
    );
  });

  it('hard-blocks writes only in read-only reference roots, not external writable roots', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const readOnlyGate = source.indexOf('permission.readOnlyRoots.some((root) =>');
    const credentialGate = source.indexOf('if (isCindyShellTool(event.toolName) && commandReadsProcessEnviron', readOnlyGate);
    expect(readOnlyGate).toBeGreaterThan(-1);
    expect(credentialGate).toBeGreaterThan(readOnlyGate);
    expect(source.slice(readOnlyGate, credentialGate)).not.toContain('permission.writableRoots');
    expect(source).toContain('resolvedWritePath: writeTargetResolved');
    expect(source).toContain(
      'resolvedWritableRoots: resolveWritableRootsForHost(permission.writableRoots)',
    );
    expect(source).toContain('event.input.path = writeTargetResolved');
    expect(source).toContain('Cindy could not verify the real file-write target.');
  });

  it('resolves existing and not-yet-created write targets through an authorized-root link', () => {
    const resolveTarget = loadFileWriteTargetHelper();
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-write-target-'));
    try {
      const authorized = path.join(tempRoot, 'authorized');
      const outside = path.join(tempRoot, 'outside');
      const outsideNested = path.join(outside, 'nested');
      mkdirSync(authorized);
      mkdirSync(outsideNested, { recursive: true });
      const existing = path.join(outside, 'existing.txt');
      writeFileSync(existing, 'outside');
      const linkedDir = path.join(authorized, 'linked');
      symlinkSync(outside, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');

      expect(resolveTarget(path.join(linkedDir, 'existing.txt'))).toBe(realpathSync(existing));
      expect(resolveTarget(path.join(linkedDir, 'nested', 'new.txt'))).toBe(
        path.join(realpathSync(outsideNested), 'new.txt'),
      );

      // Windows junction creation requires an existing target. Unix symlinks let
      // this case prove that an unresolvable ancestor fails closed.
      if (process.platform !== 'win32') {
        const dangling = path.join(authorized, 'dangling');
        symlinkSync(path.join(tempRoot, 'missing-target'), dangling, 'dir');
        expect(resolveTarget(dangling)).toBeNull();
        expect(resolveTarget(path.join(dangling, 'new.txt'))).toBeNull();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('resolves the workspace and writable roots in the write executor filesystem', () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'cindy-pi-writable-root-'));
    try {
      const realWorkspace = path.join(tempRoot, 'real-workspace');
      const realOutput = path.join(tempRoot, 'real-output');
      const workspaceLink = path.join(tempRoot, 'workspace-link');
      const outputLink = path.join(tempRoot, 'output-link');
      mkdirSync(realWorkspace);
      mkdirSync(realOutput);
      symlinkSync(realWorkspace, workspaceLink, process.platform === 'win32' ? 'junction' : 'dir');
      symlinkSync(realOutput, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
      const resolveRoots = loadWritableRootResolver(workspaceLink);

      expect([...resolveRoots([outputLink])!]).toEqual([
        realpathSync(realWorkspace),
        realpathSync(realOutput),
      ]);
      expect(resolveRoots([path.join(tempRoot, 'missing-root')])).toBeNull();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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

  it.skipIf(!canLinkFile)(
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
