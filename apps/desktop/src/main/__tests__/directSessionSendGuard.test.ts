import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const mainRoot = path.join(desktopRoot, 'src', 'main');
const orcaWorkflowSrcRoot = path.join(repoRoot, 'packages', 'orca-workflow', 'src');
const makerCoreSessionPath = normalizePath(path.join(repoRoot, 'packages', 'maker-core', 'src', 'session.ts'));
const makerCoreSessionFixturePath = normalizePath(path.join(
  desktopRoot,
  'src',
  'main',
  '__tests__',
  'maker-core-session.fixture.d.ts',
));
const ambientModulesFixturePath = normalizePath(path.join(
  desktopRoot,
  'src',
  'main',
  '__tests__',
  'direct-send-ambient-modules.fixture.d.ts',
));

interface SendViolation {
  filePath: string;
  relativePath: string;
  line: number;
  functionName: string;
  category: string;
}

describe('direct Session.send guard', () => {
  it('flags fixture patterns that ignore maker-core Session.send outcomes', () => {
    const source = `
      import type { Session } from '@cindy/maker-core';
      import { assertSendDispatched, toSessionDispatchOutcome } from '@cindy/maker-core';

      declare const session: Session;
      declare const webContents: { send(channel: string, payload?: unknown): void };
      declare const socket: { send(data: string): void };
      declare function observeFireAndForgetSendOutcome(
        promise: ReturnType<Session['send']>,
        meta: { owner: string; entrypoint: string; action: string; context: string },
      ): void;

      async function nakedAwait() {
        await session.send({ type: 'user', content: 'hello' });
      }

      async function awaitedNotConsumed() {
        const result = await session.send({ type: 'user', content: 'hello' });
        return result;
      }

      async function promiseAllIgnored() {
        await Promise.all([session.send({ type: 'user', content: 'hello' })]);
      }

      function returnedDirectly() {
        return session.send({ type: 'user', content: 'hello' });
      }

      function thenWithoutInspection() {
        session.send({ type: 'user', content: 'hello' }).then(() => undefined);
      }

      function voidedDirectly() {
        void session.send({ type: 'user', content: 'hello' });
      }

      async function allowedAssert() {
        const result = await session.send({ type: 'user', content: 'hello' });
        assertSendDispatched(result, 'fixture/assert');
      }

      async function allowedConvert() {
        const result = await session.send({ type: 'user', content: 'hello' });
        return toSessionDispatchOutcome(result, 'fixture/convert');
      }

      function allowedFireAndForget() {
        observeFireAndForgetSendOutcome(session.send({ type: 'user', content: 'hello' }), {
          owner: 'fixture',
          entrypoint: 'fixture',
          action: 'ready',
          context: 'fixture/ready',
        });
      }

      function ignoredNonMakerSends() {
        webContents.send('maker:event', {});
        socket.send('hello');
      }
    `;

    const program = createProgramWithSources(new Map([
      [path.join(desktopRoot, 'src', 'main', '__tests__', 'direct-send-fixture.ts'), source],
    ]));
    const violations = findDirectSendViolations(program);

    expect(violations.map((violation) => violation.functionName).sort()).toEqual([
      'awaitedNotConsumed',
      'nakedAwait',
      'promiseAllIgnored',
      'returnedDirectly',
      'thenWithoutInspection',
      'voidedDirectly',
    ]);
  });

  it('fails closed if the Program cannot provide a type checker', () => {
    const program = {
      getTypeChecker: () => {
        throw new Error('type checker unavailable');
      },
      getSourceFiles: () => [],
    } as unknown as ts.Program;

    expect(() => findDirectSendViolations(program)).toThrow(
      /direct Session\.send guard cannot build TypeScript type checker/,
    );
  });

  it('covers orca-workflow runtime source that can send sessions', () => {
    const coveredFiles = collectRuntimeSessionSendGuardFiles().map((filePath) => toRepoRelativePath(filePath));

    expect(coveredFiles).toContain('packages/orca-workflow/src/orca-bridge-mcp.ts');
  });

  it('has no unexpected direct Session.send outcome gaps in runtime code', () => {
    const program = createProgramWithSources(new Map(), collectRuntimeSessionSendGuardFiles());
    const violations = findDirectSendViolations(program);

    expect(violations).toEqual([]);
  }, 15_000);
});

