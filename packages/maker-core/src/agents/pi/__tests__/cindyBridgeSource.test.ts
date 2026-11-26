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
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { runInNewContext } from 'node:vm';

import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import {
  CINDY_BRIDGE_EXTENSION_SOURCE,
  CINDY_PI_BASH_DEFAULT_TIMEOUT_SECONDS,
  CINDY_PI_BASH_MAX_TIMEOUT_SECONDS,
} from '../cindy-bridge-source.js';
import { formatPermissionDenial } from '../../shared/auto-review-decision.js';

it('strips Fast control paths from shell environments without mutating the runner environment', () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('const SECRET_ENV_NAMES =');
  const end = source.indexOf('function isolatedBashEnvironment', start);
  const compiled = ts.transpileModule(source.slice(start, end) + '\nresult = withoutPiSecrets(input);', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const input = { PATH: '/fixture/bin', CINDY_PI_MODEL_REQUEST_PREFS_FILE: '/fixture/prefs.json',
    CINDY_PI_TASK_SYSTEM_PROMPT_FILE: '/fixture/task-system-prompt.md' };
  const sandbox = {
    process: { env: {} }, input, result: undefined,
    PI_PACKAGE_MANAGEMENT_ENV: 'CINDY_PI_PACKAGE_MANAGEMENT',
    PI_BASH_PACKAGE_HOME_ENV: 'CINDY_PI_BASH_PACKAGE_HOME',
    MANAGED_RG_PATH_ENV: 'CINDY_PI_MANAGED_RG_PATH',
    SUBAGENT_RUN_DIR_ENV: 'CINDY_PI_SUBAGENT_RUN_DIR',
  };
  runInNewContext(compiled, sandbox);
  expect(sandbox.result).toEqual({ PATH: '/fixture/bin' });
  expect(input.CINDY_PI_MODEL_REQUEST_PREFS_FILE).toBe('/fixture/prefs.json');
  expect(input.CINDY_PI_TASK_SYSTEM_PROMPT_FILE).toBe('/fixture/task-system-prompt.md');
});

it('keeps text-only policy local and ordinary tools independent of host UI failures', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const helperStart = source.indexOf('let textOnlyTurnActive = false');
  const helperEnd = source.indexOf('function currentPermissionState', helperStart);
  const handlerStart = source.indexOf("  pi.on('tool_call', async");
  const handlerEnd = source.indexOf('\n  });', handlerStart) + '\n  });'.length;
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  let permissionReads = 0;
  const compiled = ts.transpileModule(
    source.slice(helperStart, helperEnd) + '\ninstallTextOnlyTurnPolicy(pi);\n' + source.slice(handlerStart, handlerEnd),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  runInNewContext(compiled, {
    process: { env: { CINDY_PI_TURN_TOOL_POLICY: 'runtime-token' } },
    guestToolGate: null,
    currentPermissionState: () => { permissionReads++; return { reviewOnly: false, mode: 'bypassPermissions' }; },
    pi: { on: (event: string, callback: (event: any, ctx: any) => any) => { handlers.set(event, callback); } },
  });
  const ctx = { ui: { confirm: () => { throw new Error('UI unavailable'); } }, isIdle: () => true };
  const tool = handlers.get('tool_call')!;
  expect(await tool({ toolName: 'ask_user_question' }, ctx)).toBeUndefined();
  const prefix = '[CINDY_TEXT_ONLY_INPUT]:runtime-token\n';
  expect(handlers.get('input')!({ source: 'rpc', text: '[CINDY_TEXT_ONLY_INPUT]:forged\nHello' }, ctx)).toBeUndefined();
  expect(await tool({ toolName: 'ask_user_question' }, ctx)).toBeUndefined();
  const images = [{ type: 'image', data: 'fixture' }];
  expect(handlers.get('input')!({ source: 'rpc', text: prefix + 'Hello', images }, ctx))
    .toEqual({ action: 'transform', text: 'Hello', images });
  const readsBefore = permissionReads;
  for (const toolName of ['read', 'bash', 'write', 'ask_user_question', 'cindy_mcp_call_tool', 'future_tool']) {
    expect(await tool({ toolName }, ctx)).toMatchObject({ block: true });
  }
  expect(permissionReads).toBe(readsBefore);
  expect(handlers.has('agent_end')).toBe(false); // Intermediate retry/compaction boundaries retain the policy.
  handlers.get('agent_settled')!({}, { ...ctx, isIdle: () => false });
  expect(await tool({ toolName: 'read' }, ctx)).toMatchObject({ block: true });
  // A failed/aborted welcome can omit agent_settled entirely.
  const input = handlers.get('input')!;
  for (const event of [
    { source: 'extension', text: 'Continue.' },
    { source: 'rpc', text: 'Continue.', streamingBehavior: 'steer' },
    { source: 'rpc', text: 'Continue.', streamingBehavior: 'followUp' },
  ]) {
    input(event, ctx);
    expect(await tool({ toolName: 'read' }, ctx)).toMatchObject({ block: true });
  }
  input({ source: 'rpc', text: 'Continue.' }, { ...ctx, isIdle: () => false });
  expect(await tool({ toolName: 'read' }, ctx)).toMatchObject({ block: true });
  expect(input({ source: 'rpc', text: 'New ordinary request.' }, ctx)).toBeUndefined();
  expect(await tool({ toolName: 'ask_user_question' }, ctx)).toBeUndefined();
  // A subsequent welcome still arms the policy; normal settlement still clears it.
  input({ source: 'rpc', text: prefix + 'Hello again.' }, ctx);
  expect(await tool({ toolName: 'read' }, ctx)).toMatchObject({ block: true });
  handlers.get('agent_settled')!({}, ctx);
  expect(await tool({ toolName: 'ask_user_question' }, ctx)).toBeUndefined();
});

// Performance contract, unit: execute the generated production bridge helper.
// A plugin-free native turn must not gain an awaited before_agent_start handler;
// the existing real-Pi request tests cannot observe native handler registration.
it('registers model routing only after the first selected RPC input', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('let textOnlyTurnActive = false');
  const end = source.indexOf('function currentPermissionState', start);
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const compiled = ts.transpileModule(source.slice(start, end)
    + '\nconst runtime = installRuntimeModelControl(pi);\ninstallTextOnlyTurnPolicy(pi, runtime.prepare);',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const physical = { provider: 'fixture', id: 'original' };
  const router = { provider: 'cindy-runtime-router', id: 'selected-task' };
  const setModel = vi.fn(async () => true);
  const registerVirtualModel = vi.fn();
  runInNewContext(compiled, { process: { env: { CINDY_PI_TURN_TOOL_POLICY: 'runtime-token' } },
    pi: { on: (name: string, handler: (event: any, ctx: any) => any) => handlers.set(name, handler),
      setModel, registerVirtualModel, setThinkingLevel: vi.fn() } });
  const input = handlers.get('input')!;
  const ctx = { isIdle: () => true, model: physical, modelRegistry: { find: () => router } };
  expect(input({ source: 'rpc', text: 'Ordinary input' }, ctx)).toBeUndefined();
  expect(handlers.has('before_agent_start')).toBe(false);
  expect(setModel).not.toHaveBeenCalled();
  expect(await input({ source: 'rpc', text: '[CINDY_MODEL_REQUEST]:runtime-token\nSelected input' }, ctx))
    .toEqual({ action: 'transform', text: 'Selected input', images: undefined });
  expect(setModel).toHaveBeenCalledWith(router);
  expect(registerVirtualModel).toHaveBeenCalledOnce();
  expect(handlers.has('before_agent_start')).toBe(false);
  await input({ source: 'rpc', text: 'Deselected input' }, { ...ctx, model: router });
  expect(setModel).toHaveBeenLastCalledWith(physical);
  setModel.mockClear();
  expect(input({ source: 'rpc', text: 'Next ordinary input' }, ctx)).toBeUndefined();
  expect(setModel).not.toHaveBeenCalled();
});

it('lets a shared user\'s Pi call only tools that Cindy extensions registered', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const gateStart = source.indexOf('function createCindyGuestToolGate');
  const gateEnd = source.indexOf('\nconst PERMISSION_TITLE', gateStart);
  const handlerStart = source.indexOf("  pi.on('tool_call', async");
  const handlerEnd = source.indexOf('\n  });', handlerStart) + '\n  });'.length;
  // 子代理扩展的工具名在生成时写进源码。
  expect(source).toContain('createCindyGuestToolGate(piApi, ["cindy_subagent"])');
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const registered: string[] = [];
  const api = {
    on: (event: string, callback: (event: any, ctx: any) => any) => { handlers.set(event, callback); },
    registerTool(tool: { name: string }) { registered.push(tool.name); },
    getActiveTools() { return ['read']; },
  };
  const compiled = ts.transpileModule(
    source.slice(gateStart, gateEnd)
      + '\nconst guestToolGate = createCindyGuestToolGate(api, ["cindy_subagent"]);\nconst pi = guestToolGate.pi;'
      + '\npi.registerTool({ name: "read" });\npi.registerTool({ name: "cindy_mcp_call_tool" });\nresult = pi.getActiveTools();\ngate = guestToolGate;\n'
      + source.slice(handlerStart, handlerEnd),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const sandbox: Record<string, unknown> = {
    api, result: undefined, gate: undefined, Proxy, Reflect,
    toolsDisabledForTurn: () => false,
    currentPermissionState: () => ({ reviewOnly: false, mode: 'bypassPermissions' }),
  };
  runInNewContext(compiled, sandbox);
  // 注册照常交给 Pi，其余 API 原样转发。
  expect(registered).toEqual(['read', 'cindy_mcp_call_tool']);
  expect(sandbox.result).toEqual(['read']);
  const tool = handlers.get('tool_call')!;
  const ctx = { ui: { confirm: async () => true }, isIdle: () => true };
  for (const toolName of ['powershell', 'codemode', 'tool_search', 'mcp__local__run', 'future_builtin', undefined]) {
    expect(await tool({ toolName, input: {} }, ctx)).toMatchObject({ block: true, reason: expect.stringMatching(/shared provider/) });
  }
  // Cindy 扩展注册的(含经 Pi 原名顶替的 read)与子代理工具放行，交给后面的权限门。
  const gate = sandbox.gate as { blocks: (toolName: unknown) => boolean };
  for (const toolName of ['read', 'cindy_mcp_call_tool', 'cindy_subagent']) expect(gate.blocks(toolName)).toBe(false);
  expect(gate.blocks('subagent')).toBe(true);
});

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
  const constantsStart = source.indexOf('const MANAGED_RG_PATH_ENV');
  const constantsEnd = source.indexOf('const PI_PACKAGE_MANAGEMENT_TITLE');
  const start = source.indexOf('const SECRET_ENV_NAMES');
  const end = source.indexOf('function managedRipgrepPath');
  if (constantsStart < 0 || constantsEnd <= constantsStart || start < 0 || end <= start) {
    throw new Error('bash isolation helper was not found');
  }
  const executableSource = [
    source.slice(constantsStart, constantsEnd),
    source.slice(start, end),
    '(globalThis as any).isolatedBashEnvironment = isolatedBashEnvironment;',
  ].join('\n');
  const compiled = ts.transpileModule(executableSource, {
    compilerOptions: {
      module: ts.ModuleKind.None,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const context: Record<string, unknown> = { path: pathImpl, process: { env: {} } };
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
  const context: Record<string, unknown> & { process: { env: Record<string, string | undefined> } } = {
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

function powerShellOverlayEnabled(platform: NodeJS.Platform, factory: unknown, guest = false): boolean {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('const createPowerShellTool =');
  const end = source.indexOf('// Cindy owns a separate Pi extension store.', start);
  if (start < 0 || end <= start) throw new Error('PowerShell overlay was not found');
  const condition = /^\s*if \((.*createPowerShellTool.*)\) \{$/m.exec(source.slice(start, end))?.[1];
  if (!condition) throw new Error('PowerShell overlay condition was not found');
  return Boolean(runInNewContext(condition, {
    createPowerShellTool: factory,
    process: { platform },
    guestToolGate: guest ? {} : null,
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

// #9705, unit: execute the generated settings snapshot and bash factory call.
// Existing timeout/environment tests never supplied native shell settings.
it.each([
  [{ shellPath: '/fixture/custom shell', shellCommandPrefix: ' export PROBE=ok\n' }, '/fixture/custom shell', ' export PROBE=ok\n'],
  [{ shellPath: '  ', shellCommandPrefix: 12 }, undefined, undefined],
  [{}, undefined, undefined],
  [null, undefined, undefined],
])('passes native shell configuration to the replacement bash factory: %j', (settings, shellPath, commandPrefix) => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const snapshotStart = source.indexOf('const initialNativeSettings =');
  const snapshotEnd = source.indexOf("pi.registerCommand('cindy-native-provider-refresh'", snapshotStart);
  const bashStart = source.indexOf('const bashTool = createBashTool(process.cwd(), {');
  const bashEnd = source.indexOf('var bashParameters = bashTool.parameters;', bashStart);
  const factory = vi.fn(() => ({}));
  const getSettings = vi.fn(() => { throw new Error('Action methods cannot be called during extension loading'); });
  runInNewContext(source.slice(snapshotStart, snapshotEnd) + source.slice(bashStart, bashEnd), {
    pi: { getSettings }, process: { env: { PI_CODING_AGENT_DIR: '/fixture' }, cwd: () => '/work' },
    path: { join: () => '/fixture/settings.json' }, readFileSync: () => JSON.stringify(settings),
    createBashTool: factory, bashPackageHome: '/isolated',
    isolatedBashEnvironment: (env: unknown) => env,
  });
  expect(getSettings).not.toHaveBeenCalled();
  expect(factory).toHaveBeenCalledWith('/work', expect.objectContaining({ exposeSessionEnvironment: false }));
  const options = (factory.mock.calls as unknown as Array<[string, Record<string, unknown>]>)[0][1];
  expect(options.shellPath).toBe(shellPath);
  expect(options.commandPrefix).toBe(commandPrefix);
});

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

function loadQuestionTool(): { execute: (...args: any[]) => Promise<any> } {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const start = source.indexOf('function registerCindyQuestionTool');
  const end = source.indexOf('export default async function cindyBridge');
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let tool: any;
  runInNewContext(compiled + '\nregisterCindyQuestionTool(pi);', {
    pi: { registerTool(value: any) { tool = value; } },
  });
  return tool;
}

function loadPackageTool(): { execute: (...args: any[]) => Promise<any> } {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const projectionStart = source.indexOf('const projectPiPackageCommandDiagnostic =');
  const projectionEnd = source.indexOf('// Pi 的模型鉴权', projectionStart);
  const start = source.indexOf('// Cindy owns a separate Pi extension store.');
  const end = source.indexOf('// ── 原生会话树桥', start);
  const compiled = ts.transpileModule(source.slice(projectionStart, projectionEnd) + source.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let tool: any;
  runInNewContext(compiled, {
    pi: { registerTool(value: any) { tool = value; } },
    piPackageManagementToken: 'x'.repeat(64),
    PI_PACKAGE_MANAGEMENT_TITLE: 'cindy:pi-package', MAX_PI_PACKAGE_SOURCE_LENGTH: 2048,
  });
  return tool;
}

describe('cindy-bridge extension source', () => {
  it.each(['failed', 'timed-out', 'unknown', 'cancelled'] as const)(
    'keeps %s diagnostics in the final Pi tool error and permits a later retry', async (outcome) => {
      const tool = loadPackageTool();
      const diagnostic = { phase: 'native-command', command: 'install', outcome, exitCode: null,
        reason: 'unknown', recovery: 'inspect-state-before-retry', stderr: 'fake-private-stderr' };
      let failed = true;
      const ctx = { ui: { input: async () => JSON.stringify(failed
        ? { ok: false, error: 'Safe failure',
            ...(outcome === 'cancelled' ? { cancelled: true } : {
              failureCode: 'native-command-failed', mayHaveChangedState: true, diagnostic,
              commandFailure: { phase: 'native-core', packagesUpdated: true, recovery: 'retry-core-only', stderr: 'fake-private-command' },
            }),
            argv: '--token=fake-private-argv',
          }
        : { ok: true, result: { changed: true, nativeCommandSucceeded: true, projectionUnavailable: true } }) } };
      const error = await tool.execute('pkg', { action: 'install', source: 'npm:sample' }, undefined, undefined, ctx)
        .catch((failure: Error) => failure);
      expect(error.message).toContain(outcome === 'cancelled' ? '"cancelled":true' : '"outcome":"' + outcome + '"');
      expect(error.message).not.toContain('fake-private');
      if (outcome !== 'cancelled') expect(error.message).toContain('"recovery":"retry-core-only"');
      failed = false;
      const result = await tool.execute('retry', { action: 'install', source: 'npm:sample' }, undefined, undefined, ctx);
      expect(result.content[0].text).toContain('"nativeCommandSucceeded":true');
      expect(result.details).toMatchObject({ changed: true, projectionUnavailable: true });
    },
  );

  it('preserves legacy package failure messages when the host sends no diagnostic', async () => {
    await expect(loadPackageTool().execute('pkg', { action: 'install', source: 'npm:sample' }, undefined, undefined, {
      ui: { input: async () => JSON.stringify({ ok: false, error: 'Legacy failure' }) },
    })).rejects.toThrow(/^Legacy failure$/);
  });

  it('keeps the question tool pending until the UI returns a real answer', async () => {
    const tool = loadQuestionTool();
    let answer!: (value: string) => void;
    let finished = false;
    const run = tool.execute('q', { questions: [{ question: 'Continue?', options: ['Yes', 'No'] }] }, undefined, undefined, {
      ui: { select: () => new Promise<string>((resolve) => { answer = resolve; }) },
    }).then((result) => { finished = true; return result; });
    await Promise.resolve();
    expect(finished).toBe(false);
    answer('No');
    expect((await run).details).toEqual({ answers: { 'Continue?': 'No' }, cancelled: false });
  });

  it('returns a typed answer outside the options as a real answer, not a cancel (#4273)', async () => {
    const tool = loadQuestionTool();
    const result = await tool.execute('q', {
      questions: [
        { question: 'Continue?', options: ['Yes', 'No'] },
        { question: 'Which color?', options: ['Red', 'Blue'] },
      ],
    }, undefined, undefined, {
      ui: { select: async (_title: string, options: string[]) => (options.includes('Yes') ? 'No' : 'teal') },
    });
    expect(result.details).toEqual({ answers: { 'Continue?': 'No', 'Which color?': 'teal' }, cancelled: false });
  });

  it('reports cancellation without fabricating a choice and validates all questions before showing UI', async () => {
    const tool = loadQuestionTool();
    const ctx = { ui: { input: async () => undefined } };
    expect((await tool.execute('q', { questions: [{ question: 'Name?' }] }, undefined, undefined, ctx)).details)
      .toEqual({ answers: {}, cancelled: true });
    await expect(tool.execute('q', { questions: [{ question: 'Name?' }, { question: 'Name?' }] }, undefined, undefined, ctx))
      .rejects.toThrow('distinct questions');
    await expect(tool.execute('q', { questions: [{ question: 'Name?' }] }, undefined, undefined, { hasUI: false }))
      .rejects.toThrow('unavailable');
  });

  it('adapts Astra API payloads without changing other models or subscription requests', () => {
    const start = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('function astraResponsesPayload(');
    const end = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('export default async function cindyBridge');
    const helpers = ts.transpileModule(CINDY_BRIDGE_EXTENSION_SOURCE.slice(start, end), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const adapt = new Function(`${helpers}; return astraResponsesPayload;`)();
    const original = {
      prompt_cache_retention: '24h',
      prompt_cache_options: { mode: 'explicit' },
      temperature: 0.5, top_p: 1, top_logprobs: 2,
      include: ['reasoning.encrypted_content', 'message.output_text.logprobs'],
      reasoning: { effort: 'none', summary: 'auto' },
      input: [{ role: 'user', content: 'hello' }],
    };
    const model = { id: 'gpt-6-astra', api: 'openai-responses' };
    expect(adapt(original, model)).toEqual({
      prompt_cache_options: { ttl: '30m', mode: 'explicit' },
      include: ['reasoning.encrypted_content'],
      reasoning: { effort: 'low', summary: 'auto' },
      input: original.input,
    });
    expect(original.reasoning.effort).toBe('none');
    expect(original.prompt_cache_retention).toBe('24h');
    expect(adapt({ reasoning: { effort: 'max' } }, model).reasoning.effort).toBe('max');
    expect(adapt(original, { ...model, id: 'gpt-5.5' })).toBeUndefined();
    expect(adapt(original, { ...model, api: 'openai-codex-responses' })).toBeUndefined();
  });

  it('executes the registered native provider request hook and preserves explicit ceilings', async () => {
    const helperStart = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('function reserveLargeCompletionHeadroom(');
    const helperEnd = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('function boundedChatToolIds(', helperStart);
    const hookStart = CINDY_BRIDGE_EXTENSION_SOURCE.lastIndexOf("pi.on('before_provider_request'");
    const hookEnd = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('  const mcpGateway', hookStart);
    const hook = CINDY_BRIDGE_EXTENSION_SOURCE.slice(hookStart, hookEnd);
    const compiled = ts.transpileModule(
      CINDY_BRIDGE_EXTENSION_SOURCE.slice(helperStart, helperEnd) + '\n' + hook,
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    let callback!: (event: any, ctx: any) => Promise<Record<string, unknown>>;
    const sandbox: any = {
      process: { env: {} },
      pi: { on: (name: string, handler: (event: any, ctx: any) => Promise<Record<string, unknown>>) => {
        if (name === 'before_provider_request') callback = handler;
      } },
      runtimeRequestModel: () => undefined,
      astraResponsesPayload: () => undefined,
      nativeFastPayload: async () => undefined,
      modelRequestControlActive: false,
      runtimeModelControl: async () => ({ request: undefined }),
      boundedChatToolIds: (payload: Record<string, unknown>) => payload,
      projectPiRequestDiagnostics: () => ({}),
      performance,
    };
    runInNewContext(compiled, sandbox);
    const payload = { max_tokens: 1_010_781, messages: [{ role: 'user', content: 'hello' }] };
    const model = { api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 1_048_576 };
    const ctx = (tokens: number | null) => ({
      model, getContextUsage: () => ({ contextWindow: model.contextWindow, tokens }), ui: { notify: vi.fn() },
    });
    // Old wire budgets from #9252 and Pi 1.5.2 budgets for the same estimates.
    for (const [estimate, actual, oldBudget, nativeBudget] of [
      [33_699, 39_671, 1_010_781, 1_009_822],
      [33_607, 39_948, 1_010_873, 1_009_927],
    ]) {
      for (const [field, budget] of [['max_tokens', oldBudget], ['max_completion_tokens', nativeBudget]] as const) {
        const request = { [field]: budget };
        const result = await callback({ payload: request }, ctx(estimate));
        expect(result[field]).toBe(model.contextWindow - estimate - 16_384);
        expect(actual + Number(result[field])).toBeLessThanOrEqual(model.contextWindow);
        expect(request[field]).toBe(budget);
      }
    }
    for (const field of ['max_tokens', 'max_completion_tokens']) {
      for (const budget of [65_536, 70_000, 384_000]) {
        const short = { [field]: budget };
        expect(await callback({ payload: short }, { ...ctx(100), model: { ...model, maxTokens: 384_000 } })).toBe(short);
      }
    }
    // The native 15% reserve already covers long inputs.
    const long = { max_tokens: 243_576 };
    expect(await callback({ payload: long }, ctx(700_000))).toBe(long);
    const legacy = await callback({ payload: { max_tokens: 344_480 } }, ctx(700_000));
    expect(730_000 + Number(legacy.max_tokens)).toBeLessThanOrEqual(model.contextWindow);
    expect(await callback({ payload }, ctx(null))).toBe(payload);
    expect(await callback({ payload }, { model })).toBe(payload);
    expect(await callback({ payload }, { ...ctx(33_699), getContextUsage: () => ({ tokens: 33_699, contextWindow: 128_000 }) })).toBe(payload);
    expect(await callback({ payload }, { ...ctx(33_699), model: { ...model, api: 'openai-responses' } })).toBe(payload);
    sandbox.modelRequestControlActive = true;
    sandbox.runtimeModelControl = vi.fn(async () => ({ request: { max_tokens: 70_000, messages: [{ role: 'user', content: 'short' }] } }));
    const explicit = await callback({ payload: { max_tokens: 384_000, messages: [{ role: 'user', content: 'short' }] } }, {
      model: { api: 'openai-completions', contextWindow: 1_048_576, maxTokens: 384_000 },
      ui: { notify: vi.fn() },
    });
    expect(explicit.max_tokens).toBe(70_000);
    expect(sandbox.runtimeModelControl).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      phase: 'payload', request: expect.objectContaining({ max_tokens: 384_000 }),
    }));
  });

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
      expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain(
        "if (credentialRead && permission.mode === 'bypassPermissions')",
      );
      expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
        "if (permission.mode === 'bypassPermissions' && !controlPlaneWrite) return;",
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
      const helperEnd = source.indexOf('const PROC_ENVIRON_READ_RE');
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
    expect(source).toContain('User denied this tool call via Cindy');
    expect(source).toContain('Cindy Auto-review denied this tool call');
    expect(source).toContain('Cindy could not approve this tool call');
  });

  it('returns the bounded Auto reason to Pi while retaining legacy denial decoding', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const fragment = source.slice(source.indexOf('const PERMISSION_ALLOW'), source.indexOf('const READONLY_BUILTINS'));
    const decode = runInNewContext(ts.transpile(fragment + '\npermissionDenialReason;', { target: ts.ScriptTarget.ES2022 })) as (value?: string) => string;
    expect(decode('auto-review-deny:Only inspect; do not deploy.')).toBe('Cindy Auto-review denied this tool call: Only inspect; do not deploy.');
    expect(decode('auto-review-deny')).toBe('Cindy Auto-review denied this tool call.');
    expect(decode('user-deny')).toBe('User denied this tool call via Cindy.');
    expect(decode('user-deny:Do not publish.')).toBe('User denied this tool call via Cindy: Do not publish.');
    expect(decode('system-deny:session_closed')).toBe('Cindy could not approve this tool call: session_closed');
    expect(decode('system-deny:interaction_timeout')).toBe(formatPermissionDenial('system', 'interaction_timeout'));
    expect(decode('system-deny:timeout')).toContain('the user did not reject it');
    expect(decode(undefined)).toBe('Cindy could not approve this tool call.');
    expect(decode('auto-review-deny:' + 'x'.repeat(500))).toBe('Cindy Auto-review denied this tool call: ' + 'x'.repeat(240));
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
    // 受邀者会话不注册：它在本机执行，设备托管没有对应的执行器。
    expect(powerShellOverlayEnabled('win32', () => undefined, true)).toBe(false);
  });

  it.each(['darwin', 'linux'] as const)(
    'does not register the native PowerShell overlay on %s',
    (platform) => {
      expect(powerShellOverlayEnabled(platform, () => undefined)).toBe(false);
    },
  );

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
    const handlerEnd = source.indexOf('// ── MCP 桥', handlerStart);
    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);

    expect(source).toContain("return toolName === 'bash' || toolName === 'powershell';");
    expect(handler).toContain('if (!isCindyShellTool(captureToolName)');
    expect(handler).toContain('TURN_CHANGE_CAPTURE_TITLE');
  });

  it('keeps generic MCP behind two tools and gives frequent Bot actions typed fast paths', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("const CINDY_MCP_LIST_TOOLS = 'cindy_mcp_list_tools'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("const CINDY_MCP_CALL_TOOL = 'cindy_mcp_call_tool'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain("'send_to_agent'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain("'start_session_task'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "const CINDY_CREATE_TEAMMATE_TOOL = 'create_teammate'",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "name: CINDY_CREATE_TEAMMATE_TOOL",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain("collaborate_with_bot");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).not.toContain(
      "enum: ['status', 'notify', 'call', 'reply', 'cancel']",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("const CINDY_BOT_MEMORY_TOOL = 'bot_memory'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('mcpGateway.register(pi, { botMemoryFacade: cfg.botMemoryFacade === true });');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("qualifiedName: 'mcp__' + serverName + '__' + toolName");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('private readonly disclosedSchemas');
    // Post-compaction amnesia drives voluntary re-inspection: the persisted
    // disclosure set is re-surfaced as a one-shot custom message on the first run
    // after each successful compaction, never as a per-run system-prompt edit.
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("pi.on?.('session_compact'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("pi.on?.('before_agent_start'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("customType: 'cindy-mcp-disclosure-state'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('disclosedKeysForPrompt');
    // 披露按 schema 指纹持有 + 自愈放行（2026-10-13 pi 升级后整片失效、模型反复
    // 撞墙后放弃的真机事故）；权限/采集分类只认“解析成功”，不再按披露状态。
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('private schemaFingerprint(');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('markSchemaDisclosed(call: ResolvedMcpGatewayCall)');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('gateway tool auto-disclosed on first call');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('const gatewayCall = resolvedGatewayCall;');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('mcpGateway.isSchemaDisclosed(gatewayCall)');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('permissionToolName = gatewayCall?.qualifiedName');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain('permissionInput = gatewayCall?.args');
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "qualifiedName: 'mcp__cindy_helper__' + name",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "qualifiedName: 'mcp__cindy_memory__call_tool'",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "this.botMemoryFacadeEnabled && serverName === 'cindy_memory'",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("name = 'memory_review'");
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain("name = 'memory_consolidate'");
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
      '$SHELL -c echo',
      'backup=$(mktemp -d); echo ready',
      '$(printf pi) install npm:context-mode',
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

  it.each([
    ['POSIX', path.posix, '/isolated/pi-home'],
    ['Windows', path.win32, 'D:\\isolated\\pi-home'],
  ] as const)('hides Fast preferences from %s shells without mutating the runtime', (_platform, pathImpl, home) => {
    const isolate = loadBashIsolationHelper(pathImpl);
    const runtimeEnv = {
      CINDY_PI_MODEL_REQUEST_PREFS_FILE: pathImpl.join(home, 'request-prefs.json'),
      CINDY_PI_FAST_MODELS: '[]',
      PATH: 'ordinary-shell-path',
      SHELL_CANARY: 'preserved',
    };
    const shellEnv = isolate(runtimeEnv, home);
    expect(shellEnv).not.toHaveProperty('CINDY_PI_MODEL_REQUEST_PREFS_FILE');
    expect(shellEnv).not.toHaveProperty('CINDY_PI_FAST_MODELS');
    expect(shellEnv).toMatchObject({
      PATH: runtimeEnv.PATH,
      SHELL_CANARY: runtimeEnv.SHELL_CANARY,
      PI_CODING_AGENT_DIR: home,
    });
    expect(runtimeEnv.CINDY_PI_MODEL_REQUEST_PREFS_FILE).toBe(
      pathImpl.join(home, 'request-prefs.json'),
    );
  });

  it('routes both Pi command names to the single host permission service', () => {
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "if (event.toolName === 'cindy_pi_extension' || event.toolName === 'cindy_pi_command') return;",
    );
    expect(CINDY_BRIDGE_EXTENSION_SOURCE).toContain(
      "if (permission.mode === 'bypassPermissions' && !controlPlaneWrite) return;",
    );
  });

  it('bubbles Extra Dirs writes and forces confirmation for agent-home writes', () => {
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    expect(source).not.toContain('Cindy extra reference directories are read-only.');
    expect(source).not.toContain('Cindy agent runtime directory is read-only.');
    expect(source).not.toContain('Cindy blocks reading credential or key paths, even with Full access.');
    expect(source).not.toContain('Cindy blocks reading process environment (/proc/*/environ), even with Full access.');
    expect(source).toContain('const controlPlaneWrite = Boolean(');
    expect(source).toContain('...(controlPlaneWrite ? { controlPlaneWrite: true } : {})');
    expect(source).toContain('resolvedWritePath: writeTargetResolved');
    // 设备托管会话改用任务所在电脑的真实工作目录作可写根(见 CINDY_HOSTED)，其余照旧。
    expect(source).toContain('resolvedWritableRoots: CINDY_HOSTED');
    expect(source).toContain(': resolveWritableRootsForHost(permission.writableRoots)');
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

it('re-surfaces the disclosure set once after compaction instead of editing every run prompt', () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
    createHash,
  };
  runInNewContext(compiled, context);
  const handlers = new Map<string, (event: any) => any>();
  const gateway = new context.Gateway();
  gateway.register({ registerTool: () => {}, on: (event: string, cb: (event: any) => any) => handlers.set(event, cb) });
  expect(handlers.has('session_compact')).toBe(true);
  expect(handlers.has('before_agent_start')).toBe(true);

  // No compaction yet: the run prompt stays untouched (zero per-run token cost).
  expect(handlers.get('before_agent_start')!({ systemPrompt: 'base' })).toBeUndefined();

  // A successful compaction arms exactly one reminder with the current keys.
  const client = { request: async () => ({ content: [] }) };
  const callTool = { name: 'call_tool', description: 'd', inputSchema: { type: 'object' } };
  const sendWorker = { name: 'send_to_worker', description: 'd', inputSchema: { type: 'object' } };
  gateway.add('cindy_memory', client, [callTool]);
  gateway.add('cindy_orca', client, [sendWorker]);
  gateway.disclosedSchemas.set('cindy_memory\u0000call_tool', gateway.schemaFingerprint(callTool));
  gateway.disclosedSchemas.set('cindy_orca\u0000send_to_worker', gateway.schemaFingerprint(sendWorker));
  handlers.get('session_compact')!({ reason: 'threshold' });
  const note = handlers.get('before_agent_start')!({ systemPrompt: 'base' });
  expect(note?.message?.customType).toBe('cindy-mcp-disclosure-state');
  expect(note?.message?.display).toBe(false);
  const text = note?.message?.content?.[0]?.text ?? '';
  expect(text).toContain('cindy_memory/call_tool');
  expect(text).toContain('cindy_orca/send_to_worker');
  // 压缩可能模糊参数细节：提醒软化为「参数记得就直接调，模糊了按需重查」，
  // 不再绝对化禁止重查（Greptile P2：否则模型只能猜参数或违背提醒）。
  expect(text).toContain('Call them directly while you still remember their parameter shapes');
  expect(text).toContain('re-inspect just the tools you need via cindy_mcp_list_tools instead of guessing');
  // One-shot: the second run after the same compaction stays clean.
  expect(handlers.get('before_agent_start')!({ systemPrompt: 'base' })).toBeUndefined();

  // A removed tool or a drifted schema must not be advertised as safe to call:
  // only keys whose tool still exists with a matching fingerprint are listed.
  gateway.disclosedSchemas.set('cindy_ghosts\u0000gone_tool', gateway.schemaFingerprint(callTool));
  gateway.disclosedSchemas.set('cindy_memory\u0000call_tool', 'stale-fingerprint');
  handlers.get('session_compact')!({ reason: 'manual' });
  const filtered = handlers.get('before_agent_start')!({ systemPrompt: 'base' });
  const filteredText = filtered?.message?.content?.[0]?.text ?? '';
  expect(filteredText).toContain('cindy_orca/send_to_worker');
  expect(filteredText).not.toContain('gone_tool');
  expect(filteredText).not.toContain('cindy_memory/call_tool');

  // An empty disclosure set consumes the flag without emitting an empty note.
  gateway.disclosedSchemas.clear();
  handlers.get('session_compact')!({ reason: 'manual' });
  expect(handlers.get('before_agent_start')!({ systemPrompt: 'base' })).toBeUndefined();
  expect(handlers.get('before_agent_start')!({ systemPrompt: 'base' })).toBeUndefined();
});

// Regression: optional questions need the same direct discoverability as sync questions.
// Unit: execute the production gateway and verify real MCP routing and permission identity.
it.each(['list_machines', 'ask_user_question_async', 'manage_user_questions'])('registers %s directly without MCP discovery', async (name) => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const calls: unknown[] = [];
  const client = { request: async (method: string, params: unknown, signal?: AbortSignal) => {
    calls.push({ method, params, signal });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  const withoutHost: any[] = [];
  gateway.add('cindy_helper', client, [{ name: 'list_tools', inputSchema: { type: 'object' } }, { name: 'call_tool', inputSchema: { type: 'object' } }]);
  gateway.register({ registerTool: (tool: unknown) => withoutHost.push(tool) });
  expect(withoutHost.map((tool) => tool.name)).not.toContain(name);

  const direct = new context.Gateway();
  direct.add('cindy_helper', client, [{ name, inputSchema: { type: 'object' } }]);
  const tools: any[] = [];
  direct.register({ registerTool: (tool: unknown) => tools.push(tool) });
  const tool = tools.find((item) => item.name === name);
  const args = name === 'ask_user_question_async' ? { questions: [{ question: 'Which scope?' }] } : {};
  await tool.execute('call-1', args, new AbortController().signal);
  expect(calls.at(-1)).toMatchObject({ method: 'tools/call', params: { name, arguments: args } });
  // Ask and Auto judge the real MCP identity, so this auto-approves like the same tool over MCP.
  expect(direct.resolveHookedCall(name, {}).qualifiedName).toBe('mcp__cindy_helper__' + name);
  expect(direct.resolveHookedCall('read', {})).toBeNull();
});

it('classifies MCP discovery errors by the registered server before matching the tool (#6926)', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
  };
  runInNewContext(compiled, context);

  const gateway = new context.Gateway();
  const client = {};
  gateway.add('demo', client, [{ name: 'inspect' }], 'Demo');
  gateway.add('one', client, [{ name: 'inspect' }], 'Shared');
  gateway.add('two', client, [{ name: 'inspect' }], 'Shared');
  gateway.add('cindy_memory', client, [{ name: 'call_tool' }]);
  gateway.setServerDisplayName('offline', 'Offline');
  gateway.markUnavailable('offline', 'Connection closed');
  let listTools!: (id: string, input: { server?: string; tool?: string }) => Promise<{ details: unknown }>;
  gateway.register({
    registerTool: (tool: { name: string; execute: typeof listTools }) => {
      if (tool.name === 'cindy_mcp_list_tools') listTools = tool.execute;
    },
  }, { botMemoryFacade: true });

  const discover = async (server: string, tool?: string) =>
    (await listTools('lookup', tool ? { server, tool } : { server })).details;
  const unknown = {
    ok: false,
    errorCode: 'UNKNOWN_SERVER',
    requested: 'missing',
    availableServers: ['Demo', 'Shared'],
    unavailableServers: [{ server: 'offline', reason: 'Connection closed' }],
  };
  expect(await discover('missing', 'inspect')).toEqual(unknown);
  expect(await discover('missing')).toEqual(unknown);
  expect(await discover('Offline', 'inspect')).toMatchObject({
    errorCode: 'SERVER_UNAVAILABLE', reason: 'Connection closed',
  });
  expect(await discover('Demo', 'missing')).toMatchObject({
    errorCode: 'UNKNOWN_TOOL', availableTools: ['inspect'],
  });
  expect(await discover('Shared', 'inspect')).toMatchObject({
    errorCode: 'AMBIGUOUS_SERVER', matchingServerIds: ['one', 'two'],
  });
  expect(await discover('demo', 'inspect')).toMatchObject({
    ok: true, tools: [{ server: 'Demo', serverId: 'demo', name: 'inspect', inputSchema: { type: 'object' } }],
  });
  expect(await discover('cindy_memory', 'call_tool')).toMatchObject({
    errorCode: 'UNKNOWN_TOOL', availableTools: [],
  });
  expect(await discover('cindy_memory')).toMatchObject({ errorCode: 'UNKNOWN_SERVER' });
});

it('routes Bot shortcuts through the scoped helper entry without exposing them to ordinary Pi tasks', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const calls: unknown[] = [];
  const client = { request: async (method: string, params: unknown, signal?: AbortSignal) => {
    calls.push({ method, params, signal });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_helper', client, [
    { name: 'list_tools', inputSchema: { type: 'object' } },
    { name: 'call_tool', inputSchema: { type: 'object' } },
  ]);
  const ordinary: any[] = [];
  gateway.register({ registerTool: (tool: unknown) => ordinary.push(tool) });
  expect(ordinary.map((tool) => tool.name)).toEqual(['cindy_mcp_list_tools', 'cindy_mcp_call_tool']);
  expect(gateway.resolveDirectHelperTool('list_agents', {})).toBeNull();

  const bot: any[] = [];
  gateway.register({ registerTool: (tool: unknown) => bot.push(tool) }, { botMemoryFacade: true });
  for (const name of ['list_agents', 'create_teammate', 'get_task_digest']) {
    const tool = bot.find((item) => item.name === name);
    expect(tool).toBeDefined();
    const args = name === 'get_task_digest' ? { session_id: 'laptop::session-1' } : name === 'list_agents' ? {}
      : { name: 'Writer', description: 'Novelist', identity_source: 'Write stories', welcome_message: 'Hello' };
    const resolved = gateway.resolveDirectHelperTool(name, args);
    expect(resolved.qualifiedName).toBe('mcp__cindy_helper__' + name);
    expect(resolved.args).toEqual(args); // Permission review retains the actual operation and arguments.
    const controller = new AbortController();
    await tool.execute('call-1', args, controller.signal);
    expect(calls.at(-1)).toEqual({ method: 'tools/call', params: { name: 'call_tool', arguments: { name, args } }, signal: controller.signal });
  }
});


describe('Pi same-turn library native mapping', () => {
  it('reads the current permission snapshot after a tool result and removes revoked roots', async () => {
    let permission: Record<string, unknown> = { mode: 'ask', readOnlyRoots: ['/library-a'], libraryRoot: '/library-a' };
    let callback: (event: unknown) => Promise<any>;
    const source = CINDY_BRIDGE_EXTENSION_SOURCE;
    const permissionStart = source.indexOf('function currentPermissionState()');
    const permissionEnd = source.indexOf('\n}\n', permissionStart) + 3;
    const hookStart = source.indexOf("  pi.on('tool_result', async (event: any) => {");
    const hookEnd = source.indexOf("\n  pi.on('tool_result', async (event: any, ctx: any)", hookStart);
    expect(permissionStart).toBeGreaterThan(-1);
    expect(hookStart).toBeGreaterThan(-1);
    const js = ts.transpileModule(source.slice(permissionStart, permissionEnd) + source.slice(hookStart, hookEnd), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    runInNewContext(js, {
      process: { env: { CINDY_PI_PERMISSION_FILE: '/synthetic/permission.json' } }, path,
      readFileSync: () => JSON.stringify(permission),
      pi: { on: (_event: string, cb: typeof callback) => { callback = cb; } },
    });
    const event = { content: [{ type: 'text', text: `library:assets/aa/${'a'.repeat(64)}/blob.png` }] };
    expect(JSON.stringify(await callback!(event))).toContain('/library-a');
    permission = { mode: 'ask', readOnlyRoots: ['/library-b'], libraryRoot: '/library-b' };
    const moved = JSON.stringify(await callback!(event));
    expect(moved).toContain('/library-b');
    expect(moved).not.toContain('/library-a');
    permission = { mode: 'ask', readOnlyRoots: ['/user'], libraryRoot: '/library-b' };
    const revoked = JSON.stringify(await callback!(event));
    expect(revoked).not.toContain('/library-b');
    expect(revoked).toContain('libraryRoot');
    expect(event.content).toHaveLength(1);
    permission = { ...permission, reviewOnly: true };
    expect(await callback!(event)).toBeUndefined();
  });
});


it.each(['openai-responses', 'openai-codex-responses'])('applies native Fast only to the exact declared %s connection and fails closed on invalid host replies', async api => {
  const start = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('async function nativeFastPayload(');
  const end = CINDY_BRIDGE_EXTENSION_SOURCE.indexOf('export default async function cindyBridge');
  const helpers = ts.transpileModule(CINDY_BRIDGE_EXTENSION_SOURCE.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  let reply: unknown = JSON.stringify({ fast: true });
  const adapt = new Function('process', `${helpers}; return nativeFastPayload;`)({ env: {
    CINDY_PI_FAST_MODELS: JSON.stringify([{ provider: 'relay-a', id: 'gpt-6-sol' }]),
  } });
  const ctx = { ui: { input: async () => { if (reply instanceof Error) throw reply; return reply; } } };
  const original = { model: 'gpt-6-sol', reasoning: { effort: 'high' }, input: 'hello' };
  const model = { provider: 'relay-a', id: 'gpt-6-sol', api };
  expect(await adapt(original, model, ctx)).toEqual({ ...original, service_tier: 'priority' });
  expect(await adapt(original, { ...model, provider: 'relay-b' }, ctx)).toBeUndefined();
  expect(await adapt(original, { ...model, id: 'other-model' }, ctx)).toBeUndefined();
  expect(await adapt(original, { ...model, api: 'anthropic-messages' }, ctx)).toBeUndefined();
  for (reply of [JSON.stringify({ fast: false }), JSON.stringify({ fast: 'true' }), undefined, 'broken', new Error('closed')]) {
    expect(await adapt({ ...original, service_tier: 'priority' }, model, ctx)).toEqual(original);
  }
  vi.useFakeTimers();
  try {
    const pending = adapt({ ...original, service_tier: 'priority' }, model,
      { ui: { input: () => new Promise(() => {}) } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual(original);
  } finally { vi.useRealTimers(); }
  expect(original).not.toHaveProperty('service_tier');
});

// PR #6025 回归: cindy_mcp_call_tool 的 args 必须对模型可选 (无参工具按其内层
// 空 schema 省略 args 时, 入口层不能再以 required 拦住)。同时锁死转发值: 省略
// args 时发给 MCP server 的 arguments 必须是 {} (recordInput 归一), 而不是
// undefined / 丢字段 — 否则 call_tool({name, args}) 入口 schema 又会 -32602。
it('lets cindy_mcp_call_tool omit args and forwards an empty object for no-parameter tools', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入（PR #6002 的 schemaFingerprint 走 sha256）。
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_memory', client, [
    { name: 'list_tools', inputSchema: { type: 'object' } },
    // 真实 cindy server 的 call_tool schema 形状指纹: name:string + args:object + required 含 name。
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  const ordinary: any[] = [];
  gateway.register({ registerTool: (tool: unknown) => ordinary.push(tool) });
  const callTool = ordinary.find((tool) => tool.name === 'cindy_mcp_call_tool');
  expect(callTool).toBeDefined();
  // 模型看到的契约: server/tool 必填, args 可选 (无参工具可省略)。
  expect(callTool.parameters.required).toEqual(['server', 'tool']);
  expect(callTool.parameters.required).not.toContain('args');
  // 披露门: 先按 schema 检视一次再调用 (与生产路径同序)。
  // 目标选 list_tools 而不是 call_tool: 后者的参数必填 name, 「完全省略 args」对它本来就
  // 是非法调用, 用它当夹具会把「省略即转发 {}」与「信封缺 name」两件事混在一起。
  await gateway.listResult({ server: 'cindy_memory', tool: 'list_tools' });
  await gateway.executeCall({ server: 'cindy_memory', tool: 'list_tools' });
  expect(requests).toHaveLength(1);
  expect(requests[0].method).toBe('tools/call');
  expect(requests[0].params).toEqual({ name: 'list_tools', arguments: {} });
  // 对照: 显式传 args 时仍原样转发 (既有行为不变), 含通用 call_tool 的 {name, args} 信封。
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.executeCall({ server: 'cindy_memory', tool: 'call_tool', args: { name: 'memory_list', args: {} } });
  expect(requests[1].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_list', args: {} },
  });
  // 2026-10-15 回归: args 就是「所选工具自己的参数」, 直调形态合法, schema 不得收窄;
  // 同时必须把通用 call_tool 的信封 {name, args} 作为提示属性挂在 args 上 —— 此前 args 是
  // 无声明字段的自由袋子, 模型看不到信封就把内层字段平铺进来并丢掉 name。
  const argsSchema = callTool.parameters.properties.args;
  expect(argsSchema.additionalProperties).toBe(true);
  expect(argsSchema.properties).toHaveProperty('name');
  expect(argsSchema.properties).toHaveProperty('args');
  expect(argsSchema.properties.name.type).toBeUndefined();
  expect(argsSchema.properties.args.type).toBeUndefined();
  // #10818 评审 P1: args 必须也收字符串形态 —— schema 只认 object 时, pi 的 schema 校验
  // 会先把「args 是一段 JSON 字符串」的调用判成非法并丢掉, 网关的解析分支永远走不到。
  expect(argsSchema.type).toEqual(['object', 'string']);
  // 顶层必须留开(#10818): 一旦 additionalProperties: false, pi-schema 会先把模型平铺出来
  // 的参数判成 unknown field 拒掉, 归位逻辑根本看不到它们, 用户要的操作被静默丢掉。
  expect(callTool.parameters.additionalProperties).toBe(true);
});

it('tells the model the call_tool envelope instead of forwarding a flattened envelope', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_memory', client, [
    { name: 'list_tools', inputSchema: { type: 'object' } },
    // 真实 cindy server 的 call_tool schema 形状指纹: name:string + args:object + required 含 name。
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 模型把内层参数平铺进 args、丢掉 name: 不触达 MCP, 一次说清正确形态。
  await expect(gateway.executeCall({
    server: 'cindy_memory',
    tool: 'call_tool',
    args: { filename: 'project_x.md' },
  })).rejects.toThrow(/envelope \{"name": <tool>, "args"/);
  expect(requests).toHaveLength(0);
  // 直调形态不受影响: 所选工具不是 call_tool 时, args 仍原样转发 (含参数名恰好叫 args/name)。
  gateway.add('cindy_workspace', client, [{ name: 'status', inputSchema: { type: 'object' } }]);
  await gateway.listResult({ server: 'cindy_workspace', tool: 'status' });
  await gateway.executeCall({ server: 'cindy_workspace', tool: 'status', args: { args: ['x'], name: 'y' } });
  expect(requests[0].params).toEqual({ name: 'status', arguments: { args: ['x'], name: 'y' } });
});

// #10818: 弱模型把工具参数平铺在网关调用的顶层(实测 MiniMax-M3.1 会把文档标识放进 args、
// 把行列坐标平铺在外层)。只取 args 的实现会把坐标静默丢掉 —— 表格类服务于是按缺省值
// 写回 A1 并返回成功, 链路看起来完全正常, 用户只会以为服务端忽略了参数。
it('folds top-level tool parameters into args instead of dropping them', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE[A1]' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string' }, sheet_id: { type: 'string' },
        row: { type: 'integer' }, col: { type: 'integer' },
      },
      required: ['file_id', 'row', 'col'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  // 模型把坐标平铺在顶层, 文档标识留在 args 里。
  const result = await gateway.executeCall({
    server: 'cindy_sheets', tool: 'set_cell', args: { file_id: 'doc-1' }, row: 10, col: 1,
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'set_cell', arguments: { file_id: 'doc-1', row: 10, col: 1 },
  });
  // 出站参数要看得见: 用户与模型据此才能分清「链路丢参」还是「服务端行为」。
  const note = (result.content as Array<{ text?: string }>).map(block => block.text ?? '').join('\n');
  expect(note).toContain('moved these top-level parameters into args before forwarding: row, col');
  expect(note).toContain('"row":10');
});

it('fails loudly when the arguments cannot be read at all instead of forwarding empty arguments', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE[A1]' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' }, row: { type: 'integer' }, col: { type: 'integer' } },
      required: ['file_id', 'row', 'col'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  // 参数放在一个读不出来的地方: 原样转发 {} 只会让服务端按缺省值静默兜底并返回成功。
  await expect(gateway.executeCall({ server: 'cindy_sheets', tool: 'set_cell', args: 'row=10' }))
    .rejects.toThrow(/args must be a JSON object/);
  expect(requests).toHaveLength(0);
});

// 测试价值(#10818 评审 P1/P2 两条新用例)
// - 生产入口与可观察结果: CindyMcpGateway.executeCall → 出站 tools/call 的 arguments,
//   以及工具结果里回显的 Forwarded arguments(用户与模型据此分清链路丢参与服务端行为)。
// - Bug／规则依据: #10818 评审 P1「显式 arguments: null 绕过校验」、P2「字符串解析不可见」。
// - 现有覆盖缺口: 相邻用例只覆盖「解析不了的字符串」与「平铺折回」, 「显式 null」与
//   「字符串解析成功」这两支没有用例(后者此前连正向断言都没有)。
// - 最小失败输入: {server, tool, arguments: null} / {args: null};
//   {server, tool, args: '{"file_id":"doc-1","row":10,"col":1}'}。
// - tier: unit — 进程内假 MCP client, 复用本文件既有 runInNewContext 夹具。
// - 实测耗时: 本文件单独运行 4.4s(含既有 64 条; 两条新用例合计约 0.1s)。
//
// #10818 评审 P1: 显式传 null 与「没传这个键」不是一回事。null 是模型给了一个用不了的
// 形态 —— 原样转发 {} 只会让服务端按缺省值兜底并返回成功(表格类服务写回 A1),
// 用户与模型都以为操作生效了。args 与 arguments 两个别名都要判为 malformed。
it('rejects an explicitly null argument instead of forwarding empty arguments', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE[A1]' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' }, row: { type: 'integer' }, col: { type: 'integer' } },
      required: ['file_id', 'row', 'col'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  for (const key of ['args', 'arguments']) {
    await expect(gateway.executeCall({ server: 'cindy_sheets', tool: 'set_cell', [key]: null }))
      .rejects.toThrow(/args must be a JSON object/);
  }
  // 一次都不许发出去: 发出去就是服务端按缺省值执行并返回成功。
  expect(requests).toHaveLength(0);
  // 「没传这个键」仍然合法: 无参工具照常转发空对象。
  await gateway.executeCall({ server: 'cindy_sheets', tool: 'set_cell', args: { file_id: 'doc-1', row: 10, col: 1 } });
  expect(requests).toHaveLength(1);
});

// #10818 评审 P2: 「args 是一段 JSON 字符串」也是一种归一化动作 —— 参数确实被改写成了
// 对象转发出去, 用户与模型必须看得见真正发出去的那一份, 否则「参数没生效」时无从对照。
it('parses a JSON string argument and echoes the forwarded arguments', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE[A1]' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' }, row: { type: 'integer' }, col: { type: 'integer' } },
      required: ['file_id', 'row', 'col'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  const result = await gateway.executeCall({
    server: 'cindy_sheets', tool: 'set_cell', args: '{"file_id":"doc-1","row":10,"col":1}',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'set_cell', arguments: { file_id: 'doc-1', row: 10, col: 1 },
  });
  const note = (result.content as Array<{ text?: string }>).map(block => block.text ?? '').join('\n');
  expect(note).toContain('parsed the JSON string in args');
  expect(note).toContain('"row":10');
});

it('repairs a flattened plugin parameter instead of rejecting the call', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'CALENDARS[primary]' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy', client, [{
    name: 'ghost_info',
    inputSchema: {
      type: 'object', properties: { ghost_id: { type: 'string' } }, required: ['ghost_id'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy', tool: 'ghost_info' });
  // 模型把 ghost_id 平铺在顶层: 归位后照常调用, 而不是报「缺 args.ghost_id」。
  await gateway.executeCall({ server: 'cindy', tool: 'ghost_info', ghost_id: 'calendar' });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({ name: 'ghost_info', arguments: { ghost_id: 'calendar' } });
});

// 评审 P2(信封被平铺): 弱模型把通用 call_tool 的信封两个字段平铺到顶层 ——
// {server, tool, name: <内层工具>, args: <内层参数>}。归位时把顶层 name 折进参数容器,
// 信封的 args 层就没了: 服务端收到的不是 {name, args}, 而是 {<内层参数>, name},
// 内层工具按空参数被调用。
it('rebuilds a flattened call_tool envelope instead of folding the inner name into the parameters', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_memory', client, [
    // 真实 cindy server 的 call_tool schema 形状指纹: name:string + args:object + required 含 name。
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P2(动态参数被丢): schema 明确放开 additionalProperties 或用 patternProperties 收了
// 某个前缀时, 顶层那个键是服务端认的参数 —— 不转发它等于又丢一次参数。
// 但 schema 没表态时仍不转发(宁漏不误转), 只是记进回执让用户看得见。
it('forwards top-level keys the tool schema explicitly accepts instead of dropping them', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE[A1]' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' }, row: { type: 'integer' } },
      required: ['file_id'],
      additionalProperties: true,
    },
  }]);
  gateway.add('cindy_extras', client, [{
    name: 'tag',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
      patternProperties: { '^x_': { type: 'string' } },
    },
  }]);
  gateway.add('cindy_strict', client, [{
    name: 'write',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  await gateway.listResult({ server: 'cindy_extras', tool: 'tag' });
  await gateway.listResult({ server: 'cindy_strict', tool: 'write' });
  await gateway.executeCall({ server: 'cindy_sheets', tool: 'set_cell', args: { file_id: 'doc-1' }, note: 'keep me' });
  expect(requests[0].params).toEqual({ name: 'set_cell', arguments: { file_id: 'doc-1', note: 'keep me' } });
  await gateway.executeCall({ server: 'cindy_extras', tool: 'tag', args: { file_id: 'doc-1' }, x_note: 'keep me too' });
  expect(requests[1].params).toEqual({ name: 'tag', arguments: { file_id: 'doc-1', x_note: 'keep me too' } });
  // schema 没表态的键仍然不转发, 但要出现在回执里(用户看得见没被转的参数)。
  const strict = await gateway.executeCall({ server: 'cindy_strict', tool: 'write', args: { file_id: 'doc-1' }, note: 'not declared' });
  expect(requests[2].params).toEqual({ name: 'write', arguments: { file_id: 'doc-1' } });
  const note = (strict.content as Array<{ text?: string }>).map(block => block.text ?? '').join('\n');
  expect(note).toContain('were not forwarded because the tool schema does not declare them: note');
});

// 评审 P2(组合 schema 放过必填项): 组合 schema(allOf/anyOf/oneOf/$ref)里藏着的必填项
// 判定不了, 可以不拦; 但根层的 required 是明确的, 缺了就不该发出去 ——
// 旧实现会拦, 现在这条调用会一路触达审批与服务端。
it('still enforces the root required of a schema that also uses a combinator', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy', client, [{
    name: 'ghost_call',
    inputSchema: {
      type: 'object',
      properties: { ghost_id: { type: 'string' }, scope: { type: 'string' } },
      required: ['ghost_id'],
      allOf: [{ properties: { scope: { type: 'string' } } }],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy', tool: 'ghost_call' });
  await expect(gateway.executeCall({ server: 'cindy', tool: 'ghost_call', args: {} }))
    .rejects.toThrow(/missing args.ghost_id/);
  expect(requests).toHaveLength(0);
  await gateway.executeCall({ server: 'cindy', tool: 'ghost_call', args: { ghost_id: 'calendar' } });
  expect(requests).toHaveLength(1);
});

// 评审 P2(失败回执看不到出站参数): 服务端拒收时最需要核对真正发出去的那一份 ——
// 参数最可能有问题的场景反而看不见「Forwarded arguments」。
it('echoes the forwarded arguments when the server rejects the call', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const client = { request: async () => { throw new Error('invalid params: missing field row'); } };
  const gateway = new context.Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' }, row: { type: 'integer' } },
      required: ['file_id', 'row'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  await expect(gateway.executeCall({
    server: 'cindy_sheets', tool: 'set_cell', args: { file_id: 'doc-1' }, row: 10,
  })).rejects.toThrow(/Forwarded arguments: \{"file_id":"doc-1","row":10\}/);
});

/** 新增网关用例用到的最小网关表面(类是从源码片段编译出来的, 没有类型)。 */
interface GatewayHarness {
  add(serverName: string, client: unknown, tools: Array<Record<string, unknown>>): void;
  register(api: { registerTool: (tool: unknown) => unknown }): void;
  listResult(input: unknown): Promise<unknown>;
  executeCall(input: unknown): Promise<{ content: Array<{ text?: string }> }>;
}

/** 网关片段只编译一次(文件级 fixture); 每个用例仍各自跑在新的上下文里, 网关实例互不相干。 */
let gatewaySliceCompiled: string | undefined;

/** 编译网关片段(CINDY_MCP_LIST_TOOLS…connectServer), 在独立上下文里取出网关类。 */
function loadGatewayHarness(): { Gateway: new () => GatewayHarness } {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  gatewaySliceCompiled ??= ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: {
    createHash: typeof createHash;
    recordInput: (value: unknown) => unknown;
    mcpContentToPi: (content: unknown) => unknown;
    Gateway?: new () => GatewayHarness;
  } = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(gatewaySliceCompiled, context);
  if (!context.Gateway) throw new Error('gateway class was not exported by the compiled bridge slice');
  return { Gateway: context.Gateway };
}

// 评审 P1(两层 name 被压成一层): 平铺信封重建用「args 容器里有 name 就不重建」判定模型给的是
// 完整信封 —— 但内层工具自己就常有 name 参数(memory_write / schedule_create)。规范调用
// {name: 'memory_write', args: {name: 'architecture', type: 'project'}} 于是被当成完整信封:
// 顶层的内层工具名被丢掉, 服务端拿 {name: 'architecture', type} 当信封, 内层工具查无此名
// (UNKNOWN_TOOL), 或者恰好撞上别的内层工具名而调错工具。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 a24df58791 的 P1;内层 name 参数见 lizi-mcps scheduler/create.ts、
//   memory/write.ts。
// - 覆盖缺口:上一轮的重建用例只盖了「args 里没有 name」的内层工具。
// - 最小失败输入:信封形状工具 + 顶层 name + args 里带 name。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('keeps both name layers when the flattened inner tool has a name parameter of its own', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  const envelopeSchema = { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } } };
  gateway.add('cindy_memory', client, [
    { name: 'call_tool', inputSchema: { ...envelopeSchema, required: ['name'] } },
    // 内层工具在本地工具表里, 自己也声明 name + args 参数: 与双包同形, 双包裁决按它的 schema 放行。
    { name: 'run', inputSchema: { ...envelopeSchema, required: ['name', 'args'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 记忆名(内层工具自己的 name 参数)与内层工具名(信封层)各占一层。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { name: 'architecture', type: 'project' },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool', arguments: { name: 'memory_write', args: { name: 'architecture', type: 'project' } },
  });
  // 顶层的内层工具名与 args 里的不一致: 两层都保留, 交给下游的双包裁决按内层 schema 判。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'run', args: { name: 'target', args: { cwd: '/work' } },
  });
  expect(requests[1].params).toEqual({
    name: 'call_tool', arguments: { name: 'run', args: { name: 'target', args: { cwd: '/work' } } },
  });
  // 同一个内层工具名写了两遍(顶层 + args 里的信封), 且内层工具(memory_write)不在本地工具表里:
  // 剥不剥这一层要按服务端那份 schema 定, 网关会代拉一次内层列表 —— 这个假 client 连内层列表
  // 都给不出(不是合法 JSON), 代拉之后仍判不了就不再照旧剥一层: 两种读法发出去的层数不同,
  // 拒收并指路(Codex P1 on #10908 第 14 轮)。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { name: 'memory_write', args: { type: 'project' } },
  })).rejects.toThrow(/Keep exactly one level/);
  // 顶层填的是入口工具名(call_tool): 容器里的 name('memory_write')是内层工具自己的参数,
  // 不是重复信封 —— 判不出来就拒收(两种读法发出去的层数不同, 不猜)。与撞名同一处理
  // (Codex P1 on #10908 第 16 轮)。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'call_tool', args: { name: 'memory_write', args: { type: 'project' } },
  })).rejects.toThrow(/Keep exactly one level/);
  // 两种「判不了」的形状各发过一次代拉(失败不缓存, 同一 server 各只发一次)。
  expect(requests.filter(r => (r.params as { name?: unknown } | undefined)?.name === 'list_tools').length).toBeGreaterThanOrEqual(1);
});