function findDirectSendViolations(program: ts.Program): SendViolation[] {
  let checker: ts.TypeChecker;
  try {
    checker = program.getTypeChecker();
  } catch (err) {
    throw new Error(
      `direct Session.send guard cannot build TypeScript type checker: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
  if (!checker) {
    throw new Error('direct Session.send guard cannot build TypeScript type checker');
  }

  const violations: SendViolation[] = [];
  for (const sourceFile of program.getSourceFiles()) {
    const filePath = normalizePath(sourceFile.fileName);
    if (filePath.includes('/node_modules/') || filePath.endsWith('.d.ts')) continue;
    if (!isFixtureFile(filePath) && !isRuntimeSessionSendGuardFile(filePath)) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isMakerSessionSendCall(node, checker)) {
        const category = classifySendConsumption(node);
        if (category !== 'allowed') {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            filePath,
            relativePath: toRepoRelativePath(filePath),
            line: line + 1,
            functionName: findEnclosingFunctionName(node),
            category,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return violations;
}

function isMakerSessionSendCall(node: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const methodName = node.expression.name.text;
  if (methodName !== 'send' && methodName !== 'sendHostTurnContinuation') return false;
  const receiverType = checker.getTypeAtLocation(node.expression.expression);
  const sendSymbol = receiverType.getProperty(methodName) ?? checker.getSymbolAtLocation(node.expression.name);
  const declarations = sendSymbol?.getDeclarations() ?? [];
  return declarations.some((declaration) => {
    const sourceFile = normalizePath(declaration.getSourceFile().fileName);
    if (!isMakerCoreSessionDeclarationFile(sourceFile)) return false;
    return ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration);
  });
}

function isMakerCoreSessionDeclarationFile(filePath: string): boolean {
  return filePath === makerCoreSessionPath || filePath === makerCoreSessionFixturePath;
}

function classifySendConsumption(node: ts.CallExpression): 'allowed' | string {
  if (isArgumentToAllowedFireAndForgetObserver(node)) return 'allowed';

  const awaitExpression = findAncestor(node, ts.isAwaitExpression);
  if (!awaitExpression) {
    if (findAncestor(node, ts.isReturnStatement)) return 'returned-directly';
    if (findAncestor(node, ts.isVoidExpression)) return 'voided-directly';
    if (findAncestor(node, isPromiseAllCall)) return 'promise-all';
    if (findAncestor(node, isThenCall)) return 'then-without-outcome';
    return 'unawaited';
  }

  const bindingName = extractAwaitBindingName(awaitExpression);
  if (!bindingName) return 'awaited-without-binding';
  return isBindingConsumedInSameScope(awaitExpression, bindingName) ? 'allowed' : 'awaited-binding-not-consumed';
}

function isArgumentToAllowedFireAndForgetObserver(node: ts.CallExpression): boolean {
  const parent = node.parent;
  if (!parent || !ts.isCallExpression(parent)) return false;
  if (parent.arguments[0] !== node) return false;
  return isIdentifierNamed(parent.expression, 'observeFireAndForgetSendOutcome');
}

function extractAwaitBindingName(awaitExpression: ts.AwaitExpression): string | null {
  const parent = awaitExpression.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (
    ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && ts.isIdentifier(parent.left)
  ) {
    return parent.left.text;
  }
  return null;
}

function isBindingConsumedInSameScope(awaitExpression: ts.AwaitExpression, bindingName: string): boolean {
  const statement = findAncestor(awaitExpression, ts.isStatement);
  if (!statement) return false;
  const statementList = getSiblingStatements(statement);
  if (!statementList) return false;
  const startIndex = statementList.indexOf(statement);
  if (startIndex < 0) return false;
  for (const sibling of statementList.slice(startIndex + 1)) {
    if (containsAllowedOutcomeConsumption(sibling, bindingName)) return true;
  }
  return false;
}

function containsAllowedOutcomeConsumption(node: ts.Node, bindingName: string): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(child) && isAllowedOutcomeConsumer(child, bindingName)) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function isAllowedOutcomeConsumer(node: ts.CallExpression, bindingName: string): boolean {
  const allowedConsumers = new Set([
    'assertSendDispatched',
    'assertDesktopSendDispatched',
    'toSessionDispatchOutcome',
    'toDesktopSessionDispatchOutcome',
  ]);
  const callee = node.expression;
  if (!ts.isIdentifier(callee) || !allowedConsumers.has(callee.text)) return false;
  const firstArg = node.arguments[0];
  return !!firstArg && ts.isIdentifier(firstArg) && firstArg.text === bindingName;
}

function getSiblingStatements(statement: ts.Statement): ts.Statement[] | null {
  const parent = statement.parent;
  if (ts.isBlock(parent) || ts.isSourceFile(parent)) return [...parent.statements];
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return [...parent.statements];
  return null;
}

function isPromiseAllCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && isIdentifierNamed(node.expression.expression, 'Promise')
    && node.expression.name.text === 'all';
}

function isThenCall(node: ts.Node): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.name.text === 'then';
}

function findAncestor<T extends ts.Node>(
  node: ts.Node,
  predicate: (candidate: ts.Node) => candidate is T,
): T | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

function findEnclosingFunctionName(node: ts.Node): string {
  let current: ts.Node | undefined = node;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) && current.name) {
      return current.name.text;
    }
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current)) {
      if (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name)) return current.name.text;
    }
    if (ts.isArrowFunction(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
      if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
    }
    current = current.parent;
  }
  return '<top-level>';
}

function createProgramWithSources(
  sources: Map<string, string>,
  rootNames = [...sources.keys()],
): ts.Program {
  const normalizedSources = new Map(
    [...sources.entries()].map(([filePath, source]) => [normalizePath(filePath), source]),
  );
  const files = new Map<string, string>([
    ...normalizedSources,
    [makerCoreSessionFixturePath, `
      declare module '@cindy/maker-core' {
        export type AgentEvent = unknown;
        export type AgentKind = 'cc' | 'claude-code' | 'codex' | string;
        export type SessionSendResult =
          | { accepted: true }
          | { accepted: false; reason: string };
        export type SessionDispatchOutcome =
          | { dispatched: true }
          | { dispatched: false; reason: string; message?: string; context?: string };

        export interface Logger {
          debug?(message: string, fields?: Record<string, unknown>): void;
          info?(message: string, fields?: Record<string, unknown>): void;
          warn?(message: string, fields?: Record<string, unknown>): void;
          error?(message: string, fields?: Record<string, unknown>): void;
        }

        export interface Session {
          id: string;
          agentKind: AgentKind;
          send(message: unknown, options?: unknown): Promise<SessionSendResult>;
        }

        export interface Maker {
          getSession(sessionId: string): Session | null;
          createSession(options: unknown): Promise<Session>;
        }

        export interface McpProvider {
          name: string;
        }

        export interface McpProviderContext {
          vendorOptions?: Record<string, unknown>;
          getSessionContext?: () => McpProviderContext;
        }

        export declare function assertSendDispatched(result: SessionSendResult, context: string): void;
        export declare function toSessionDispatchOutcome(result: SessionSendResult, context: string): SessionDispatchOutcome;
        export declare function isTerminalAgentErrorEvent(event: AgentEvent): boolean;
      }
    `],
    [ambientModulesFixturePath, `
      declare module '*?raw' {
        const value: string;
        export default value;
      }
    `],
  ]);
  const options: ts.CompilerOptions = {
    noEmit: true,
    skipLibCheck: true,
    // 这个 guard 只扫描直接忽略 Session.send outcome 的语法形态。
    // strict=false + noResolve=true 是为了把全量并发下的 TS Program 限在
    // 最小虚拟文件图；如果后续扩展到依赖严格空值传播的判断，必须先补
    // 对应 fixture，确认宽松配置仍能抓到违规。
    strict: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noResolve: true,
  };
  const defaultHost = ts.createCompilerHost(options, true);
  const originalFileExists = defaultHost.fileExists.bind(defaultHost);
  const originalReadFile = defaultHost.readFile.bind(defaultHost);
  const originalGetSourceFile = defaultHost.getSourceFile.bind(defaultHost);

  defaultHost.fileExists = (fileName) => files.has(normalizePath(fileName)) || originalFileExists(fileName);
  defaultHost.readFile = (fileName) => files.get(normalizePath(fileName)) ?? originalReadFile(fileName);
  defaultHost.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const source = files.get(normalizePath(fileName));
    if (source !== undefined) {
      return ts.createSourceFile(fileName, source, languageVersion, true);
    }
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  return ts.createProgram({
    // 这个 guard 只需要当前 root 文件里的 AST 与 maker-core Session 类型；
    // 不解析 desktop tsconfig 依赖图，避免 full vitest 并发下的 TS Program 超时。
    rootNames: [
      makerCoreSessionFixturePath,
      ambientModulesFixturePath,
      ...rootNames.map((fileName) => normalizePath(fileName)),
    ],
    options,
    host: defaultHost,
  });
}

function collectRuntimeSessionSendGuardFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        if (entry === '__tests__' || entry === 'logs' || entry === 'node_modules') continue;
        walk(fullPath);
        continue;
      }
      if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
      files.push(fullPath);
    }
  };
  for (const runtimeRoot of [mainRoot, orcaWorkflowSrcRoot]) {
    if (!existsSync(runtimeRoot)) throw new Error(`runtime root missing: ${runtimeRoot}`);
    walk(runtimeRoot);
  }
  return files;
}

function isRuntimeSessionSendGuardFile(filePath: string): boolean {
  const runtimePrefixes = [mainRoot, orcaWorkflowSrcRoot].map((runtimeRoot) => `${normalizePath(runtimeRoot)}/`);
  return runtimePrefixes.some((runtimePrefix) => filePath.startsWith(runtimePrefix))
    && !filePath.includes('/__tests__/')
    && !filePath.includes('/logs/');
}

function isFixtureFile(filePath: string): boolean {
  return filePath.endsWith('/direct-send-fixture.ts');
}

function isIdentifierNamed(node: ts.Expression, expected: string): boolean {
  return ts.isIdentifier(node) && node.text === expected;
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath).replace(/\\/g, '/');
}

function toRepoRelativePath(filePath: string): string {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}