// 评审 P1(服务端正则卡死 Pi 进程): patternProperties 的模式来自服务端、键来自模型, 两头都不受
// Cindy 控制, 而归一化在权限与执行两条路径上同步跑它。服务端给一个灾难性回溯的模式、模型给一个
// 长 matching prefix 的键, Node 事件循环就被卡住 —— 实测 ^(a+)+$ 配 30 个 a 加 ! 要 7 秒多(每多一个
// 字符翻一倍); 有界量词同样会爆: (a?){200}$ 配 5 个字符, 8 秒都跑不完。只跑「回溯组合数有上界」的
// 模式, 其余不跑; 但那个键可能是声明过的动态参数, 判不了就照常转发(评审 P1, codex 对
// af161e62aa: 判不了按没声明处理会把真实声明的参数丢掉), 只在回执里说明。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 在这种 schema 下仍即时返回; 那条模式
//   不跑, 键照常转发(记进回执的「已折进 args」), 同一 schema 里的普通模式照常生效。
// - Bug 依据:codex 对 a24df58791 的 P1;修复前实测同一输入卡住 7 秒以上(超过用例 5 秒超时)。
// - 覆盖缺口:上一轮只盖了良性模式(^x_)的转发。
// - 最小失败输入:patternProperties {'^(a+)+$': …} + 顶层键 'a'.repeat(30) + '!'。
// - tier:unit;耗时上限 1 秒比修复前实测低 7 倍以上(且修复前先撞 5 秒超时), 比修复后高三个数量级。
it('does not run a catastrophic server-supplied pattern against a model-supplied key', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_extras', client, [{
    name: 'tag',
    inputSchema: {
      type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'],
      patternProperties: {
        '^(a+)+$': { type: 'string' },
        '(a?){200}$': { type: 'string' },
        '^x_[a-z0-9]+$': { type: 'string' },
      },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_extras', tool: 'tag' });
  const probes = [
    // 无界量词套无界量词。
    { key: 'a'.repeat(30) + '!', forwarded: { x_note: 'keep me' } },
    // 有界量词 + 能空匹配的体: 轮数不受键长限制, 按键长估轮数会漏掉这一种。
    { key: 'a'.repeat(4) + '!', forwarded: {} },
  ];
  for (const [index, probe] of probes.entries()) {
    const started = performance.now();
    const result = await gateway.executeCall({
      server: 'cindy_extras', tool: 'tag', args: { file_id: 'doc-1' }, [probe.key]: 'never evaluated', ...probe.forwarded,
    });
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(1000);
    // 那两条模式判不了 → 键可能命中声明: 不跑正则, 但照常折进 args 转发。
    expect(requests[index].params).toEqual({
      name: 'tag', arguments: { file_id: 'doc-1', [probe.key]: 'never evaluated', ...probe.forwarded },
    });
    const note = result.content.map(block => block.text ?? '').join('\n');
    expect(note).toContain('Cindy moved these top-level parameters into args before forwarding: '
      + [probe.key, ...Object.keys(probe.forwarded)].join(', '));
  }
  expect(requests).toHaveLength(probes.length);
});

// 评审 P1(组合 schema 里声明的参数被丢): 参数名收集只读根层 properties。第三方
// schema 用 allOf / anyOf 分支或文档内 $ref 声明参数时(根层 properties.file_id +
// allOf[0].properties.row), declared 只有 file_id; foldAll 于是为 false, 平铺的 row 被记成
// unmapped 不转发 —— schema 明确声明过的参数照丢。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 a24df58791 的 P1。
// - 覆盖缺口:上一轮的组合 schema 用例只盖了根层 required 的校验, 没盖参数名的收集。
// - 最小失败输入:properties.file_id + allOf[0].properties.row + 顶层 row。
// - tier:unit;循环 $ref 与超深 allOf 链必须在预算内返回(遍历有节点数与深度上限)。
it('folds top-level keys that a composed schema declares (allOf / anyOf / local $ref)', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE[A1]' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_sheets', client, [
    {
      name: 'set_cell',
      inputSchema: {
        type: 'object', properties: { file_id: { type: 'string' } }, required: ['file_id'],
        allOf: [{ properties: { row: { type: 'integer' } } }, { $ref: '#/$defs/ColInput' }],
        $defs: { ColInput: { properties: { col: { type: 'integer' } } } },
      },
    },
    {
      name: 'read_range',
      inputSchema: {
        type: 'object', properties: { file_id: { type: 'string' } },
        anyOf: [{ properties: { sheet: { type: 'string' } } }, { properties: { range: { type: 'string' } } }],
      },
    },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'read_range' });
  await gateway.executeCall({
    server: 'cindy_sheets', tool: 'set_cell', args: { file_id: 'doc-1' }, row: 10, col: 2,
  });
  expect(requests[0].params).toEqual({ name: 'set_cell', arguments: { file_id: 'doc-1', row: 10, col: 2 } });
  await gateway.executeCall({ server: 'cindy_sheets', tool: 'read_range', args: { file_id: 'doc-1' }, range: 'A1:B2' });
  expect(requests[1].params).toEqual({ name: 'read_range', arguments: { file_id: 'doc-1', range: 'A1:B2' } });
  // 循环引用的 $ref 只走一次; 深度超过预算时遍历被截断 —— 截断意味着「声明面不完整」,
  // 不能证明 deep 没被声明, 于是按「不丢参数」转发它(服务端据此报校验错误, 看得见),
  // 而不是静默丢掉让服务端按缺省值写。两边都要即时返回。
  // (节点数预算是同一道闸: 分支多到超出预算时同样停在那里, 不再展开。)
  let chain: Record<string, unknown> = { properties: { deep: { type: 'integer' } } };
  for (let depth = 0; depth < 400; depth++) chain = { allOf: [chain] };
  gateway.add('cindy_graph', client, [{
    name: 'node',
    inputSchema: {
      type: 'object', properties: { id: { type: 'string' } },
      $defs: { Node: { properties: { label: { type: 'string' } }, allOf: [{ $ref: '#/$defs/Node' }] } },
      allOf: [{ $ref: '#/$defs/Node' }, chain],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_graph', tool: 'node' });
  const started = performance.now();
  await gateway.executeCall({ server: 'cindy_graph', tool: 'node', args: { id: 'n1' }, label: 'root', deep: 9 });
  expect(performance.now() - started).toBeLessThan(1000);
  expect(requests[2].params).toEqual({ name: 'node', arguments: { id: 'n1', label: 'root', deep: 9 } });
});

// 评审 P1 的收尾(参数名改成走组合遍历之后): 「根层只有 $ref、声明在被引用文档里」的 schema,
// 参数名从 $defs 里收了, 额外字段的表态也必须从同一处收 —— 只把 additionalProperties 留在
// 根层看的话, 这类 schema 的「允许额外字段」会被漏成「不允许」, 模型给的额外参数又照丢。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 a24df58791 的 P1(组合 schema 的声明被忽略)收尾后的半懂不懂。
// - 覆盖缺口:组合用例只盖了「声明参数名」, 没盖「组合里放开额外字段」。
// - 最小失败输入:inputSchema = {$ref:'#/$defs/Input', $defs:{Input:{properties:{id}, additionalProperties:true}}} + 顶层 extra。
// - tier:unit。
it('forwards extra keys that a referenced schema definition explicitly allows', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_meta', client, [{
    name: 'patch',
    inputSchema: {
      $ref: '#/$defs/Input',
      $defs: {
        Input: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: true },
      },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_meta', tool: 'patch' });
  await gateway.executeCall({ server: 'cindy_meta', tool: 'patch', args: { id: 'x-1' }, extra: 'keep' });
  expect(requests[0].params).toEqual({ name: 'patch', arguments: { id: 'x-1', extra: 'keep' } });
});

// 评审 P1(模式条数封顶后把剩下声明当成未声明静默丢掉): 收集 patternProperties 时,
// 命中 SCHEMA_PATTERN_MAX_COUNT 条数上限并提前 break 后, surface.truncated 必须标为 true;
// 否则第 17+ 条模式对应的参数会被当成 unmapped 静默丢掉, 违背「声明面不完整时不丢参数」。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数 + 单次调用耗时。
// - Bug 依据:codex 对 71d60521a1 的 P1。
// - 覆盖缺口:上一轮只断言「封顶后不再匹配第 20 条」, 反把真实声明的参数丢掉了。
// - 最小失败输入:patternProperties 有 20 条, 模型传入命中第 20 条模式的 p19。
// - tier:unit。
it('stops examining patternProperties after the count cap and preserves parameters as incomplete', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const patternProperties: Record<string, unknown> = {};
  for (let index = 0; index < 20; index++) patternProperties[`^p${index}$`] = { type: 'string' };
  const gateway = new Gateway();
  gateway.add('cindy_patterns', client, [{
    name: 'tag',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      patternProperties,
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_patterns', tool: 'tag' });
  const started = performance.now();
  const result = await gateway.executeCall({
    server: 'cindy_patterns',
    tool: 'tag',
    args: { file_id: 'doc-1' },
    p19: 'late pattern',
    extra_after_cap: 'kept because truncated',
  });
  expect(performance.now() - started).toBeLessThan(1000);
  // 命中 16 条封顶后不再编译后续模式, 且 surface.truncated = true 使整份声明面按不完整处理:
  // p19 与封顶后的键一并保留转发(即使 extra_after_cap 也不匹配任何 ^p\d+$), 证明确实在 16 条处截断。
  expect(requests[0].params).toEqual({
    name: 'tag',
    arguments: { file_id: 'doc-1', p19: 'late pattern', extra_after_cap: 'kept because truncated' },
  });
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Cindy moved these top-level parameters into args before forwarding: p19, extra_after_cap.');
});

// 评审 P1(单条都过关、合起来仍可能拖住同步路径): 每条模式的回溯组合数各自都有上界,
// 一轮里所有模式的**总和**也必须有上界 —— 否则服务端给十几条「接近预算」的模式, 一次调用
// 就能把权限与执行两条同步路径拖住。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数 + 单次调用耗时。
// - Bug 依据:codex 对 8d212dd4cf 的 P1。
// - 覆盖缺口:上一轮只钉了「单条模式的预算」, 没钉「一轮里所有模式的总量」。
// - 最小失败输入:7 条估算各约 3.3 万步的模式, 第 7 条命中模型给的键。
// - tier:unit。
it('caps the total pattern work of one call, not only each pattern', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const patternProperties: Record<string, unknown> = {};
  for (const letter of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) {
    patternProperties[`^(${letter}{1,8}){1,4}$`] = { type: 'string' };
  }
  const gateway = new Gateway();
  gateway.add('cindy_patterns', client, [{
    name: 'tag',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      patternProperties,
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_patterns', tool: 'tag' });
  const started = performance.now();
  const result = await gateway.executeCall({
    server: 'cindy_patterns', tool: 'tag', args: { file_id: 'doc-1' }, gggggggg: 'past the total budget',
  });
  expect(performance.now() - started).toBeLessThan(1000);
  // 前 6 条的估算合计已接近单条预算, 第 7 条不再看 → 这个键可能正是它声明的: 不跑正则, 照常转发。
  expect(requests[0].params).toEqual({ name: 'tag', arguments: { file_id: 'doc-1', gggggggg: 'past the total budget' } });
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Cindy moved these top-level parameters into args before forwarding: gggggggg');
});

// 评审 P1(多键未共享模式预算): 4 条各约 3.3 万步的模式对单个 8 字符键只有 ~13.1 万步(低于 20 万上限),
// 若每个顶层键各自重置预算, 模型传入多个顶层键就能把同步路径的总步数乘以键数。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数 + 单次调用耗时。
// - Bug 依据:codex 对 71d60521a1 的 P1。
// - 覆盖缺口:上一轮只传了一个顶层键 gggggggg, 没测多键跨键共享同一份单次调用预算。
// - 最小失败输入:4 条约 3.3 万步的模式 + 两个 8 字符顶层键, 第二个键命中第 4 条模式。
// - tier:unit。
it('caps the total pattern work across multiple top-level keys in one call', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const patternProperties: Record<string, unknown> = {};
  for (const letter of ['a', 'b', 'c', 'd']) {
    patternProperties[`^(${letter}{1,8}){1,4}$`] = { type: 'string' };
  }
  const gateway = new Gateway();
  gateway.add('cindy_patterns', client, [{
    name: 'tag',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      patternProperties,
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_patterns', tool: 'tag' });
  const started = performance.now();
  const result = await gateway.executeCall({
    server: 'cindy_patterns',
    tool: 'tag',
    args: { file_id: 'doc-1' },
    x1234567: 'consumes ~131k across 4 patterns',
    dddddddd: 'past remaining shared budget',
  });
  expect(performance.now() - started).toBeLessThan(1000);
  // 第一个键把 4 条模式都跑完了(共 ~13.1 万步), 没命中 → schema 明确不收, 不转发。
  // 第二个键轮到第 3 条时超出剩余预算: 第 4 条(恰好命中 dddddddd)没跑成 → 判不了, 照常转发。
  expect(requests[0].params).toEqual({ name: 'tag', arguments: { file_id: 'doc-1', dddddddd: 'past remaining shared budget' } });
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('were not forwarded because the tool schema does not declare them: x1234567');
  expect(note).toContain('Cindy moved these top-level parameters into args before forwarding: dddddddd');
});

// 评审 P2(信封藏在组合声明后面): 判据只看根层 —— 根层 $ref 指向一份带 properties 与
// required 的定义时, 判不出这是 {name, args} 信封。平铺的 {name, args} 于是被当成普通参数:
// 顶层 name 折进参数容器, 信封的 args 层消失, 内层工具被按空参数调用; 执行前的信封检查
// 也一并放行。判据要在每个走到的节点上各判一次。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 8d212dd4cf 的 P2。
// - 覆盖缺口:信封用例只盖了「信封声明在根层」。
// - 最小失败输入:inputSchema = {$ref:'#/$defs/Envelope', $defs:{Envelope:{properties:{name,args}, required:['name']}}}。
// - tier:unit。
it('rebuilds the envelope when the envelope schema is declared behind a local ref', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'WROTE' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      $ref: '#/$defs/Envelope',
      $defs: {
        Envelope: {
          type: 'object',
          properties: { name: { type: 'string' }, args: { type: 'object' } },
          required: ['name'],
        },
      },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P2(条件分支里的声明被丢): 参数名只收 allOf/anyOf/oneOf 与 $ref —— 只在
// if/then/else 或 dependentSchemas 里声明的参数不在声明面里, 平铺过来就被记成未映射丢掉,
// 服务端按缺省坐标执行。条件与依赖分支同样要走那趟有预算的遍历。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 8d212dd4cf 的 P2。
// - 覆盖缺口:组合用例只盖了 allOf/anyOf/oneOf/$ref。
// - 最小失败输入:根层 properties.file_id + then.properties.row, 顶层 row。
// - tier:unit。
it('folds top-level keys declared in conditional and dependent schema branches', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_grid', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
      if: { properties: { mode: { const: 'grid' } } },
      then: { properties: { row: { type: 'integer' }, col: { type: 'integer' } } },
      else: { properties: { range: { type: 'string' } } },
      dependentSchemas: { file_id: { properties: { sheet_id: { type: 'string' } } } },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_grid', tool: 'set_cell' });
  await gateway.executeCall({
    server: 'cindy_grid', tool: 'set_cell', args: { file_id: 'doc-1' }, row: 10, col: 2, sheet_id: 'sheet-1',
  });
  expect(requests[0].params).toEqual({
    name: 'set_cell',
    arguments: { file_id: 'doc-1', row: 10, col: 2, sheet_id: 'sheet-1' },
  });
});

// 评审 P1(遗漏 draft-07 dependencies): 旧版 JSON Schema 使用 dependencies 声明依赖子 schema
// (而不是 2020-12 的 dependentSchemas); 只走 dependentSchemas 会把仅出现在 dependencies
// 子 schema 里的合法参数判成未声明并丢掉。同一个 dependencies 里还可以混着数组形态的属性依赖
// (dependencies.tag = ['file_id']): 它不是子 schema, 不能当 schema 去走(被它点名的字段算声明过,
// 见「only lists in required or property dependencies」那条用例)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 71d60521a1 的 P1。
// - 覆盖缺口:上一轮只测了 dependentSchemas, 未覆盖 draft-07 dependencies。
// - 最小失败输入:schema 用 dependencies.file_id 声明 sheet_id, 调用把 sheet_id 放顶层。
// - tier:unit。
it('folds top-level keys declared in draft-07 dependencies subschemas', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_grid', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' }, tag: { type: 'string' } },
      dependencies: {
        file_id: { properties: { sheet_id: { type: 'string' } } },
        tag: ['file_id'],
      },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_grid', tool: 'set_cell' });
  await gateway.executeCall({
    server: 'cindy_grid', tool: 'set_cell', args: { file_id: 'doc-1' }, sheet_id: 'sheet-1',
  });
  expect(requests[0].params).toEqual({
    name: 'set_cell',
    arguments: { file_id: 'doc-1', sheet_id: 'sheet-1' },
  });
});

// 评审 P1(信封整个摊平、没有 args 容器): 重建信封的前提是「模型给了 args 容器」——
// 连容器都没给时({server, tool, name:'schedule_list', status:'active'}), 内层参数是**内层
// 工具**的, 外层信封 schema 只声明 name/args, 判不了它们: 按外层 schema 丢, 内层工具就只
// 拿到空参数(列全部定时任务而不是按 status 过滤)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 929ec41d0d 的 P1。
// - 覆盖缺口:信封用例只盖了「带 args 容器」的平铺形态。
// - 最小失败输入:顶层给 name + 内层参数, 不给 args。
// - tier:unit。
it('rebuilds a fully flattened envelope that has no args container', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_scheduler', client, [{
    name: 'call_tool',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_scheduler', tool: 'call_tool' });
  await gateway.executeCall({
    server: 'cindy_scheduler', tool: 'call_tool', name: 'schedule_list', status: 'active',
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'schedule_list', args: { status: 'active' } },
  });
});

// 评审 P1(无容器零参数信封重建不回显): 仅给出 {server, tool, name:'schedule_list'} 时,
// 桥把调用重写成了 {name:'schedule_list', args:{}}, 但 rebuiltEnvelope 只认带 args 容器的那支,
// 导致 folded=[] 且 rebuiltEnvelope=undefined, normalizationNote 返回 null 不回显。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数与回执说明。
// - Bug 依据:codex 对 71d60521a1 的 P1。
// - 覆盖缺口:无容器信封用例带了 status 参数, 靠 folded.length > 0 触发回显, 漏了零内层参数场景。
// - 最小失败输入:顶层只给 name, 不给 args 也不给内层参数。
// - tier:unit。
it('echoes rebuilt envelope note even when a no-container envelope has no inner parameters', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_scheduler', client, [{
    name: 'call_tool',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_scheduler', tool: 'call_tool' });
  const result = await gateway.executeCall({
    server: 'cindy_scheduler', tool: 'call_tool', name: 'schedule_list',
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'schedule_list', args: {} },
  });
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Cindy rebuilt the {"name", "args"} envelope');
  expect(note).toContain('Forwarded arguments: {"name":"schedule_list","args":{}}');
});

// 评审 P1(信封指纹认得太宽): 一个普通工具只要有「必填 name(string) + args(object)」就被当成
// 注册表信封 —— 但它还有兄弟字段 mode, name/args 是它自己的参数。平铺调用于是被改写成
// {name:'job', args:{..., mode:'fast'}}, mode 在服务端校验之前就被挪进了错误的一层。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 929ec41d0d 的 P1。
// - 覆盖缺口:信封误判的用例只盖了「信封形状完全不同」的第三方工具。
// - 最小失败输入:工具声明 name + args + mode 三个字段, 调用给 name/args/mode。
// - tier:unit。
it('does not treat a tool with sibling parameters as a registry envelope', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_jobs', client, [{
    name: 'job',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' }, mode: { type: 'string' } },
      required: ['name'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_jobs', tool: 'job' });
  await gateway.executeCall({
    server: 'cindy_jobs', tool: 'job', name: 'job-1', args: { payload: 'p' }, mode: 'fast',
  });
  const forwarded = (requests[0].params as { arguments: Record<string, unknown> }).arguments;
  // 没有被改写成信封: 兄弟字段 mode 留在外层(没被挪进 args), name 是这个工具自己的参数。
  expect(forwarded.mode).toBe('fast');
  expect(forwarded.name).toBe('job-1');
  expect(forwarded).not.toHaveProperty('args');
});

// 评审 P1(根层匹配后提前 return 漏看组合里的兄弟字段): 根层声明了 name + args 且 required 含 name,
// 兄弟字段 mode 挂在 allOf 分支里 —— isNameEnvelopeSchema 根层命中即 return true 跳过了组合
// 分支里的 mode, 又把普通工具误认成信封并改写成 {name:'job-1', args:{payload:'p', mode:'fast'}}。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 71d60521a1 的 P1。
// - 覆盖缺口:上一轮兄弟字段直接写在根层 properties 里, 没测根层只写 name+args、兄弟字段在 allOf 里。
// - 最小失败输入:根层 properties 仅 name+args + allOf:[{properties:{mode}}], 调用给 name/args/mode。
// - tier:unit。
it('does not treat a tool with composed sibling parameters as a registry envelope', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_jobs', client, [{
    name: 'job',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' } },
      required: ['name'],
      allOf: [{ properties: { mode: { type: 'string' } } }],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_jobs', tool: 'job' });
  await gateway.executeCall({
    server: 'cindy_jobs', tool: 'job', name: 'job-1', args: { payload: 'p' }, mode: 'fast',
  });
  const forwarded = (requests[0].params as { arguments: Record<string, unknown> }).arguments;
  expect(forwarded.mode).toBe('fast');
  expect(forwarded.name).toBe('job-1');
  expect(forwarded).not.toHaveProperty('args');
});

// 评审 P1(信封的两个字段分写在 allOf 的不同分支): 信封证据原先只在一个节点内凑 —— name 与
// args 分别声明在两个 allOf 分支里时, 没有哪个节点单独凑齐「name 是 string + args 是 object +
// required 含 name」, 判不出信封。平铺的 {name, args} 于是被当成普通参数: 顶层 name 折进参数
// 容器, 信封的 args 层消失; args 可省时内层工具被按空参数调用。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 af161e62aa 的 P1。
// - 覆盖缺口:信封藏在组合声明后面的用例只盖了「单个节点(根层 $ref 的目标)自己就凑齐」。
// - 最小失败输入:allOf:[{properties:{name}, required:['name']}, {properties:{args}}] + 平铺的 name/args。
// - tier:unit。
// anyOf / oneOf 的分支之间各算各的: 一个分支声明 name、另一个声明 args, 拼不成信封 —— 合并的话,
// 「只给 args」的合法调用会被信封检查永久拒绝。分支接在分支外的声明后面怎么算, 见下面两条用例。
it('rebuilds a flattened envelope whose fields are declared in separate allOf branches', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const nameBranch = { properties: { name: { type: 'string' } }, required: ['name'] };
  const argsBranch = { properties: { args: { type: 'object' } } };
  const gateway = new Gateway();
  gateway.add('cindy_registry', client, [
    { name: 'call_tool', inputSchema: { type: 'object', allOf: [nameBranch, argsBranch] } },
    { name: 'invoke', inputSchema: { type: 'object', anyOf: [nameBranch, argsBranch] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_registry', tool: 'call_tool' });
  await gateway.listResult({ server: 'cindy_registry', tool: 'invoke' });
  await gateway.executeCall({
    server: 'cindy_registry', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
  // anyOf 的两个分支不是信封: 只给 args 的调用按普通参数转发, 不被信封检查拦下。
  await gateway.executeCall({ server: 'cindy_registry', tool: 'invoke', args: { type: 'project' } });
  expect(requests[1].params).toEqual({ name: 'invoke', arguments: { type: 'project' } });
});

// 评审 P1(信封的 args 声明在 anyOf / oneOf / 条件分支里): 上一轮让每个分支各自从零起算, 根层
// 声明并要求必填的 name 与分支里声明的 args 就凑不到一起 —— 平铺的 {name, args} 又被当成普通
// 参数: 顶层 name 折进参数容器, 信封的 args 层消失, 内层工具被按空参数调用。分支要接在分支外的
// 声明后面看: 根层的 name + 分支里的 args, 对走了那个分支的调用同时成立。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 9af3cc5486 的 P1。
// - 覆盖缺口:上一轮只盖了「两个字段都在 allOf 分支里」与「两个 anyOf 分支各出一半」。
// - 最小失败输入:根层 properties.name + required:['name'] + anyOf:[{properties:{args}}], 平铺的 name/args。
// - tier:unit。
it('rebuilds a flattened envelope whose args is declared inside union or conditional branches', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const nameAtRoot = { properties: { name: { type: 'string' } }, required: ['name'] };
  const argsBranches = [
    { properties: { args: { type: 'object' } } },
    { properties: { args: { type: 'object' } }, required: ['args'] },
  ];
  const shapes = [
    { ...nameAtRoot, anyOf: argsBranches },
    { ...nameAtRoot, oneOf: argsBranches },
    // name 写在 allOf 的后一个分支里: 走到前一个分支的 anyOf 时它还没被看到。
    { allOf: [{ anyOf: argsBranches }, nameAtRoot] },
    { ...nameAtRoot, if: { required: ['args'] }, then: { properties: { args: { type: 'object' } } } },
    // 判别联合写法: 两个分支各自都是一个完整信封, name 在每个分支里都必填。
    {
      oneOf: [
        { properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name', 'args'] },
        nameAtRoot,
      ],
    },
    // 嵌套并选: 每条路径都要求 name —— 内层的并选先并进外层的分支, 再并进根。
    {
      anyOf: [
        nameAtRoot,
        {
          anyOf: [
            { properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
            nameAtRoot,
          ],
        },
      ],
    },
  ];
  const gateway = new Gateway();
  gateway.add('cindy_registry', client,
    shapes.map((inputSchema, index) => ({ name: `call_tool_${index}`, inputSchema })));
  gateway.register({ registerTool: () => undefined });
  for (const [index] of shapes.entries()) {
    await gateway.listResult({ server: 'cindy_registry', tool: `call_tool_${index}` });
    await gateway.executeCall({
      server: 'cindy_registry', tool: `call_tool_${index}`, name: 'memory_write', args: { type: 'project' },
    });
    expect(requests[index].params).toEqual({
      name: `call_tool_${index}`,
      arguments: { name: 'memory_write', args: { type: 'project' } },
    });
  }
});

// 评审收尾(分支里的 required 只在走了那个分支时成立): 一个分支自己就是完整信封、另一个分支是 {}
// 的普通工具(字段恰好是 name + args), name 可省; 把分支里的 required 当成无条件必填, 没给 name 的
// 合法调用就会被信封检查永久拒绝。所以 name 的必填必须在每条路径上都成立: 根上的 required, 或
// 每个分支都必填的 anyOf / oneOf。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数(没被信封检查拦下)。
// - Bug 依据:自查(修 codex 对 9af3cc5486 的 P1 时)。第三个形态修复前就被认成信封。
// - 覆盖缺口:信封用例没有「required 只出现在分支里」的形态。
// - 最小失败输入:properties 恰好 name + args + anyOf:[{required:['name']}, {}], 调用只给 args。
// - tier:unit。
it('does not treat a tool whose name is only required on some branches as a registry envelope', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const twoFields = { properties: { name: { type: 'string' }, args: { type: 'object' } } };
  const shapes = [
    // 只有一个分支要求 name: 走另一个分支时 name 可省。
    { ...twoFields, anyOf: [{ required: ['name'] }, {}] },
    // 条件成立时才要求 name。
    { ...twoFields, if: { required: ['args'] }, then: { required: ['name'] } },
    // 一个分支自己就是完整信封, 另一个分支是 {}: 第二个分支上 name 可省。
    { anyOf: [{ ...twoFields, required: ['name'] }, {}] },
  ];
  const gateway = new Gateway();
  gateway.add('cindy_registry', client,
    shapes.map((inputSchema, index) => ({ name: `invoke_${index}`, inputSchema })));
  gateway.register({ registerTool: () => undefined });
  for (const [index] of shapes.entries()) {
    await gateway.listResult({ server: 'cindy_registry', tool: `invoke_${index}` });
    await gateway.executeCall({ server: 'cindy_registry', tool: `invoke_${index}`, args: { payload: 'p' } });
    expect(requests[index].params).toEqual({ name: `invoke_${index}`, arguments: { payload: 'p' } });
  }
});

// 评审 P1(信封判不了时按普通工具转发): 注册表的 call_tool schema 看不全(节点预算截断 / 解析不了的引用)
// 时 isNameEnvelopeSchema 不下结论, 平铺的信封 {name, args} 于是走普通工具那条路 —— 顶层 name 被折进
// 参数容器, 服务端拿到 {name, <内层参数>}: 没有 args 层, 内层工具被按空参数调用还返回成功。判不了就
// 不发: 拒收并指出唯一一种两种工具(信封 / name 是自己的参数)都走得通的形状 —— 全部放进 args。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 的结果(拒收 + 指路)与它有没有发出 tools/call;
//   同一调用改成全部放进 args 之后照常转发。
// - Bug 依据:codex 对 6ce19703bd 的 P1。
// - 覆盖缺口:预算用尽与解析不了的引用的用例都只用「不像信封」的工具, 没盖「看不全、但已看到的
//   部分就是信封的样子」。
// - 最小失败输入:信封 schema + 600 条空 allOf 分支(或一个解析不了的 $ref) + 顶层的 {name, args}。
// - tier:unit。
it('rejects a flattened call whose envelope schema could not be read in full instead of guessing', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const envelope = {
    type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'],
  };
  const unreadable = [
    { ...envelope, allOf: Array.from({ length: 600 }, () => ({})) },
    { ...envelope, allOf: [{ $ref: 'https://example.com/meta.json' }] },
  ];
  const gateway = new Gateway();
  gateway.add('cindy_registry', client,
    unreadable.map((inputSchema, index) => ({ name: `call_tool_${index}`, inputSchema })));
  // 对照: 同样看不全, 但已看到的部分有兄弟字段 —— 不是信封的样子, 顶层 name 照旧当这个工具自己的
  // 参数折进去。
  gateway.add('cindy_plain', client, [{
    name: 'with_sibling',
    inputSchema: {
      ...envelope,
      properties: { ...envelope.properties, mode: { type: 'string' } },
      allOf: Array.from({ length: 600 }, () => ({})),
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  for (const [index] of unreadable.entries()) {
    const tool = `call_tool_${index}`;
    // 先过披露门: 否则拦下调用的是披露路标, 看不出这个调用本来会被原样转发出去。
    await gateway.listResult({ server: 'cindy_registry', tool });
    for (const input of [{ name: 'memory_write', args: { type: 'project' } }, { name: 'schedule_create', title: 'x' }]) {
      await expect(gateway.executeCall({ server: 'cindy_registry', tool, ...input })).rejects.toThrow(
        /could not read the schema of this tool in full .* Put everything in args/,
      );
    }
  }
  // 一次都不许发出去: 发出去就是内层工具被按空参数调用并返回成功。
  expect(requests).toHaveLength(0);
  // 指的那个形状走得通: 全部放进 args, 原样转发。
  await gateway.executeCall({
    server: 'cindy_registry', tool: 'call_tool_0', args: { name: 'memory_write', args: { type: 'project' } },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool_0', arguments: { name: 'memory_write', args: { type: 'project' } },
  });
  await gateway.listResult({ server: 'cindy_plain', tool: 'with_sibling' });
  await gateway.executeCall({ server: 'cindy_plain', tool: 'with_sibling', name: 'profile-a', args: { a: 1 } });
  expect(requests[1].params).toEqual({ name: 'with_sibling', arguments: { a: 1, name: 'profile-a' } });
});

// 评审 P1(同名参数两处都给, 顶层那份悄悄作废): {args: {row: 1}, row: 10} 以 args 为准是对的, 但顶层 row
// 既不在 folded 也不在 unmapped —— 没有别的归一化动作时回执里没有 Forwarded arguments, 服务端按 row 1
// 写成功, 模型与用户都不知道 row 10 为什么没生效。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数, 以及工具结果 / 失败
//   回执里点名被压掉的那个键、回显真正发出去的那一份。
// - Bug 依据:codex 对 6ce19703bd 的 P1。
// - 覆盖缺口:折叠用例的顶层键都不与 args 里的键重名。
// - 最小失败输入:{server, tool, args: {row: 1}, row: 10}。
// - tier:unit。
it('names the top-level parameters that lost to a same-named key in args and echoes what was forwarded', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  let reject = false;
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    if (reject) throw new Error('invalid params');
    return { content: [{ type: 'text', text: 'WROTE[A1]' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'set_cell',
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' }, row: { type: 'integer' }, col: { type: 'integer' } },
      required: ['file_id', 'row', 'col'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'set_cell' });
  // args 是对象、是 JSON 字符串两种形态都一样: 以(解析后的)容器为准。
  for (const container of [{ file_id: 'doc-1', row: 1, col: 2 }, '{"file_id":"doc-1","row":1,"col":2}']) {
    const result = await gateway.executeCall({
      server: 'cindy_sheets', tool: 'set_cell', args: container, row: 10, col: 20,
    });
    expect(requests[requests.length - 1].params)
      .toEqual({ name: 'set_cell', arguments: { file_id: 'doc-1', row: 1, col: 2 } });
    const note = result.content.map(block => block.text ?? '').join('\n');
    expect(note).toContain(
      'were not forwarded because args already has a key of the same name (args wins): row, col.',
    );
    expect(note).toContain('Forwarded arguments: {"file_id":"doc-1","row":1,"col":2}');
  }
  // 服务端拒收时同样点名: 最需要核对出站参数的场景。
  reject = true;
  await expect(gateway.executeCall({
    server: 'cindy_sheets', tool: 'set_cell', args: { file_id: 'doc-1', row: 1, col: 2 }, row: 10,
  })).rejects.toThrow(/same name \(args wins\): row\. Forwarded arguments/);
});

// 评审 P1(属性类型写成数组或藏在组合里): 信封指纹用 name.type === 'string' / args.type === 'object'
// 严格相等, 而合法的 JSON Schema 允许 type 是数组(可空的 args 常写成 ['object', 'null'])、把类型
// 抽到 $ref 或 anyOf 分支里。这样的信封判不出来, 平铺的 {name, args} 被当成普通参数转发, 内层
// 工具被按空参数调用; 执行前的信封检查也一并放行。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 ec4eeb574a 的 P1。
// - 覆盖缺口:信封用例的属性类型都只是单个字符串。
// - 最小失败输入:properties.name.type = ['string'] + 平铺的 name/args。
// - tier:unit。
it('rebuilds a flattened envelope whose property types are arrays or composed schemas', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const shapes = [
    {
      type: 'object',
      properties: { name: { type: ['string'] }, args: { type: ['object', 'null'] } },
      required: ['name'],
    },
    {
      type: 'object',
      properties: { name: { $ref: '#/$defs/ToolName' }, args: { $ref: '#/$defs/Args' } },
      required: ['name'],
      $defs: { ToolName: { type: 'string' }, Args: { type: 'object' } },
    },
    {
      type: 'object',
      properties: {
        name: { anyOf: [{ type: 'string' }] },
        args: { anyOf: [{ type: 'object' }, { type: 'null' }] },
      },
      required: ['name'],
    },
  ];
  const gateway = new Gateway();
  gateway.add('cindy_registry', client,
    shapes.map((inputSchema, index) => ({ name: `call_tool_${index}`, inputSchema })));
  gateway.register({ registerTool: () => undefined });
  for (const [index] of shapes.entries()) {
    await gateway.listResult({ server: 'cindy_registry', tool: `call_tool_${index}` });
    await gateway.executeCall({
      server: 'cindy_registry', tool: `call_tool_${index}`, name: 'memory_write', args: { type: 'project' },
    });
    expect(requests[index].params).toEqual({
      name: `call_tool_${index}`,
      arguments: { name: 'memory_write', args: { type: 'project' } },
    });
  }
});

// 评审 P1(动态字段的工具被当成信封): 普通工具只声明 name + args 两个字段、但明确放开动态字段
// (additionalProperties / patternProperties)时, 动态字段不进 names, 指纹照样认成信封。平铺调用
// {name, args, mode} 被改写成 {name, args: {..., mode}} —— mode 是外层的动态字段, 在服务端校验
// 之前就被挪进了错误的一层。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 ec4eeb574a 的 P1。
// - 覆盖缺口:信封误判的用例只盖了「兄弟字段有名字」, 没盖「动态字段」。
// - 最小失败输入:name + args + additionalProperties: true, 调用给 name/args/mode。
// - tier:unit。
it('does not treat a dynamically extensible two-field tool as a registry envelope', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const twoFields = {
    type: 'object',
    properties: { name: { type: 'string' }, args: { type: 'object' } },
    required: ['name'],
  };
  const cases = [
    { tool: 'job_open', inputSchema: { ...twoFields, additionalProperties: true }, sibling: { mode: 'fast' } },
    { tool: 'job_tagged', inputSchema: { ...twoFields, patternProperties: { '^x_': {} } }, sibling: { x_extra: 'tagged' } },
  ];
  const gateway = new Gateway();
  gateway.add('cindy_jobs', client, cases.map(({ tool, inputSchema }) => ({ name: tool, inputSchema })));
  gateway.register({ registerTool: () => undefined });
  for (const [index, { tool, sibling }] of cases.entries()) {
    await gateway.listResult({ server: 'cindy_jobs', tool });
    await gateway.executeCall({
      server: 'cindy_jobs', tool, name: 'job-1', args: { payload: 'p' }, ...sibling,
    });
    // 没有被改写成信封: 动态字段与 name 都留在外层(这个工具自己的参数)。
    expect(requests[index].params).toEqual({
      name: tool,
      arguments: { payload: 'p', name: 'job-1', ...sibling },
    });
  }
});

// 评审 P1(unevaluatedProperties 被忽略): 2019-09 / 2020-12 的 schema 用 unevaluatedProperties
// 放开动态字段, 收集表态时只看 additionalProperties。声明名之外、schema 明确收下的平铺参数于是
// 被记成 unmapped 不转发, 服务端按缺省值执行。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 af161e62aa 的 P1。
// - 覆盖缺口:「schema 明确收下的额外键」的用例只盖了 additionalProperties 与 patternProperties。
// - 最小失败输入:properties.file_id + unevaluatedProperties: true + 顶层 row。
// - tier:unit。
it('forwards flattened keys that unevaluatedProperties explicitly allows', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const allowances = [true, { type: 'string' }];
  const gateway = new Gateway();
  gateway.add('cindy_grid', client, allowances.map((unevaluatedProperties, index) => ({
    name: `set_cell_${index}`,
    inputSchema: {
      type: 'object', properties: { file_id: { type: 'string' } }, unevaluatedProperties,
    },
  })));
  gateway.register({ registerTool: () => undefined });
  for (const [index] of allowances.entries()) {
    await gateway.listResult({ server: 'cindy_grid', tool: `set_cell_${index}` });
    await gateway.executeCall({
      server: 'cindy_grid', tool: `set_cell_${index}`, args: { file_id: 'doc-1' }, row: 10,
    });
    expect(requests[index].params).toEqual({
      name: `set_cell_${index}`,
      arguments: { file_id: 'doc-1', row: 10 },
    });
  }
});

// 评审 P2(required 列了 properties 里没有的字段): JSON Schema 允许 required 列出未在 properties
// 里定义的字段(properties: {file_id: {}}, required: ['file_id', 'row'])。表态只收 properties 的键,
// 平铺的 row 被记成 unmapped 不转发 —— schema 明确要求它必填, 服务端只能报缺参。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 af161e62aa 的 P2(required);codex 对 9af3cc5486 的 P2(数组形态的
//   dependencies / dependentRequired:「有 tag 就必须带 file_id」, file_id 同样只在名字列表里出现);
//   触发字段(tag)自己不在 properties 里的两段见自审(codex 对 6ce19703bd 复评期间)。
// - 覆盖缺口:参数名收集的用例只盖了 properties(含组合分支里的)。
// - 最小失败输入:properties.file_id + required: ['file_id', 'row'] + 顶层 row。
// - tier:unit。
it('folds flattened keys that the schema only lists in required or property dependencies', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const cases = [
    {
      tool: 'set_cell',
      inputSchema: { type: 'object', properties: { file_id: {} }, required: ['file_id', 'row'] },
      input: { args: { file_id: 'doc-1' }, row: 10, note: 'not a parameter' },
      // 不在 properties 也不在 required 里的键照旧不转发。
      forwarded: { file_id: 'doc-1', row: 10 },
      unmapped: 'were not forwarded because the tool schema does not declare them: note',
    },
    {
      // 声明过属性名的工具才按名字筛: 只在 required 里点名的工具没有属性名可筛, 其余键仍整体折进去。
      tool: 'search',
      inputSchema: { type: 'object', required: ['query'] },
      input: { args: {}, query: 'x', limit: 10 },
      forwarded: { query: 'x', limit: 10 },
      unmapped: '',
    },
    {
      // draft-07 的数组形态 dependencies: 「有 tag 就必须带 file_id」—— file_id 只在名字列表里。
      tool: 'set_cell_dep',
      inputSchema: { type: 'object', properties: { tag: {} }, dependencies: { tag: ['file_id'] } },
      input: { args: { tag: 'a' }, file_id: 'doc-1', note: 'not a parameter' },
      forwarded: { tag: 'a', file_id: 'doc-1' },
      unmapped: 'were not forwarded because the tool schema does not declare them: note',
    },
    {
      // 2019-09 的 dependentRequired 是同一种写法。
      tool: 'set_cell_dreq',
      inputSchema: { type: 'object', properties: { tag: {} }, dependentRequired: { tag: ['file_id'] } },
      input: { args: { tag: 'a' }, file_id: 'doc-1' },
      forwarded: { tag: 'a', file_id: 'doc-1' },
      unmapped: '',
    },
    {
      // 触发的字段自己也不在 properties 里(「有 tag 才必须带 file_id」): 服务端按它的有无提要求,
      // 它就是认的参数, 与被点名的 file_id 同理。
      tool: 'set_cell_trigger',
      inputSchema: { type: 'object', properties: { file_id: {} }, dependentRequired: { tag: ['file_id'] } },
      input: { args: { file_id: 'doc-1' }, tag: 'a', note: 'not a parameter' },
      forwarded: { file_id: 'doc-1', tag: 'a' },
      unmapped: 'were not forwarded because the tool schema does not declare them: note',
    },
    {
      // schema 形态的 dependencies: 键是触发的字段, 值是子 schema。
      tool: 'set_cell_trigger_schema',
      inputSchema: { type: 'object', properties: { file_id: {} }, dependencies: { tag: { required: ['file_id'] } } },
      input: { args: { file_id: 'doc-1' }, tag: 'a' },
      forwarded: { file_id: 'doc-1', tag: 'a' },
      unmapped: '',
    },
  ];
  const gateway = new Gateway();
  gateway.add('cindy_grid', client, cases.map(({ tool, inputSchema }) => ({ name: tool, inputSchema })));
  gateway.register({ registerTool: () => undefined });
  for (const [index, { tool, input, forwarded, unmapped }] of cases.entries()) {
    await gateway.listResult({ server: 'cindy_grid', tool });
    const result = await gateway.executeCall({ server: 'cindy_grid', tool, ...input });
    expect(requests[index].params).toEqual({ name: tool, arguments: forwarded });
    if (unmapped) {
      const note = result.content.map(block => block.text ?? '').join('\n');
      expect(note).toContain(unmapped);
    }
  }
});

// 评审 P1(判不了的模式按没声明处理, 把真实声明的参数丢了): 键太长时不跑任何模式 —— 那个键
// 可能正好命中某条声明(动态参数名本来就没有长度约定), 按没声明丢掉, 服务端就按缺省值执行。
// 与预算用尽的情形同一处理: 不跑正则, 但照常转发。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 af161e62aa 的 P1。
// - 覆盖缺口:键长上限的用例只盖了「不跑模式」, 没盖这个键之后是被丢还是被转发。
// - 最小失败输入:patternProperties {'^x-.*$': …} + 200 个字符的顶层键。
// - tier:unit。
it('preserves a key that is too long to match against the declared patterns', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_extras', client, [{
    name: 'tag',
    inputSchema: {
      type: 'object', properties: { file_id: { type: 'string' } }, patternProperties: { '^x-.*$': { type: 'string' } },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_extras', tool: 'tag' });
  const key = `x-${'p'.repeat(200)}`;
  await gateway.executeCall({ server: 'cindy_extras', tool: 'tag', args: { file_id: 'doc-1' }, [key]: 'long key' });
  expect(requests[0].params).toEqual({ name: 'tag', arguments: { file_id: 'doc-1', [key]: 'long key' } });
});

// 评审 P2(节点预算用尽后还在逐个走分支): 一个 allOf 有几十万个分支时, 预算(512 个节点)用尽后
// 每个分支仍要进一次 walk 才返回 —— 组合声明面的工作量随分支总数增长, 而权限与执行两条路径
// 每次调用都要重建表态。自查补充(修 P2 时只让对象分支占预算): 不是对象的分支(true / false)与
// 超深的分支进了 walk 就被挡回来、不占预算, 预算在它们身上永远用不完 —— 多分支的并选还各起一个分支组。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数, 以及它从
//   服务端给的分支数组里取出的分支个数(用 Proxy 计数, 不靠计时)。
// - Bug 依据:codex 对 ec4eeb574a 的 P2;布尔分支与超深分支见自审(codex 对 6ce19703bd 复评期间)。
// - 覆盖缺口:预算用尽的用例只断言「即时返回 + 不丢参数」, 没区分「按预算停」与「走完全部分支」。
// - 最小失败输入:10 万条分支的 allOf(空对象 / true), 或 32 层 allOf 之下的 10 万条 anyOf 分支,
//   外加顶层一个未声明的键。
// - tier:unit。
it('stops walking combinator branches once the node budget is spent', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  let counting = false;
  let branchReads = 0;
  const counted = (branches: unknown[]): unknown[] => new Proxy(branches, {
    get(target, property, receiver) {
      // 披露门每次调用都要给 schema 求一次指纹(JSON.stringify), 那一遍会读全部分支, 与遍历无关:
      // 给它一个空的 toJSON, 让计数只反映组合声明面的遍历。
      if (property === 'toJSON') return () => [];
      // 披露指纹(add / listResult 时)同理不在计数期内。
      if (counting && typeof property === 'string' && /^\d+$/.test(property)) branchReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const branches = (kind: 'object' | 'boolean'): unknown[] =>
    kind === 'boolean' ? new Array(100_000).fill(true) : Array.from({ length: 100_000 }, () => ({}));
  // 32 层 allOf 之下的 anyOf: 分支都在深度上限之外, 进了 walk 也只是被挡回来。
  const tooDeep = (wide: unknown[]): Record<string, unknown> => {
    let node: Record<string, unknown> = { anyOf: wide };
    for (let layer = 0; layer < 32; layer++) node = { allOf: [node] };
    return node;
  };
  const cases = [
    // 普通分支: 每个占一个节点。
    { name: 'fan_objects', wide: { allOf: counted(branches('object')) } },
    // 布尔分支不是对象: 不占预算的话, 10 万条要逐个进一次 walk。
    { name: 'fan_booleans', wide: { allOf: counted(branches('boolean')) } },
    // 超深的分支: 被深度上限挡回时同样要占预算, 否则预算在它们身上用不完。
    { name: 'fan_too_deep', wide: tooDeep(counted(branches('object'))) },
  ];
  const gateway = new Gateway();
  gateway.add('cindy_wide', client, cases.map(({ name, wide }) => ({
    name,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, ...wide },
  })));
  gateway.register({ registerTool: () => undefined });
  for (const [index, { name }] of cases.entries()) {
    await gateway.listResult({ server: 'cindy_wide', tool: name });
    branchReads = 0;
    counting = true;
    const started = performance.now();
    await gateway.executeCall({ server: 'cindy_wide', tool: name, args: { id: 'x-1' }, extra: 'kept' });
    counting = false;
    expect(performance.now() - started).toBeLessThan(1000);
    // 每次归一化只取预算内的分支(根节点占 1 个), 不随分支总数增长: 一次调用归一化几轮也只是
    // 预算的几倍, 远小于修复前的 40 万(10 万条 × 4 轮)。
    expect(branchReads).toBeGreaterThan(0);
    expect(branchReads).toBeLessThan(16_384);
    // 预算用尽 → 声明面不完整 → 不丢参数。
    expect(requests[index].params).toEqual({ name, arguments: { id: 'x-1', extra: 'kept' } });
  }
});

// 评审 P2(折进来的 __proto__ 键触发了原型 setter): 把平铺键写进 params 用的是 params[key] = value,
// key 是 __proto__ 时走的是 Object.prototype 上的 setter —— 键没写进去(发给服务端的参数里少一个),
// 对象值还会把 params 的原型换掉, 后面按属性名读参数的地方就读到被塞进来的值。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数(JSON 里可见)。
// - Bug 依据:codex 对 ec4eeb574a 的 P2。
// - 覆盖缺口:折叠用例的键都是普通名字。
// - 最小失败输入:schema 声明 __proto__ 属性 + 顶层 __proto__ 键。
// - tier:unit。
it('keeps a folded __proto__ key as its own argument instead of triggering the prototype setter', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'OK' }] };
  } };
  // schema 用 JSON 解析来写: 对象字面量里的 "__proto__" 键设的是原型, 不是一个属性。
  const inputSchema = JSON.parse(
    '{"type":"object","properties":{"file_id":{"type":"string"},"__proto__":{"type":"object"}}}',
  ) as Record<string, unknown>;
  const gateway = new Gateway();
  gateway.add('cindy_graph', client, [{ name: 'patch', inputSchema }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_graph', tool: 'patch' });
  await gateway.executeCall({
    server: 'cindy_graph', tool: 'patch', args: { file_id: 'x-1' }, ['__proto__']: { note: 'own argument' },
  });
  const forwarded = (requests[0].params as { arguments: Record<string, unknown> }).arguments;
  expect(JSON.stringify(forwarded)).toBe('{"file_id":"x-1","__proto__":{"note":"own argument"}}');
  expect(Object.getPrototypeOf(forwarded)).not.toHaveProperty('note');
});

it('intercepts a double-wrapped envelope and an entry-tool name before they reach the server', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    // 双包裁决代拉内层 list_tools: 返回真实 Cindy 形状 — 不传 category 只有类目概览, 无工具 schema。
    if (method === 'tools/call' && (params as any)?.name === 'list_tools') {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, categories: [{ name: 'read', tool_count: 4 }, { name: 'write', tool_count: 3 }] }) }] };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('cindy_memory', client, [
    // 真实 cindy_memory 的两入口形态: 只向 MCP 暴露 list_tools + call_tool(token economy),
    // memory_write 藏在服务端自家 registry, 不进 tools/list。
    { name: 'list_tools', inputSchema: { type: 'object' } },
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 2026-10-31 实测双包形状一: {name:外层名, args:{name:内层名, args:参数}} ——
  // 转发到服务端只会拿到 UNKNOWN_TOOL(requested=call_tool), 模型无从自纠; 桥在本地看穿。
  // 形状一/二里的内层工具都不在本地工具表(真实服务不进 tools/list), 靠两入口形状判定拦截。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool',
    args: { name: 'call_tool', args: { name: 'memory_write', args: { type: 'project' } } },
  })).rejects.toThrow(/nested twice/);
  // 双包形状二: {name:正确名, args:{args:参数}} —— 参数藏在第二层 args 里。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool',
    args: { name: 'memory_write', args: { args: { type: 'project' } } },
  })).rejects.toThrow(/nested twice/);
  // 信封 name 填了入口工具名 call_tool 本身。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool',
    args: { name: 'call_tool', args: { type: 'project' } },
  })).rejects.toThrow(/must be the INNER tool/);
  // 形状二触发过一次内层 list_tools 代拉(schemaless → 两入口启发式), 之后不再发请求。
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({ name: 'list_tools', arguments: {} });
  // 正确信封原样放行。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool',
    args: { name: 'memory_write', args: { type: 'project' } },
  });
  expect(requests).toHaveLength(2);
  expect(requests[1].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

it('passes through inner tools that legitimately declare an args parameter, repeatedly', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('acme_tools', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
    // 第三方信封 MCP 的内层工具合法声明 args 参数(数组): 与双包同形, 必须按 schema 放行。
    { name: 'run', inputSchema: { type: 'object', properties: { args: { type: 'array' } }, required: ['args'] } },
    // 宽松 schema 内层工具(无 properties): 判定不了是否接受 args → 无可靠判据, 放行不误拦。
    { name: 'eval', inputSchema: { type: 'object' } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'acme_tools', tool: 'call_tool' });
  // 合法 args 参数连续调用两次都放行: 拦截是确定性的, 不存在“重发原样调用就放行”的出口,
  // 所以放行必须一次到位。
  const legalCall = { server: 'acme_tools', tool: 'call_tool', args: { name: 'run', args: { args: ['--version'] } } };
  await gateway.executeCall(legalCall);
  await gateway.executeCall(legalCall);
  expect(requests).toHaveLength(2);
  expect(requests[1].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'run', args: { args: ['--version'] } },
  });
  // 宽松内层 schema(无 properties) + args 参数: 判定不了 → 启发式放行, 连续两次透传。
  const looseCall = { server: 'acme_tools', tool: 'call_tool', args: { name: 'eval', args: { args: { code: '1+1' } } } };
  await gateway.executeCall(looseCall);
  await gateway.executeCall(looseCall);
  expect(requests).toHaveLength(4);
  expect(requests[3].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'eval', args: { args: { code: '1+1' } } },
  });
  // 信封 name 查无此工具: 先代拉内层 list_tools(本 fixture 无内层列表 → 解析失败回退启发式),
  // acme 暴露了 run/eval(非两入口) → 放行给服务端报 UNKNOWN_TOOL。
  await gateway.executeCall({ server: 'acme_tools', tool: 'call_tool', args: { name: 'nope', args: { args: { x: 1 } } } });
  expect(requests).toHaveLength(6);
});

it('probes the inner list_tools of a third-party two-entry gateway and passes legal args params', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  // 第三方两入口 mimics: MCP 层只有 call_tool/list_tools, 内层工具藏在自家 registry,
  // 但 list_tools 返回带 schema 的工具列表(greptile P1 场景: 内层合法声明对象型 args 参数)。
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    if (method === 'tools/call' && (params as any)?.name === 'list_tools') {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, tools: [
        { name: 'run', description: 'd', inputSchema: { type: 'object', properties: { args: { type: 'object' } }, required: ['args'] } },
      ] }) }] };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  gateway.add('stealth_tools', client, [
    { name: 'list_tools', inputSchema: { type: 'object' } },
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'stealth_tools', tool: 'call_tool' });
  // 内层 run 声明了 args 参数 → 代拉 list_tools 后放行, 不永久拒绝。
  await gateway.executeCall({ server: 'stealth_tools', tool: 'call_tool', args: { name: 'run', args: { args: { cwd: '/work' } } } });
  expect(requests).toHaveLength(2);
  expect(requests[0].params).toEqual({ name: 'list_tools', arguments: {} });
  expect(requests[1].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'run', args: { args: { cwd: '/work' } } },
  });
  // 代拉结果按 server 缓存: 第二次合法调用与查无此工具都不再发 list_tools。
  await gateway.executeCall({ server: 'stealth_tools', tool: 'call_tool', args: { name: 'run', args: { args: { cwd: '/work2' } } } });
  await gateway.executeCall({ server: 'stealth_tools', tool: 'call_tool', args: { name: 'nope', args: { args: { x: 1 } } } });
  expect(requests).toHaveLength(4);
  expect(requests[2].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'run', args: { args: { cwd: '/work2' } } },
  });
  expect(requests[3].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'nope', args: { args: { x: 1 } } },
  });
});

it('does not apply the Cindy envelope rule to a third-party tool also named call_tool', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new context.Gateway();
  // 用户自接的第三方 MCP: 工具同样叫 call_tool, 但信封是 {tool_name, arguments}。
  gateway.add('third_party', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        arguments: { type: 'object', additionalProperties: true },
      },
      required: ['tool_name'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'third_party', tool: 'call_tool' });
  // 模型完全照检视到的 schema 调用: 必须放行到服务端, 不能被 Cindy 的信封规则连坐。
  await gateway.executeCall({
    server: 'third_party',
    tool: 'call_tool',
    args: { tool_name: 'inner', arguments: { a: 1 } },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { tool_name: 'inner', arguments: { a: 1 } },
  });
  // 同一 server 里, schema 形状指纹齐全 (name+args+required) 的工具仍走信封自纠错
  // (判据是形状不是名字)。
  gateway.add('mixed', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' } },
      required: ['name'],
    },
  }]);
  await gateway.listResult({ server: 'mixed', tool: 'call_tool' });
  await expect(gateway.executeCall({ server: 'mixed', tool: 'call_tool', args: { filename: 'x.md' } }))
    .rejects.toThrow(/envelope \{"name": <tool>, "args"/);
  expect(requests).toHaveLength(1);
});

it('leaves a direct tool alone when its required name is not the Cindy envelope', async () => {
  const source = CINDY_BRIDGE_EXTENSION_SOURCE;
  const compiled = ts.transpileModule(
    source.slice(source.indexOf('const CINDY_MCP_LIST_TOOLS'), source.indexOf('async function connectServer'))
      + '\n(globalThis as any).Gateway = CindyMcpGateway;',
    { compilerOptions: { module: ts.ModuleKind.None, target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  const context: Record<string, any> = {
    // 沙箱没有模块系统：bridge 顶部的 node:crypto import 在切片后丢失，
    // 指纹计算用的 createHash 必须由宿主注入。
    createHash,
    recordInput: (value: unknown) => value && typeof value === 'object' ? value : {},
    mcpContentToPi: (content: unknown) => content,
  };
  runInNewContext(compiled, context);
  const requests: Array<{ method: string; params: any }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    // 服务端按真实 schema 报缺 content —— 这才是模型该看到的修正信息。
    throw Object.assign(new Error('MCP error -32602: missing content'), { invalidParams: true });
  } };
  const gateway = new context.Gateway();
  // 第三方直调工具: name 是文件名, content 是正文, 没有 args 信封。
  gateway.add('files', client, [{
    name: 'write_file',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, content: { type: 'string' } },
      required: ['name', 'content'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'files', tool: 'write_file' });
  // 缺 name 时必须原样走到服务端, 由服务端报它真实的参数要求 (缺 name 与缺 content);
  // 桥不得把它引向「把 name 当工具名、其余塞进 args」的错误形状。
  // 关键: 参数里**不能带 name** —— 带了它新旧判据都不会进信封分支, 撤掉修复这测试照样绿,
  // 就盖不住「普通工具又收到信封提示」这个回归。
  // 错误正文过 safeMcpFailure 脱敏 (不外泄上游 body), 所以断言错误来自服务端那条路径,
  // 关键证据是下面两条: 请求确实发出了, 且 arguments 逐字未被桥改写。
  await expect(gateway.executeCall({ server: 'files', tool: 'write_file', args: { content: 'text' } }))
    .rejects.toThrow(/write_file failed/);
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({ name: 'write_file', arguments: { content: 'text' } });
});

// 评审 P1(截断把信封指纹的信号本身藏掉): required 写在足够多的分支之后把节点预算耗尽时,
// 已看到的部分有 name/args 的类型信号、声明的名字也恰好是这两个, 但 required 信号没看到 ——
// 信封结算失败(envelope=false), indeterminateEnvelope 不触发, 平铺的 {name, args} 被按普通工具
// 折进参数容器: 服务端拿到 {type, name}, 没有 args 层, 内层工具被按空参数调用。截断下
// 「已看到的部分就是信封的样子」本身就够判不了 —— 部分指纹同样要拒收(Codex P1 on 51c6ed253d)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 在该 schema 下拒收并指路, 0 个请求发出。
// - Bug 依据:codex 对 51c6ed253d 的 P1。
// - 覆盖缺口:上一轮的拒收用例 required 都在预算耗尽前看到(根层), 信封结算仍然成立。
// - 最小失败输入:properties.name/args 在前 + required:['name'] 在 600 个分支之后的信封 schema
//   + 平铺调用 {name, args}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('rejects a flattened call when truncation hid the envelope required signal', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  // 根 + 600 个分支远超 512 节点预算: required 所在的最后一个分支没走到, 信号没看到。
  const branches: Record<string, unknown>[] = Array.from({ length: 600 }, () => ({}));
  branches.push({ required: ['name'] });
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' } },
      allOf: branches,
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 平铺: 顶层 name 是信封层的内层工具名, 还是这个工具自己的参数 —— 看不全, 拒收并指路。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  })).rejects.toThrow(/could not read the schema of this tool in full .* Put everything in args/);
  // 容器形态(顶层没有 name): 不存在这层歧义, 照发。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', args: { name: 'memory_write', args: { type: 'project' } },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool', arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(同名内层参数对象被当成重复信封折掉一层): 「同一个选择器写了两遍」的裁决没有问
// 内层工具自己的 schema。内层工具自己就声明 name + args 参数时(run 这类), args 容器里的
// {name, args} 可能正是它的参数对象 —— 内层名恰好与选择器撞名而已。折叠后服务端收到的
// arguments 仍被 registry 当信封剥一层, 内层工具拿到 {cwd}, 自己声明的 name/args 没了。
// 执行前双包裁决本就按内层 schema 判(声明了 args 就放行), 归一化必须同源: 内层 schema
// 声明了 args 就不折叠, 照实重建; 没声明 / 本地查不到时维持折叠(2026-10-31 实测撞出的形状)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 51c6ed253d 的 P1。
// - 覆盖缺口:「keeps both name layers」用例刻意让内层 name 与选择器不同(target), 撞名的那支没盖。
// - 最小失败输入:内层工具 run 的 schema 声明 name + args + 调用 {name:'run', args:{name:'run', args:{…}}}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('keeps the inner parameter object when the selected tool declares name and args of its own', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  const envelopeSchema = { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } } };
  gateway.add('cindy_memory', client, [
    { name: 'call_tool', inputSchema: { ...envelopeSchema, required: ['name'] } },
    // 内层工具自己就声明 name + args: args 容器里的 {name:'run', args:{cwd}} 可以正是它的参数。
    { name: 'run', inputSchema: { ...envelopeSchema, required: ['name', 'args'] } },
    // 对照: 内层工具没有 args 参数 —— 容器里的 {name, args} 只能是重复信封, 照旧折叠。
    { name: 'recall', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 内层名与选择器撞名, 但 run 自己声明了 name + args: 不折叠, 两层都保留。
  const result = await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool', arguments: { name: 'run', args: { name: 'run', args: { cwd: '/work' } } },
  });
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Forwarded arguments: {"name":"run","args":{"name":"run","args":{"cwd":"/work"}}}');
  // 对照: 内层工具没有 args 参数, 撞名仍按「选择器写了两遍」折叠成一层。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'recall', args: { name: 'recall', args: { cwd: '/work' } },
  });
  expect(requests[1].params).toEqual({
    name: 'call_tool', arguments: { name: 'recall', args: { cwd: '/work' } },
  });
});

// 评审 P1(enum / const 的类型证据没被认): name 用 {enum: ['memory_write']}、args 用对象值
// {const: …} 时, JSON Schema 语义已把基本类型定死, 但判据只认 type 关键字 —— 信封结算失败,
// 平铺调用走普通工具那条路, 内层工具被按空参数调用。enum / const 的值就是类型证据:
// 全是字符串的 enum 是 string, 对象值的 const / enum 是 object; 混型不推断(Codex P1 on 51c6ed253d)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 51c6ed253d 的 P1。
// - 覆盖缺口:类型信号用例只盖了 type 关键字(含数组与组合声明)。
// - 最小失败输入:properties.name 只有 enum、properties.args 只有 const + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('recognizes enum and const type evidence in the envelope fingerprint', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [
    {
      name: 'call_tool',
      // 不写 type: 类型证据全在 enum / const 的值里。
      inputSchema: {
        type: 'object',
        properties: { name: { enum: ['memory_write', 'memory_read'] }, args: { const: {} } },
        required: ['name'],
        additionalProperties: false,
      },
    },
    {
      name: 'mixed_entry',
      // 对照: 混型 enum 不推断 —— 缺 name 的类型信号, 不当信封。
      inputSchema: {
        type: 'object',
        properties: { name: { enum: ['memory_write', 42] }, args: { const: {} } },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.listResult({ server: 'cindy_memory', tool: 'mixed_entry' });
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool', arguments: { name: 'memory_write', args: { type: 'project' } },
  });
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'mixed_entry', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests[1].params).toEqual({
    name: 'mixed_entry', arguments: { type: 'project', name: 'memory_write' },
  });
});

// 评审 P2(声明名收集没有封顶): 节点预算管不住 Object.keys —— 一个 properties 塞十万键时
// 键数组全量物化、名字逐个进 Set, 表面在权限与执行两条路径上还要重建多次。收集封顶,
// 收满即标 truncated: 声明面不完整, 顶层键不能证明「没声明」就照常转发不丢(Codex P2 on 51c6ed253d)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 即时返回, 且名字收满后顶层键按不完整处理
//   (schema 里没有的键被折进 args 转发, 而不是被记成未声明丢掉)。
// - Bug 依据:codex 对 51c6ed253d 的 P2。
// - 覆盖缺口:预算用例只盖了分支遍历, 名字收集这条线没有预算。
// - 最小失败输入:10 万键的 properties + properties 里没有的顶层键 extra_note。
// - tier:unit;耗时上限 1 秒与既有预算用例同款(封顶后收集是常数工作量)。
it('bounds schema name collection by a cap and keeps forwarding keys past it', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  const bigProperties: Record<string, unknown> = {};
  for (let index = 0; index < 100_000; index++) bigProperties['field_' + index] = { type: 'string' };
  gateway.add('cindy_big', client, [
    { name: 'wide', inputSchema: { type: 'object', properties: bigProperties } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_big', tool: 'wide' });
  const started = performance.now();
  // extra_note 不在 properties 里: 名字没收满时它会被记成未声明丢掉; 收满了(截断)就照常转发。
  const result = await gateway.executeCall({
    server: 'cindy_big', tool: 'wide', args: { field_0: 'v' }, extra_note: 'keep',
  });
  expect(performance.now() - started).toBeLessThan(1000);
  // 名字封顶 → 声明面不完整 → extra_note 不能证明「没声明」, 照常折进 args 转发。
  expect(requests[0].params).toEqual({ name: 'wide', arguments: { field_0: 'v', extra_note: 'keep' } });
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Cindy moved these top-level parameters into args before forwarding: extra_note');
});

// 评审 P1(截断把 args 的声明本身藏掉): required 与 name 的类型信号在前、args 的声明在
// 512 个分支之后时, 预算耗尽在 args 分支之前 —— names 只有 {name}, 上一轮的「恰好两个
 // 名字」闸不触发, 平铺的 {name, args} 仍被按普通工具发出 {type, name}。截断下只要已
 // 看到的声明不与信封矛盾(names ⊆ {name, args}、没放开动态字段), 调用又带真的参数载荷,
 // 就按判不了拒收(Codex P1 on d805bd345b)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 在该 schema 下拒收并指路, 0 个请求发出。
// - Bug 依据:codex 对 d805bd345b 的 P1。
// - 覆盖缺口:上一轮的拒收用例 args 的声明都在预算耗尽前看到(names 恰好 {name, args})。
// - 最小失败输入:branch1 声明并必填 string name + 510 个空分支 + args 的声明在最后
//   + 平铺调用 {name, args}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('rejects a flattened call when truncation hid the args declaration itself', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  // 根 + branch1 + 510 个空分支 = 512, 预算恰好在 args 分支之前耗尽。
  const branches: Record<string, unknown>[] = [
    { properties: { name: { type: 'string' } }, required: ['name'] },
    ...Array.from({ length: 510 }, () => ({})),
    { properties: { args: { type: 'object' } } },
  ];
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: { type: 'object', allOf: branches },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 平铺 + 载荷在容器里: 判不了, 拒收并指路。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  })).rejects.toThrow(/could not read the schema of this tool in full .* Put everything in args/);
  // 平铺 + 载荷在顶层(连容器都没给): 同样判不了, 拒收。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', type: 'project',
  })).rejects.toThrow(/could not read the schema of this tool in full/);
  // 只给了选择器、没有载荷: 两种读法发出去的是同一份, 不拦。
  await gateway.executeCall({ server: 'cindy_memory', tool: 'call_tool', name: 'memory_write' });
  // 容器形态(顶层没有 name): 不存在这层歧义, 照发。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', args: { name: 'memory_write', args: { type: 'project' } },
  });
  expect(requests).toHaveLength(2);
  expect(requests[0].params).toEqual({ name: 'call_tool', arguments: { name: 'memory_write' } });
  expect(requests[1].params).toEqual({
    name: 'call_tool', arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(组合声明的内层 schema 被判成没有 args): 撞名裁决的 schemaDeclaresArgs 只读根层
// properties。内层工具经 allOf / $ref 声明自己的 args 参数时判成 null, 归一化按「没声明」
// 折叠一层 —— registry 剥掉信封后内层工具拿到 {cwd}, 自己声明的 name/args 没了。改用有预算的
// 声明面遍历判(组合声明里的 properties / required 都算), 归一化与执行前双包裁决共用同一判据
// (Codex P1 on d805bd345b)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 d805bd345b 的 P1。
// - 覆盖缺口:上一轮的撞名用例内层 schema 在根层声明 name + args。
// - 最小失败输入:内层工具根层声明 name、allOf 分支声明 args + 调用 {name:'run', args:{name:'run', args:{…}}}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('judges composed inner schemas when adjudicating the name collision', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
    // 内层工具根层只声明 name, args 声明在 allOf 分支里。
    {
      name: 'run',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string' } },
        allOf: [{ properties: { args: { type: 'object' } } }],
        required: ['name', 'args'],
      },
    },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 撞名, 但内层 schema(经组合)声明了 args: 不折叠, 两层都保留。
  const result = await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } },
  });
  expect(requests[0].params).toEqual({
    name: 'call_tool', arguments: { name: 'run', args: { name: 'run', args: { cwd: '/work' } } },
  });
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Forwarded arguments: {"name":"run","args":{"name":"run","args":{"cwd":"/work"}}}');
});

// 评审 P1(属性类型判据预算用尽没有回传): properties.name 的类型写在 32 个 $ref / 组合节点
// 之外时, propertyAdmitsType 返回 false 却不标 truncated —— 表态看起来完整, 类型信号缺失,
// 信封结算失败, indeterminate 也不触发, 平铺调用丢了外层 args。类型判据预算用尽 ≠ 「确认不像」:
// 回传三态, 用尽即标 truncated, 整份表态按不完整处理(Codex P1 on d805bd345b)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 在该 schema 下拒收并指路, 0 个请求发出。
// - Bug 依据:codex 对 d805bd345b 的 P1。
// - 覆盖缺口:类型证据的用例都在 32 节点之内。
// - 最小失败输入:properties.name 的 type 藏在 40 层 allOf 里 + properties.args 在根层
//   + required ['name'] + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('marks the surface truncated when the property type walk runs out of budget', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  let deepName: Record<string, unknown> = { type: 'string' };
  for (let layer = 0; layer < 40; layer++) deepName = { allOf: [deepName] };
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      properties: { name: deepName, args: { type: 'object' } },
      required: ['name'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 类型判据看不全 → 表态不完整 → 与信封兼容的平铺调用拒收并指路。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  })).rejects.toThrow(/could not read the schema of this tool in full .* Put everything in args/);
  expect(requests).toHaveLength(0);
});

// 评审 P1(查不到内层 schema 时按「没声明」折叠): registry 只暴露 call_tool/list_tools 时, 撞名的
// 内层工具('run' 自己也声明 name + args 参数)不在本地工具表里 —— 归一化分不清「模型把同一个
// 选择器写了两遍」与「args 容器正是内层工具自己的参数对象」。按「没声明」折叠, registry 剥掉
// 信封后内层工具只拿到 {cwd}, 自己声明的 name/args 没了; 剥完之后形状里没有嵌套 args, 后面
// 那条代拉服务端内层列表的探测也根本够不着。改成: 查不到就两层都留着, 由执行前的双包裁决按
// 服务端那份 schema 判; 第 14 轮起, 代拉之后仍判不了的拒收并指路, 不再照旧剥一层
// (Codex P1 on #10908 第 12 轮, 4094 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数(两层都在)。
// - Bug 依据:codex 对 #10908 第 12 轮的 P1。
// - 覆盖缺口:上一轮的撞名用例里内层工具都在本地表里(schema 直接可查, 走不到代拉那条路)。
// - 最小失败输入:registry 只暴露 call_tool + 服务端 list_tools 里 run 声明 name+args
//   + 调用 {name:'run', args:{name:'run', args:{cwd}}}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('keeps both name layers when the inner schema only exists on the server', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    // registry 的内层列表: run 自己就声明 name + args 参数。
    if ((params as { name?: unknown } | undefined)?.name === 'list_tools') {
      return {
        structuredContent: {
          tools: [{
            name: 'run',
            inputSchema: {
              type: 'object',
              properties: { name: { type: 'string' }, args: { type: 'object' } },
              required: ['name', 'args'],
            },
          }],
        },
      };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  // registry 只暴露入口工具: 内层工具在自己的列表里, 本地工具表里没有。
  gateway.add('cindy_registry', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_registry', tool: 'call_tool' });
  await gateway.executeCall({
    server: 'cindy_registry', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } },
  });
  const calls = requests
    .filter(request => (request.params as { name?: unknown } | undefined)?.name === 'call_tool')
    .map(request => request.params);
  expect(calls).toEqual([
    { name: 'call_tool', arguments: { name: 'run', args: { name: 'run', args: { cwd: '/work' } } } },
  ]);
});

// 评审 P1(动态放开的字段被当成「没有 args 参数」): 内层 schema 有 properties.name 且
// additionalProperties: true —— 这份 schema 收得下自己的 args 字段, 但声明名里没有 args,
// 于是被判成「内层没有 args 参数」: 撞名的调用被剥掉一层, 规范调用反过来被判成「信封套了
// 两遍」而拒收。动态放开的字段不能当成「不存在」的证据(Codex P1 on #10908 第 12 轮, 4192 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数(两层都在)。
// - Bug 依据:codex 对 #10908 第 12 轮的 P1。
// - 覆盖缺口:上一轮的撞名用例里内层 schema 是「明确没有 args」(properties 只有 name),
//   没有「收得下但没声明」的形态。
// - 最小失败输入:内层工具 schema = {properties:{name}, additionalProperties:true}
//   + 调用 {name:'run', args:{name:'run', args:{cwd}}}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('treats dynamically accepted fields as a declared args parameter', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
    // 内层工具收得下任意字段(含 args), 但没有显式声明 args。
    { name: 'run', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: true } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } },
  });
  const calls = requests
    .filter(request => (request.params as { name?: unknown } | undefined)?.name === 'call_tool')
    .map(request => request.params);
  expect(calls).toEqual([
    { name: 'call_tool', arguments: { name: 'run', args: { name: 'run', args: { cwd: '/work' } } } },
  ]);
});

// 评审 P1(估算病态模式的工作量没封顶): patternProperties 的模式来自服务端、键来自模型, 两头都不受
// Cindy 控制。估算器对 a{199999} 这类量词逐轮相乘 —— 一个原子就是二十万次迭代, 十六条模式就是
// 上亿次; 而且超预算的模式被跳过时不记账, 每个顶层键都要把这批模式重估一遍。归一化在权限与执行
// 两条路径上同步跑它, 于是 Pi 的事件循环被卡住(Codex P1 on #10908 第 12 轮, 3872 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 在病态 schema 下按时返回(同步工作有上界)。
// - Bug 依据:codex 对 #10908 第 12 轮的 P1。
// - 覆盖缺口:上一轮的模式用例只盖了「跑得动但慢」的模式, 没有「估不出来的大量词」。
// - 最小失败输入:16 条各含 8 个 a{199999} 原子的 patternProperties + 一个未声明的顶层键。
// - tier:unit(编译网关片段 + 假 client, 无真实等待; 未修时这条要跑几秒同步估算, 故给足超时)。
it('bounds the work spent estimating pathological regex patterns', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const patterns: Record<string, unknown> = {};
  for (let index = 0; index < 16; index++) patterns['p' + index + 'a{199999}'.repeat(8)] = { type: 'string' };
  const gateway = new Gateway();
  gateway.add('cindy_big', client, [
    {
      name: 'lookup',
      inputSchema: { type: 'object', properties: { kind: { type: 'string' } }, patternProperties: patterns },
    },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_big', tool: 'lookup' });
  const started = performance.now();
  // extra_note 不在 properties 里: 每个这样的键都要问一遍「schema 收不收」, 也就是把模式估一遍。
  await gateway.executeCall({
    server: 'cindy_big', tool: 'lookup', args: { kind: 'x' }, extra_note: 'keep',
  });
  expect(performance.now() - started).toBeLessThan(1000);
  // 模式没跑成 → 判不了 → 键照常转发不丢。
  expect(requests[0].params).toEqual({ name: 'lookup', arguments: { kind: 'x', extra_note: 'keep' } });
}, 20_000);

// 数元素个数用: 每拉一个元素记一次, 用来数「判据走了多少个分支」。
class CountingArray<T> extends Array<T> {
  readonly counter = { count: 0 };
  [Symbol.iterator](): Iterator<T> {
    const inner = super[Symbol.iterator]();
    const counter = this.counter;
    return { next: () => { counter.count++; return inner.next(); } };
  }
}

// 评审 P2(属性类型判据的分支遍历没封顶): properties.name.allOf 的分支数远超 32 时, 节点预算用尽后
// 这个循环仍把剩下的分支逐个 visit 一遍 —— 32 节点的上限形同虚设, 工作量随分支总数增长。声明面
// 遍历(schemaParameterSurface)早就是这么做的: 预算用尽即停(Codex P2 on #10908 第 12 轮, 3651 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 拒收(类型证据看不完 → 表态不完整),
//   并且类型判据只走了节点预算内的分支(数分支数组被迭代了多少次)。
// - Bug 依据:codex 对 #10908 第 12 轮的 P2。
// - 覆盖缺口:类型判据的用例都在 32 节点之内, 没有「分支数远超预算」的形状。
// - 最小失败输入:properties.name 是 5 万个分支的 allOf + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('stops the property type walk at the node budget', async () => {
  const { Gateway } = loadGatewayHarness();
  const branches = new CountingArray<Record<string, unknown>>();
  for (let index = 0; index < 50_000; index++) branches.push({ type: 'null' });
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      properties: { name: { allOf: branches }, args: { type: 'object' } },
      required: ['name'],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 类型证据看不完 → 表态不完整 → 平铺调用拒收并指路。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  })).rejects.toThrow(/could not read the schema of this tool in full .* Put everything in args/);
  // 32 节点的上限是实的: 分支再多也不逐个走完(声明面遍历与类型判据同一套做法)。
  expect(branches.counter.count).toBeLessThan(1000);
  expect(requests).toHaveLength(0);
});

// 评审 P1(载荷平铺在顶层、args 容器却是空的时, 载荷判据只看容器): 模型给 args:{} 再把参数
// 平铺在顶层(status 之类)时, 容器是空的 → 载荷判据说「没有载荷」→ 信封判不了那道闸不触发,
// 于是照缺省值那一路把 {name, status} 发出去: 少了 registry 那层 args, 内层工具被按缺省值
// 调用还返回成功(Codex P1 on #10908 第 13 轮, 4201 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 拒收(信封判不了 → 指路), 一个请求都不发。
// - Bug 依据:codex 对 #10908 第 13 轮的 P1。
// - 覆盖缺口:上一轮的截断用例给的是「容器里有载荷」, 没有「容器空、载荷平铺在顶层」这一形状。
// - 最小失败输入:schema 看不全的 call_tool + args:{} + 顶层 status:"active"。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('rejects a flattened call whose payload sits beside an empty args container', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  // 根 + 600 个分支远超 512 节点预算: 信封信号看不全, 顶层 name 是信封层的内层工具名还是
  // 这个工具自己的参数, 分不清。
  const branches: Record<string, unknown>[] = Array.from({ length: 600 }, () => ({}));
  branches.push({ required: ['name'] });
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' } },
      allOf: branches,
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // args 容器是空的, 载荷平铺在顶层: 判不出来就拒收并指路, 不照发(照发就少了 args 层)。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'schedule_list', args: {}, status: 'active',
  })).rejects.toThrow(/could not read the schema of this tool in full .* Put everything in args/);
  expect(requests).toHaveLength(0);
});

// 评审 P1(内层 schema 代拉没有限定在信封工具上): 普通第三方工具的 args 容器碰巧长得像
// {name, args}(顶层 name 与 args.name 同名)时, 归一化把「要不要问服务端那份内层 schema」
// 标了出来, 权限那条路径就去打一次服务端自定的 list_tools —— 那个工具名是服务端说了算的,
// 可能带副作用, 也可能把弹框拖到整轮远端超时(Codex P1 on #10908 第 13 轮, 4179 行)。
// 归位结论本来也跟内层 schema 无关(不是信封就没有「剥不剥那一层」这回事)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 不发任何 list_tools 探测请求, 参数照原样发出。
// - Bug 依据:codex 对 #10908 第 13 轮的 P1。
// - 覆盖缺口:代拉只在「registry 信封 + 内层工具本地查不到」这一形状上盖过, 没盖过普通第三方工具。
// - 最小失败输入:第三方工具 search(name/args/query 三个参数, 不是信封) + 顶层 name 与 args.name 同名。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('does not probe the inner list of a third-party tool that is not an envelope', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  gateway.add('third_party', client, [{
    name: 'search',
    // name / args / query 三个参数: 不是 {name, args} 信封。
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' }, query: { type: 'string' } },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'third_party', tool: 'search' });
  await gateway.executeCall({
    server: 'third_party', tool: 'search', name: 'lookup', args: { name: 'lookup', args: { query: 'x' } },
  });
  // 只发这一次调用本身: 没有 list_tools 探测(那个工具名是服务端自定的, 可能带副作用)。
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'search', arguments: { name: 'lookup', args: { query: 'x' } },
  });
});

// 评审 P1(代拉判不了仍按猜测折叠): registry 只暴露 call_tool/list_tools 时, 撞名的内层工具不在
// 本地工具表里, 归一化先标「要不要问服务端那份 schema」; 但代拉回来的内层列表只有类目、没有
// 工具 schema(真实 Cindy registry 形状), 重新归一化仍判不了 —— 旧实现照旧剥一层, 等于把层数
// 猜出来: 内层工具自己声明 name + args 参数时(run 这类), 它声明的参数会被剥掉, 服务端按缺省值
// 执行还返回成功。代拉之后仍判不了就拒收并指路, 与信封判不了(indeterminateEnvelope)同一处理;
// 代拉失败不缓存, 重试同一调用会再问一次, 服务端恢复后按真实 schema 裁决(Codex P1 on #10908
// 第 14 轮, 4600 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 拒收(不发猜出来的层数), 回执点名两种读法
//   与唯一说得通的形状; 撞名消失后同一 server 的规范信封照常放行。
// - Bug 依据:codex 对 #10908 第 14 轮的 P1。
// - 覆盖缺口:第 12/13 轮只盖了「代拉能判出来」的两侧(声明 args → 两层都留 / 明确没有 → 剥),
//   旧用例把「拉不到就照旧剥一层」钉成了行为。
// - 最小失败输入:call_tool 信封 + 撞名 {name:'run', args:{name:'run', args:{cwd}}}
//   + list_tools 只回类目(无 schema)。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('rejects a same-name collision that stays unresolved after probing the inner list', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    // 真实 Cindy registry 形状: 不传 category 只有类目概览, 无工具 schema。
    if ((params as { name?: unknown } | undefined)?.name === 'list_tools') {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, categories: [{ name: 'read', tool_count: 4 }] }) }] };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  const collision = { server: 'cindy_memory', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } } };
  await expect(gateway.executeCall(collision)).rejects.toThrow(
    /cannot tell whether that inner layer .* Keep exactly one level/);
  // 只发过一次代拉(结果按 server 缓存), 没有把猜出来的层数发给服务端。
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({ name: 'list_tools', arguments: {} });
  // 缓存后同一 server 的重试不再发请求, 结论仍是拒收(不是间歇性的)。
  await expect(gateway.executeCall(collision)).rejects.toThrow(/Keep exactly one level/);
  expect(requests).toHaveLength(1);
  // 判不了 ≠ 全拦: 没有撞名的规范信封照常放行。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { name: 'architecture', type: 'project' },
  });
  expect(requests).toHaveLength(2);
});

// 同一条 P1 的另一半: 代拉请求失败(网络断/超时)同样判不了 —— 拒收; 失败不缓存, 重试会再问
// 一次, 服务端恢复后按真实 schema 裁决(内层确实没有 args → 照旧剥一层)。
it('rejects an unresolved collision on a failed probe and re-probes on retry', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  let serverUp = false;
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    if ((params as { name?: unknown } | undefined)?.name === 'list_tools') {
      if (!serverUp) throw new Error('ECONNRESET');
      return { structuredContent: { tools: [{ name: 'run', inputSchema: { type: 'object', properties: { cwd: { type: 'string' } } } }] } };
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_registry', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_registry', tool: 'call_tool' });
  const collision = { server: 'cindy_registry', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } } };
  await expect(gateway.executeCall(collision)).rejects.toThrow(/Keep exactly one level/);
  expect(requests).toHaveLength(1);
  // 失败不缓存: 重试再问一次; 服务端恢复了, 这次判据按真实 schema 定(内层没有 args → 剥一层),
  // 归位后的调用本身是第三个请求。
  serverUp = true;
  await gateway.executeCall(collision);
  expect(requests).toHaveLength(3);
  expect(requests[2].params).toEqual({
    name: 'call_tool', arguments: { name: 'run', args: { cwd: '/work' } },
  });
});

// 评审 P1(args/arguments 双容器静默丢一份): args 与 arguments 都是网关自留键, 归一化只认 args,
// 另一份既不进 shadowed 也不进 unmapped(那两个数组记参数键, 不记容器键), 回执里也没有转发出参
// 的回显 —— 两份内容不同时, 服务端按 args 执行而模型以为发的是 arguments(行 1 vs 行 10)。
// 两份解析后一致时发哪份结果都相同, 不拦; 不一致或有一份形态不可用, 整笔调用拒收
// (Codex P1 on #10908 第 14 轮, 4111 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 拒收(一个请求都不发), 回执点名
//   「只发 args、两份不一致」; 两份一致(键序不同也算一致)时照常放行。
// - Bug 依据:codex 对 #10908 第 14 轮的 P1。
// - 覆盖缺口:别名机制本身(args 缺席时认 arguments)早有用例; 双容器同时给出的形状没有。
// - 最小失败输入:{args: {row: 1}, arguments: {row: 10}}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('rejects a call that supplies both args and arguments containers', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_sheets', client, [{
    name: 'status',
    inputSchema: { type: 'object', properties: { row: { type: 'number' }, note: { type: 'string' } } },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_sheets', tool: 'status' });
  await expect(gateway.executeCall({
    server: 'cindy_sheets', tool: 'status', args: { row: 1 }, arguments: { row: 10 },
  })).rejects.toThrow(/args and arguments were both provided .* forwards args/);
  expect(requests).toHaveLength(0);
  // 一份形态不可用同样算「不一致」: 拒收, 不静默只认 args。
  await expect(gateway.executeCall({
    server: 'cindy_sheets', tool: 'status', args: { row: 1 }, arguments: null,
  })).rejects.toThrow(/args and arguments were both provided/);
  // 两份内容一致(键序不同也算一致)时发哪份都一样: 不拦。
  await gateway.executeCall({
    server: 'cindy_sheets', tool: 'status', args: { row: 1, note: 'x' }, arguments: { note: 'x', row: 1 },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({ name: 'status', arguments: { row: 1, note: 'x' } });
  // 顶层平铺键不是歧义、双容器才是: 平铺 + 双容器同样拒收。
  await expect(gateway.executeCall({
    server: 'cindy_sheets', tool: 'status', args: { row: 1 }, arguments: { row: 2 }, note: 'y',
  })).rejects.toThrow(/args and arguments were both provided/);
  expect(requests).toHaveLength(1);
});

// 评审 P2(信封判据里的枚举扫描无界): enum 值不占类型判据的 32 节点预算、也不占声明面的
// 512 名额 —— 服务端给一个上百 KB 的选择器枚举(不写 type, 全靠值定类型), 权限/执行两条
// 路径上每次类型探测都要同步扫完整个数组, 已公布的预算形同虚设。给值检查单独封顶: 前段
// 已见不容 → 确认容不下; 前段全容得下但还有剩余 → 按「看不完」记截断, 信封判据随之按
// 表态不完整走(与信封兼容的平铺调用拒收并指路)(Codex P2 on #10908 第 14 轮, 3729 行)。
//
// - 生产入口与可观察结果:超大枚举下 executeCall 即时返回; 枚举超出上限的平铺调用不再被
//   重建转发, 而是按截断政策拒收; 上限内的枚举不受影响(照常重建转发)。
// - Bug 依据:codex 对 #10908 第 14 轮的 P2。
// - 覆盖缺口:类型判据的节点预算(第 13 轮)只盖了组合分支, 没盖「单个属性拖一个巨型枚举」。
// - 最小失败输入:properties.name = {enum: [4 万个工具名字符串]}(不写 type) + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('bounds the enum scan used for envelope detection', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  const enumSchema = (count: number) => ({
    type: 'object',
    properties: { name: { enum: Array.from({ length: count }, (_, index) => 'tool_' + index) }, args: { type: 'object' } },
    required: ['name'],
  });
  gateway.add('cindy_big', client, [
    { name: 'call_tool', inputSchema: enumSchema(40_000) },
    { name: 'call_tool_small', inputSchema: enumSchema(3) },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_big', tool: 'call_tool' });
  await gateway.listResult({ server: 'cindy_big', tool: 'call_tool_small' });
  // 枚举超出上限: 类型证据看不完 → 截断 → 与信封兼容的平铺调用拒收并指路, 不重建也不照发。
  const started = performance.now();
  await expect(gateway.executeCall({
    server: 'cindy_big', tool: 'call_tool', name: 'tool_1', args: { cwd: '/work' },
  })).rejects.toThrow(/could not read the schema of this tool in full/);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(requests).toHaveLength(0);
  // 上限内的枚举不受影响: 照常认出信封、重建平铺调用并转发。
  await gateway.executeCall({
    server: 'cindy_big', tool: 'call_tool_small', name: 'tool_1', args: { cwd: '/work' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool_small', arguments: { name: 'tool_1', args: { cwd: '/work' } },
  });
});

// 评审 P2(required 数组的 includes 扫描无界): collectDeclaredNames 在 512 名额处停下并标记
// 截断, 但信封判据里 required.includes('name') 仍整段扫一遍 —— 名字名额拦住了声明面, 拦不住
// 一个上千条的 required 数组, 权限/执行两条路径上反复同步 O(required 长度)。扫描与声明面用
// 同一个上限: 前段没有 name 且数组超长 → 记截断, 信封判据按表态不完整走(Codex P2 on #10908
// 第 14 轮, 3761 行)。
//
// 这里用「重复的 required 键」把扫描上限从收集名额里剥出来: 已收过的名字不占名额
// (collectDeclaredNames), 所以整份 schema 的声明面没截断 —— 截断**只能**来自扫描封顶本身,
// 行为差异(重建转发 vs 拒收)就是封顶是否生效的直接证据。JSON Schema 校验器接受重复键。
//
// - 生产入口与可观察结果:超长 required(前段没有 name)下 executeCall 即时返回; 「name 在长尾」
//   的信封不再被认出(平铺调用按截断政策拒收); name 在上限内靠后时照常认出并重建转发。
// - Bug 依据:codex 对 #10908 第 14 轮的 P2。
// - 覆盖缺口:名字名额(512)只盖了 collectDeclaredNames, 没盖 required 的整段扫描。
// - 最小失败输入:required = ['args' × 1500, 'name'](name 在第 1500 位) + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('bounds the required-array scan used for envelope detection', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  const requiredSchema = (required: string[]) => ({
    type: 'object',
    properties: { name: { type: 'string' }, args: { type: 'object' } },
    required,
  });
  // name 排在第 1500 位、前段全是已收过的 args(不占名额): 声明面没截断, 扫描前段(512)看不到
  // name → 记截断 → 与信封兼容的平铺调用拒收并指路。
  const longRequired = Array.from({ length: 1501 }, () => 'args');
  longRequired[1500] = 'name';
  // name 在第 400 位: 上限内靠后但够得着 → 照常认出信封。
  const inCapRequired = Array.from({ length: 401 }, () => 'args');
  inCapRequired[400] = 'name';
  gateway.add('cindy_req', client, [
    { name: 'call_tool', inputSchema: requiredSchema(longRequired) },
    { name: 'call_tool_incap', inputSchema: requiredSchema(inCapRequired) },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_req', tool: 'call_tool' });
  await gateway.listResult({ server: 'cindy_req', tool: 'call_tool_incap' });
  const started = performance.now();
  await expect(gateway.executeCall({
    server: 'cindy_req', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  })).rejects.toThrow(/could not read the schema of this tool in full/);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(requests).toHaveLength(0);
  // required 在上限内、name 靠后但够得着: 照常认出信封、重建平铺调用并转发。
  await gateway.executeCall({
    server: 'cindy_req', tool: 'call_tool_incap', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool_incap', arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(信封只有一半: 顶层给了 name 和 args 容器, 但顶层还散落着内层参数):
// {name:'schedule_list', args:{}, status:'active'} —— flattenedEnvelope 认出来要重建
// {name, args}, 但 flattenedEnvelopeNoContainer 是 false, status 仍按外层信封 schema
// 判 → unmapped, 发出的 {name:'schedule_list', args:{}} 让内层工具按缺省过滤执行
// (列出全部而不是 active)。信封兄弟键按外层 schema 判是错的: 它们属于内层工具,
// 与 flattenedEnvelopeNoContainer 同一处理 —— 整体收进内层 args(Codex P1 on #10908
// 第 15 轮, 4335 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 15 轮的 P1。
// - 覆盖缺口:信封平铺只盖了「完全摊平」和「完全嵌套」两种形态, 半平铺(顶层有
//   name + args 容器 + 兄弟键)漏了。
// - 最小失败输入:信封 + 顶层 name + 顶层 args:{} + 顶层兄弟键 status。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('folds flat siblings into the args container when an envelope is rebuilt', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_scheduler', client, [{
    name: 'call_tool',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_scheduler', tool: 'call_tool' });
  // 顶层 name 是信封层选择器, args:{} 是空容器, status 是内层工具参数 —— 全部收进
  // 内层 args, 发出的 {name:'schedule_list', args:{status:'active'}} 才是正确的那一份。
  await gateway.executeCall({
    server: 'cindy_scheduler', tool: 'call_tool', name: 'schedule_list', args: {}, status: 'active',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'schedule_list', args: { status: 'active' } },
  });
});

// 评审 P1($dynamicRef 被静默跳过): 2020-12 的 $dynamicRef 本地能解析(指向本 schema
// 里的 $dynamicAnchor), 但旧 walker 只认 $ref, 遇到 $dynamicRef 既不跟也不记截断,
// surface 看起来完整普通 → 信封判据按普通工具走, 平铺调用按外层 schema 丢参数。
// 本地能解析的动态引用照常跟(声明能看到), 解析不了的记截断(Codex P1 on #10908
// 第 15 轮, 3612 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 15 轮的 P1。
// - 覆盖缺口:引用只盖了 $ref(静态), $dynamicRef / $dynamicAnchor 没有。
// - 最小失败输入:$defs.env = {properties:{name,args},required:['name']}, $dynamicRef:'#/defs/env'。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('follows local $dynamicRef references when building the surface', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    // 2020-12: 信封声明藏在 $dynamicRef 指向的 $defs 里。
    inputSchema: {
      type: 'object',
      $defs: { env: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
      $dynamicRef: '#/$defs/env',
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 顶层 name 是信封层选择器: 认出信封、重建平铺调用并转发。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(anyOf:[false,envelope] 被判成普通工具): anyOf 的每个分支另起一组,
// false 分支(永远选不中)起一个零信号组, every 见零信号就把「每条路径都必填 name」
// 判成 false → surface.envelope=false → 真信封按普通工具判, 平铺调用按外层 schema
// 丢参数。永不可行的分支不参与「每条路径」判定(Codex P1 on #10908 第 15 轮, 3645 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 15 轮的 P1。
// - 覆盖缺口:组合分支只盖了 allOf/anyOf/oneOf 的合取, 没盖布尔分支。
// - 最小失败输入:anyOf:[false, {properties:{name,args},required:['name']}]。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('skips impossible boolean alternatives when detecting envelopes', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    // 恒假分支 + 真信封分支: false 永远选不中, 不该把「每条路径都必填 name」判成 false。
    inputSchema: {
      type: 'object',
      anyOf: [
        false,
        { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
      ],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 顶层 name 是信封层选择器: 认出信封、重建平铺调用并转发。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P2(模式不用 Unicode 标志 → 星号位键被误判): JSON Schema 的 ECMA-262 语义是
// Unicode 模式: `^.$` 对一个码点的星号位字符(😀)算一个字符、匹配; 无 u 标志的 JS
// 正则把它当两个 UTF-16 单元、不匹配 → `schemaKeyStatus` 返回 'rejected', 平铺的
// 动态参数被丢。pattern 要用 u 模式跑, 与服务端一致(Codex P2 on #10908 第 15 轮,
// 4121 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数(键
//   照常折进 args, 不被丢)。
// - Bug 依据:codex 对 #10908 第 15 轮的 P2。
// - 覆盖缺口:模式键都是 ASCII, 没盖星号位字符。
// - 最小失败输入:closed schema + patternProperties {'^.$': {type:'string'}} + 顶层键 '😀'。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('evaluates pattern properties against keys in Unicode mode', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_emoji', client, [{
    name: 'tag',
    // closed schema: 只声明 file_id, 加一个只收「一个码点」的模式。'😀' 在 Unicode 语义下
    // 是一个字符、命中; 无 u 标志是 2 个 UTF-16 单元、不命中。
    inputSchema: {
      type: 'object',
      properties: { file_id: { type: 'string' } },
      required: ['file_id'],
      patternProperties: { '^.$': { type: 'string' } },
      additionalProperties: false,
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_emoji', tool: 'tag' });
  // 星号位键在 Unicode 语义下命中 '^.$' → 是声明过的动态参数, 折进 args 转发, 不丢。
  await gateway.executeCall({
    server: 'cindy_emoji', tool: 'tag', args: { file_id: 'doc-1' }, '😀': 'one code point',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'tag',
    arguments: { file_id: 'doc-1', '😀': 'one code point' },
  });
});

// 评审 P1(属性级 $dynamicRef 看不到类型): properties.name 的字符串类型写在 $dynamicRef
// 指向的 $dynamicAnchor 里, 根层能看到声明但属性级的类型证据看不到 —— 旧 propertyAdmitsType
// 只认 $ref, 遇到 $dynamicRef 既不跟也不记 exhausted, surface 看起来完整普通, 平铺调用按
// 外层 schema 判 → 信封判成普通工具, 内层参数被丢。属性级 $dynamicRef 与根层同一处理
// (Codex P1 on #10908 第 16 轮, 3747 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 16 轮的 P1。
// - 覆盖缺口:$dynamicRef 只盖了根层, 属性级($ref 指向 $defs 里的字符串类型)漏了。
// - 最小失败输入:properties.name = {$dynamicRef:'#/$defs/str'}($defs.str = {type:'string'})。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('follows local $dynamicRef when probing a property type', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    // name 的 string 类型藏在 $dynamicRef 指向的 $defs 里: 属性级 $dynamicRef 看不到类型,
    // 属性判据 exhausted → surface 按不完整处理, 与信封兼容的平铺调用拒收并指路。
    inputSchema: {
      type: 'object',
      properties: {
        name: { $dynamicRef: '#/$defs/str' },
        args: { type: 'object' },
      },
      required: ['name'],
      $defs: { str: { type: 'string' } },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // $dynamicRef 指向的 type:'string' 能看到 → 照常认出信封、重建平铺调用并转发。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(条件分支的 required 证据不传播): 信封把 required:['name'] 写在 if/then/else
// 的两个分支里 —— 同一次调用只落进一条, 但两条都声明了 name 必填, 沿这条路径 name
// 就必填。旧 walk 把 if/then/else 各自另起一组、接在出发点后面, 但没把它们记成
// 出发点的「alternatives」—— settleEnvelope 的 every 看不到分支组, root 的 name 仍被
// 判成可选, 信封被降级成普通工具, 平铺调用按外层 schema 丢参数。条件分支与
// anyOf/oneOf 同一处理: 每条分支另起一组并记进 alternatives(Codex P1 on #10908 第 16 轮,
// 3663 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 16 轮的 P1。
// - 覆盖缺口:条件分支只盖了「单条件分支」, 没盖「then/else 都必填 name」的互斥对。
// - 最小失败输入:{properties:{name,args}, if:{required:['name']}, else:{required:['name']}}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('propagates required evidence across conditional alternatives', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    // required 在 then/else 两个分支里都声明: 沿任意一条路径 name 都必填 → 是信封。
    // 'if' 只是条件(它本身不约束实例), 不参与「每条路径都必填」的判定。
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, args: { type: 'object' } },
      if: { required: ['args'] },
      then: { required: ['name'] },
      else: { required: ['name'] },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 条件分支的两条路径都必填 name → 认出信封、重建平铺调用并转发。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(共享分支的子结构被缓存吞掉): 两条 anyOf 分支都 $ref 到同一个 $defs, 那个 $defs
// 内部又有一个 anyOf(分支各自声明 required:['name'])。第一次 walk 把 $defs 里的 anyOf 记进
// closure(只存合取信号); 第二次 walk 直接复用 closure, $defs 内部的 anyOf 分支结构没挂到
// 第二条分支路径的组上 —— 第二条路径看不到「沿它必填 name」, every 判成可选, 信封被降级
// 成普通工具(Codex P1 on #10908 第 16 轮, 3539 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 16 轮的 P1。
// - 覆盖缺口:$ref 复用只盖了「静态 $ref」, 没盖「$ref 里还有分支结构」的共享引用。
// - 最小失败输入:$defs.env = {anyOf:[{properties:{name,args},required:['name']}, {type:'object'}]},
//   anyOf:[{$ref:'#/$defs/env'}, {$ref:'#/$defs/env'}]。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('replays branch-sensitive evidence for shared referenced schemas', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    // 两条分支都引用同一个 $defs; $defs 内部有 anyOf(分支各自声明 required:['name'])。
    // 第一次 walk 把内部的 anyOf 记进第一条路径的组; 第二次复用 closure 时, 第二条路径
    // 也要能看到「沿这条路径必填 name」。
    inputSchema: {
      type: 'object',
      $defs: {
        env: {
          anyOf: [
            { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
            { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
          ],
        },
      },
      anyOf: [{ $ref: '#/$defs/env' }, { $ref: '#/$defs/env' }],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 两条分支路径都指向同一个含分支的 $defs: 每条路径都能看到「沿它必填 name」→ 认出
  // 信封、重建平铺调用并转发。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(零属性纯动态 schema 被当成「没有 args」): 内层工具在本地表里的 schema 是
// {type:'object', additionalProperties:true} —— 声明面没 properties, 但额外字段不限, 收得下
// 自己的 args 字段。旧 schemaDeclaresArgs 在「没声明 properties」处提前 return null,
// additionalAllowed 判定够不着 → 撞名裁决把「没声明 args」当成「没有 args」的证据,
// 剥掉内层工具的参数层(Codex P1 on #10908 第 16 轮, 4397 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数(两层都在)。
// - Bug 依据:codex 对 #10908 第 16 轮的 P1。
// - 覆盖缺口:动态放开只盖了「有 properties + additionalProperties」, 没盖「零 properties」。
// - 最小失败输入:内层工具 schema = {type:'object', additionalProperties:true} + 撞名调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('treats a zero-property dynamic schema as declaring args', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
    // 内层工具零属性纯动态 schema: 收得下自己的 args 字段, 撞名时不剥它的参数层。
    { name: 'run', inputSchema: { type: 'object', additionalProperties: true } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  // 撞名的内层工具(run)收得下自己的 args 字段(零属性纯动态 schema): 不剥层, 两层都在。
  await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'run', args: { name: 'run', args: { cwd: '/work' } } },
  });
});

// 评审 P1(selector === entry name 无条件剥层): 第三方 registry 的 entry 工具(如 call_tool)
// 内层也叫 call_tool, 顶层 selector 与 entry name 相同时, args 容器里又是个 {name, args}
// 形状 —— 它可能是「同一个选择器写了两遍」(剥一层), 也可能是「entry 内层就是另一个同名
// 工具」(保留两层)。以前 selector===tool.name 无条件按「重复信封」剥一层, 内层工具的
// name/args 参数被剥掉、发错层(Codex P1 on #10908 第 16 轮, 4292 行)。现在按同一判据:
// 只有 params.name === selector 且内层确实没有 args 才剥; 内层工具本地查不到、判不了时
// 代拉一次内层列表再判。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数(两层都在)。
// - Bug 依据:codex 对 #10908 第 16 轮的 P1。
// - 覆盖缺口:撞名只盖了「顶层选择器与容器 name 同名」, 没盖「选择器与 entry 名同名」。
// - 最小失败输入:entry=call_tool + selector=call_tool + 内层工具 call_tool 声明 name+args。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('keeps a selector that matches the entry name when the inner tool declares args', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    // registry 的内层列表: 内层 call_tool 自己声明 name + args 参数。
    if ((params as { name?: unknown } | undefined)?.name === 'list_tools') {
      return { structuredContent: { tools: [{ name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name', 'args'] } }] } };
    }
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_registry', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_registry', tool: 'call_tool' });
  // 顶层选择器就是入口工具自己, 容器里的 name 是内层同名工具自己的参数(不是重复信封):
  // 入口内层那个 call_tool 声明了 name + args → 两层都留, 不剥。
  await gateway.executeCall({
    server: 'cindy_registry', tool: 'call_tool', name: 'call_tool', args: { name: 'memory_write', args: { type: 'project' } },
  });
  // 代拉过一次内层列表 + 转发一次 = 2 个请求。
  expect(requests).toHaveLength(2);
  expect(requests[0].params).toEqual({ name: 'list_tools', arguments: {} });
  expect(requests[1].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'call_tool', args: { name: 'memory_write', args: { type: 'project' } } },
  });
});

// 评审 P1(嵌套信封旁的兄弟键丢): {args:{name:'schedule_list', args:{}}, status:'active'} ——
// 已经是嵌套信封但顶层散落着内层参数, 没有顶层选择器 → flattenedEnvelope 与
// flattenedEnvelopeNoContainer 都是 false, status 仍按外层信封 schema 判 → unmapped 丢掉,
// 发出的 {name:'schedule_list', args:{}} 让内层工具按缺省过滤执行。兄弟键收进嵌套的
// args 层, 与「半平铺信封兄弟键」同一处理(Codex P1 on #10908 第 16 轮, 4346 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数与回执。
// - Bug 依据:codex 对 #10908 第 16 轮的 P1。
// - 覆盖缺口:兄弟键收进内层 args 只盖了「半平铺信封」, 没盖「已是嵌套信封 + 顶层兄弟键」。
// - 最小失败输入:{args:{name:'schedule_list',args:{}}, status:'active'}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('folds siblings into a nested envelope that is already complete', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_scheduler', client, [{
    name: 'call_tool',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_scheduler', tool: 'call_tool' });
  // args 容器里已有 {name,args} 两层, 顶层 status 是内层工具参数 —— 收进嵌套 args 层。
  const result = await gateway.executeCall({
    server: 'cindy_scheduler', tool: 'call_tool',
    args: { name: 'schedule_list', args: {} }, status: 'active',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'schedule_list', args: { status: 'active' } },
  });
  // 归一化确实动过手: 回执里点名收进内层 args 的键。
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Cindy moved these top-level parameters into the inner args');
});

// 评审 P2(恒假分支不占预算): anyOf/oneOf 的 false 分支被跳过(零信号但不占位), 旧实现
// 不消耗节点预算 —— 服务端给一个上千个 false 的巨型数组, 每次 surface 重建都要同步扫完
// 整个数组, 512 节点上限形同虚设。恒假分支照占预算(Codex P2 on #10908 第 16 轮, 3654 行)。
//
// - 生产入口与可观察结果:全是 false 的巨型 anyOf 数组下 executeCall 即时返回; 一个真
//   信封混在 false 分支里时照常认出并重建平铺调用。
// - Bug 依据:codex 对 #10908 第 16 轮的 P2。
// - 覆盖缺口:anyOf 只盖了「恒假分支跳过」, 没盖「预算仍记账」。
// - 最小失败输入:anyOf = [false × 2000, {envelope}] + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('counts impossible alternatives against the schema walk budget', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    // 2000 个 false 分支 + 一个真信封分支: 恒假分支照占预算, 走到真信封前就截断 → 与信封
    // 兼容的平铺调用按截断政策拒收, 不整段扫完数组。
    inputSchema: {
      type: 'object',
      anyOf: [
        ...Array.from({ length: 2000 }, () => false),
        { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
      ],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  const started = performance.now();
  // 预算在 false 分支上耗尽 → 表面截断 → 与信封兼容的平铺调用拒收并指路, 不整段扫完。
  await expect(gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' },
  })).rejects.toThrow(/could not read the schema of this tool in full/);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(requests).toHaveLength(0);
});

// 评审 P1(嵌套信封旁的同名散键盖掉内层): {args:{name:'schedule_list',args:{status:'inactive'}}, status:'active'}
// —— 兄弟键收进嵌套 args 层时直接覆盖: 内层 args 里已有的 status('inactive')被顶层的
// status('active')盖掉。内层那一层就是内层工具自己的参数, 顶层散键是同一参数的重复给法,
// 与顶层的「同名以 args 为准」同一口径: 内层为准, 顶层那份记进 shadowed 并点名
// (Codex P1 on #10908 第 17 轮, 4473 行)。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数与回执。
// - Bug 依据:codex 对 #10908 第 17 轮的 P1。
// - 覆盖缺口:上一轮只盖了「内层 args 没有同名键」的收纳, 没盖「内层已有同名键」时的裁决。
// - 最小失败输入:{args:{name:'schedule_list',args:{status:'inactive'}}, status:'active'}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('lets the nested inner args win over a same-named flat sibling', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_scheduler', client, [{
    name: 'call_tool',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_scheduler', tool: 'call_tool' });
  // 内层 args 里已有 status('inactive'): 顶层同名的散键让位, 不盖掉内层那层。
  const result = await gateway.executeCall({
    server: 'cindy_scheduler', tool: 'call_tool',
    args: { name: 'schedule_list', args: { status: 'inactive' } }, status: 'active',
  });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'schedule_list', args: { status: 'inactive' } },
  });
  // 顶层那份没有采用, 回执里点名, 模型能看出服务端按内层那个值执行。
  const note = result.content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('(args wins): status.');
  // 内层 args 里没有同名键时照旧收纳(上一轮的行为不变)。
  await gateway.executeCall({
    server: 'cindy_scheduler', tool: 'call_tool',
    args: { name: 'schedule_list', args: {} }, status: 'active',
  });
  expect(requests[1].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'schedule_list', args: { status: 'active' } },
  });
});

// 评审 P1(内层工具在本地但 schema 判不了时不再剥层): 内层工具本地就有, 但它的 schema 是
// 宽松形状({type:'object'}, 无 properties 也未放开额外字段)—— schemaDeclaresArgs 只能给出
// null(判不了)。旧判据 innerTool === null 只在「查不到」时才标 pending, 查到了就跳过代拉;
// 剥层判据又把 null 当「没有」, 同一个选择器写了两遍的调用被剥掉一层, 内层工具自己的参数层
// 丢失、按缺省值执行还返回成功(Codex P1 on #10908 第 17 轮, 4383 行)。现在查到但判不了
// 同样算「判不出来」: 先按两层都留, 标 pending 代拉服务端那份内层 schema, 代拉后仍判不了
// 就拒收并指路。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 拒收并指路, 且发过一次内层列表代拉。
// - Bug 依据:codex 对 #10908 第 17 轮的 P1。
// - 覆盖缺口:pending 只盖了「内层工具本地查不到」, 没盖「查到了但 schema 判不了」。
// - 最小失败输入:内层 run 的 schema = {type:'object'} + {name:'run', args:{name:'run', args:{cwd}}}。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('probes the server list when the local inner schema cannot decide a repeated envelope', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    // 内层列表给不出(不是合法 JSON): 代拉之后仍判不了。
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_registry', client, [
    { name: 'call_tool', inputSchema: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] } },
    // 内层工具本地就在, 但 schema 太宽: 判不了它有没有 args 参数。
    { name: 'run', inputSchema: { type: 'object' } },
  ]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_registry', tool: 'call_tool' });
  // 同一个选择器写了两遍 + 内层 schema 判不了: 不猜层数, 拒收并指路。
  await expect(gateway.executeCall({
    server: 'cindy_registry', tool: 'call_tool', name: 'run', args: { name: 'run', args: { cwd: '/work' } },
  })).rejects.toThrow(/Keep exactly one level/);
  // 判据不定层时先代拉了一次服务端内层列表。
  expect(requests.some(r => (r.params as { name?: unknown } | undefined)?.name === 'list_tools')).toBe(true);
  // 拒收发生在发出任何 tools/call 之前: 服务端没有收到这次调用。
  expect(requests.filter(r => (r.params as { name?: unknown } | undefined)?.name === 'call_tool')).toHaveLength(0);
});

// 评审 P1(静态可判的条件分支仍按两条路径算): if: true 时 JSON Schema 恒选 then, else 永远
// 走不到 —— 旧实现把 then/else 都登记成候选路径, else 没要求 name, 「每条路径都必填」不成立,
// 信封判不出来, 平铺调用的 args 层被拆掉(Codex P1 on #10908 第 17 轮, 3738 行)。if 静态
// 可判(恒成立: true / 无约束空对象; 恒不成立: false / not 空约束)时只认选中的那条:
// 走不到的分支不收名字也不参与判定, 选中的那条按合取边并进当前组。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 17 轮的 P1。
// - 覆盖缺口:条件分支只盖了「then/else 都可能被选中」的传播, 没盖「if 静态可判」。
// - 最小失败输入:inputSchema = {if:true, then:{name,args + required:['name']}, else:{properties:{foo}}} + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('honors a statically decided conditional when detecting the envelope', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      // if: true 恒成立 → then 无条件生效, else 走不到(它声明的 foo 也永远不会出现)。
      if: true,
      then: { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
      else: { type: 'object', properties: { foo: { type: 'string' } } },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.executeCall({ server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' } });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
  const note = (await gateway.executeCall({
    server: 'cindy_memory', tool: 'call_tool', name: 'schedule_list', args: { status: 'active' },
  })).content.map(block => block.text ?? '').join('\n');
  expect(note).toContain('Cindy rebuilt the {"name", "args"} envelope from the flattened call before forwarding.');
});

// 评审 P1(对象形态的恒假分支仍占位): 恒假不只字面量 false —— not 一个空约束(空对象)对
// 任何实例都不成立。旧判据只认 branch === false, 对象形态的恒假分支照常成组, 零信号被当成
// 「这条路径没要求 name」的证据, 「每条路径都必填」不成立, 平铺调用的 args 层被拆掉
// (Codex P1 on #10908 第 17 轮, 3709 行)。对象形态与字面量 false 同一处理: 跳过不占位。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 17 轮的 P1。
// - 覆盖缺口:恒假分支只盖了字面量 false, 没盖对象形态。
// - 最小失败输入:anyOf = [{not:{}}, {信封}] + 平铺调用。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('skips object-form always-false alternatives when detecting envelopes', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      anyOf: [
        // not 一个空约束: 空 schema 匹配一切, not 它就什么都不匹配 —— 恒假, 与 false 同待。
        { not: {} },
        { type: 'object', properties: { name: { type: 'string' }, args: { type: 'object' } }, required: ['name'] },
      ],
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.executeCall({ server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' } });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});

// 评审 P1(重放丢掉引用后面的分支): 并集分支是引用包装层({$ref: ...})时, 包装层自己没有
// 组合, 分支在被引用的文档里。上一轮的重放只把目标自己的组合登记到这条路径上 —— 引用后面
// 的分支结构全被丢掉, 目标缓存的合取位又是零(必填证据在被引用文档的分支里, 不在合取位上),
// 这条路径就成了「没要求 name」的证据, 信封判不出来, 平铺调用的 args 层被拆掉(Codex P1 on
// #10908 第 17 轮, 3572 行)。重放要顺着 $ref / $dynamicRef 走到被引用文档再登记分支。
//
// - 生产入口与可观察结果:CindyMcpGateway.executeCall 真正发出的 tools/call 参数。
// - Bug 依据:codex 对 #10908 第 17 轮的 P1。
// - 覆盖缺口:上一轮的重放只盖了「目标自己带分支」, 没盖「目标是个引用包装层」。
// - 最小失败输入:并集分支引用 $defs.A;A 的并集分支引用 $defs.B;B 的并集两支都要求 name。
// - tier:unit(编译网关片段 + 假 client, 无真实等待)。
it('replays branch evidence through referenced wrappers', async () => {
  const { Gateway } = loadGatewayHarness();
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = { request: async (method: string, params: unknown) => {
    requests.push({ method, params });
    return { content: [{ type: 'text', text: 'TAGGED' }] };
  } };
  const gateway = new Gateway();
  const envelopeBranch = (via: string) => ({
    type: 'object',
    properties: { name: { type: 'string' }, args: { type: 'object', properties: { via: { type: 'string', const: via } } } },
    required: ['name'],
  });
  gateway.add('cindy_memory', client, [{
    name: 'call_tool',
    inputSchema: {
      type: 'object',
      // 两条外层分支引用同一份共享定义 A; A 的并集分支各自引用第二份共享定义 B;
      // 只有 B 的嵌套并集(两支都要求 name)给出必填证据。包装层自己没有组合。
      anyOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/A' }],
      $defs: {
        A: { anyOf: [{ $ref: '#/$defs/B' }, { $ref: '#/$defs/B' }] },
        B: { anyOf: [envelopeBranch('first'), envelopeBranch('second')] },
      },
    },
  }]);
  gateway.register({ registerTool: () => undefined });
  await gateway.listResult({ server: 'cindy_memory', tool: 'call_tool' });
  await gateway.executeCall({ server: 'cindy_memory', tool: 'call_tool', name: 'memory_write', args: { type: 'project' } });
  expect(requests).toHaveLength(1);
  expect(requests[0].params).toEqual({
    name: 'call_tool',
    arguments: { name: 'memory_write', args: { type: 'project' } },
  });
});
