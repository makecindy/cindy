/**
 * Static compatibility inspection for Pi extensions loaded by Cindy's RPC host.
 *
 * This is advisory, not a security scanner. It follows statically resolvable local
 * imports and reports calls to Pi UI APIs that Cindy cannot currently present.
 * Absence of a finding means "no known incompatible API was found", never proof
 * that arbitrary third-party code is fully compatible or safe.
 */

import { parse } from '@babel/parser';
import { createRequire } from 'node:module';
import path from 'node:path';

import type {
  PiExtensionUiApi,
  PiPackageCompatibility,
  PiPackageCompatibilityIssue,
  PiPackageRuntimeRequirement,
} from '../../shared/piPackages.js';
import {
  isWithinConfinement,
  openConstrainedRegularFile,
  resolveStablePackagePath,
  sameStableFileIdentity,
} from './pi-package-file-boundary.js';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_ANALYSIS_MS = 2_000;
const LOCAL_MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;
const PI_RUNTIME_PACKAGES = [
  '@earendil-works/pi-ai',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-tui',
  '@mariozechner/pi-ai',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-tui',
] as const;
const LEGACY_PI_RUNTIME_PACKAGES = new Set<string>([
  '@mariozechner/pi-ai',
  '@mariozechner/pi-agent-core',
  '@mariozechner/pi-coding-agent',
  '@mariozechner/pi-tui',
]);

interface SemverApi {
  valid(version: string): string | null;
  validRange(range: string): string | null;
  satisfies(version: string, range: string, options?: { includePrerelease?: boolean }): boolean;
}

const semver = createRequire(import.meta.url)('semver') as SemverApi;

const ISSUE_BY_API: Partial<Record<PiExtensionUiApi, PiPackageCompatibilityIssue>> = {
  setStatus: 'status-display',
  setWorkingMessage: 'status-display',
  setWorkingVisible: 'status-display',
  setWorkingIndicator: 'status-display',
  setHiddenThinkingLabel: 'status-display',
  setWidget: 'widgets',
  setTitle: 'terminal-title',
  setEditorText: 'editor-integration',
  getEditorText: 'editor-integration',
  pasteToEditor: 'editor-integration',
  getEditorComponent: 'editor-integration',
  addAutocompleteProvider: 'editor-integration',
  setEditorComponent: 'editor-integration',
  setFooter: 'tui-layout',
  setHeader: 'tui-layout',
  setToolsExpanded: 'tui-layout',
  getToolsExpanded: 'tui-layout',
  custom: 'custom-ui',
  getAllThemes: 'theme-control',
  getTheme: 'theme-control',
  setTheme: 'theme-control',
  theme: 'theme-control',
  onTerminalInput: 'terminal-input',
  registerShortcut: 'tui-rendering',
  registerFlag: 'cli-flags',
  registerMessageRenderer: 'tui-rendering',
  registerMarkdownTransformer: 'tui-rendering',
  registerEntryRenderer: 'tui-rendering',
};

const KNOWN_UI_APIS = new Set<PiExtensionUiApi>([
  ...(Object.keys(ISSUE_BY_API) as PiExtensionUiApi[]),
  // RPC exposes these through extension_ui_request. Cindy maps dialogs onto
  // its cross-device question card and presents notifications in the task
  // transcript, so they are adapted instead of merely tolerated.
  'select',
  'confirm',
  'input',
  'editor',
  'notify',
]);

type AstNode = {
  type: string;
  [key: string]: unknown;
};

interface ParsedModule {
  root: AstNode;
  imports: string[];
  recoveredErrors: boolean;
}

export interface PiExtensionCompatibilityAnalysis {
  compatibility: Extract<PiPackageCompatibility, 'supported' | 'partial' | 'unknown'>;
  compatibilityIssues: PiPackageCompatibilityIssue[];
  detectedApis: PiExtensionUiApi[];
  scannedFiles: number;
}

export function evaluatePiRuntimeRequirements(
  peerDependencies: Record<string, string> | undefined,
  currentVersion: string | undefined,
): PiPackageRuntimeRequirement[] {
  if (!peerDependencies) return [];
  return PI_RUNTIME_PACKAGES.flatMap((packageName) => {
    const range = peerDependencies[packageName];
    if (typeof range !== 'string' || !range.trim()) return [];
    const normalizedRange = range.trim();
    const legacyRuntimePackage = LEGACY_PI_RUNTIME_PACKAGES.has(packageName);
    const canCompare = Boolean(
      currentVersion && semver.valid(currentVersion) && semver.validRange(normalizedRange),
    );
    return [
      {
        packageName,
        range: normalizedRange,
        ...(currentVersion ? { currentVersion } : {}),
        compatible: legacyRuntimePackage
          ? false
          : canCompare
            ? semver.satisfies(currentVersion!, normalizedRange, { includePrerelease: true })
            : null,
        ...(legacyRuntimePackage ? { reason: 'legacy-runtime-package' as const } : {}),
      },
    ];
  });
}

function isNode(value: unknown): value is AstNode {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function propertyName(node: unknown): string | null {
  if (!isNode(node)) return null;
  if (node.type === 'Identifier' && typeof node.name === 'string') return node.name;
  if ((node.type === 'StringLiteral' || node.type === 'Literal') && typeof node.value === 'string')
    return node.value;
  return null;
}

function memberParts(node: unknown): { object: unknown; property: string } | null {
  if (
    !isNode(node) ||
    (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')
  )
    return null;
  const property = propertyName(node.property);
  return property ? { object: node.object, property } : null;
}

function identifierName(node: unknown): string | null {
  return isNode(node) && node.type === 'Identifier' && typeof node.name === 'string'
    ? node.name
    : null;
}

function isLikelyContextName(name: string): boolean {
  return /^_?(ctx|context|extensionContext)$/i.test(name);
}

function isLikelyExtensionApiName(name: string): boolean {
  return /^_?(pi|api|extensionApi)$/i.test(name);
}

function hasExtensionContextType(node: AstNode): boolean {
  let found = false;
  walk(node, (child) => {
    if (child.type !== 'Identifier' || typeof child.name !== 'string') return;
    if (/Extension(?:Command|Tool)?Context$/.test(child.name)) found = true;
  });
  return found;
}

function hasExtensionApiType(node: AstNode): boolean {
  let found = false;
  walk(node, (child) => {
    if (child.type !== 'Identifier' || typeof child.name !== 'string') return;
    if (/ExtensionAPI$/.test(child.name)) found = true;
  });
  return found;
}

function registerContextParam(param: AstNode | undefined, contextBindings: Set<string>): void {
  if (!param) return;
  const name = identifierName(param);
  if (name) contextBindings.add(name);
}

function isContextExpression(node: unknown, contextBindings: Set<string>): boolean {
  const name = identifierName(node);
  return name !== null && contextBindings.has(name);
}

function isExtensionApiExpression(node: unknown, extensionApiBindings: Set<string>): boolean {
  const name = identifierName(node);
  return name !== null && extensionApiBindings.has(name);
}

function isUiExpression(
  node: unknown,
  contextBindings: Set<string>,
  uiBindings: Set<string>,
): boolean {
  const name = identifierName(node);
  if (name && uiBindings.has(name)) return true;
  const member = memberParts(node);
  return Boolean(
    member && member.property === 'ui' && isContextExpression(member.object, contextBindings),
  );
}

function collectChildNodes(node: AstNode): AstNode[] {
  const children: AstNode[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    if (isNode(value)) children.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) children.push(item);
    }
  }
  return children;
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of collectChildNodes(node)) walk(child, visit);
}

function functionParams(node: AstNode): AstNode[] {
  if (
    node.type !== 'FunctionDeclaration' &&
    node.type !== 'FunctionExpression' &&
    node.type !== 'ArrowFunctionExpression' &&
    node.type !== 'ObjectMethod'
  )
    return [];
  return Array.isArray(node.params) ? node.params.filter(isNode) : [];
}

function collectBindings(root: AstNode): {
  contextBindings: Set<string>;
  extensionApiBindings: Set<string>;
  uiBindings: Set<string>;
  methodBindings: Map<string, PiExtensionUiApi>;
} {
  const contextBindings = new Set<string>(['ctx', 'context', 'extensionContext']);
  const extensionApiBindings = new Set<string>(['pi', 'extensionApi']);
  const uiBindings = new Set<string>();
  const methodBindings = new Map<string, PiExtensionUiApi>();

  walk(root, (node) => {
    for (const param of functionParams(node)) {
      const name = identifierName(param);
      if (name && (isLikelyContextName(name) || hasExtensionContextType(param)))
        contextBindings.add(name);
      if (name && (isLikelyExtensionApiName(name) || hasExtensionApiType(param)))
        extensionApiBindings.add(name);
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      const member = memberParts(node.callee);
      if (member?.property === 'on') {
        const callback = Array.isArray(node.arguments)
          ? node.arguments.filter(isNode).find((argument) => functionParams(argument).length > 0)
          : undefined;
        const params = callback ? functionParams(callback) : [];
        registerContextParam(params[1], contextBindings);
      }
    }
    if (node.type === 'ObjectProperty' && isNode(node.value)) {
      const params = functionParams(node.value);
      const key = propertyName(node.key);
      if (key === 'handler') registerContextParam(params[1], contextBindings);
      if (key === 'execute') registerContextParam(params.at(-1), contextBindings);
    }
    if (node.type === 'ObjectMethod') {
      const params = functionParams(node);
      const key = propertyName(node.key);
      if (key === 'handler') registerContextParam(params[1], contextBindings);
      if (key === 'execute') registerContextParam(params.at(-1), contextBindings);
    }
    if (node.type !== 'VariableDeclarator' || !isNode(node.id)) return;
    const id = node.id;
    const init = node.init;
    if (id.type === 'Identifier' && typeof id.name === 'string') {
      if (isUiExpression(init, contextBindings, uiBindings)) {
        uiBindings.add(id.name);
        return;
      }
      const member = memberParts(init);
      if (
        member &&
        isUiExpression(member.object, contextBindings, uiBindings) &&
        KNOWN_UI_APIS.has(member.property as PiExtensionUiApi)
      ) {
        methodBindings.set(id.name, member.property as PiExtensionUiApi);
      }
      if (
        member &&
        isExtensionApiExpression(member.object, extensionApiBindings) &&
        KNOWN_UI_APIS.has(member.property as PiExtensionUiApi)
      ) {
        methodBindings.set(id.name, member.property as PiExtensionUiApi);
      }
      return;
    }
    if (id.type !== 'ObjectPattern') return;
    const properties = Array.isArray(id.properties) ? id.properties.filter(isNode) : [];
    for (const property of properties) {
      if (property.type !== 'ObjectProperty') continue;
      const key = propertyName(property.key);
      const localName = identifierName(property.value);
      if (!key || !localName) continue;
      if (isContextExpression(init, contextBindings) && key === 'ui') uiBindings.add(localName);
      if (
        isUiExpression(init, contextBindings, uiBindings) &&
        KNOWN_UI_APIS.has(key as PiExtensionUiApi)
      ) {
        methodBindings.set(localName, key as PiExtensionUiApi);
      }
      if (
        isExtensionApiExpression(init, extensionApiBindings) &&
        KNOWN_UI_APIS.has(key as PiExtensionUiApi)
      ) {
        methodBindings.set(localName, key as PiExtensionUiApi);
      }
    }
  });

  return { contextBindings, extensionApiBindings, uiBindings, methodBindings };
}

function modeComparison(node: unknown, contextBindings: Set<string>): 'true' | 'false' | null {
  if (!isNode(node) || (node.type !== 'BinaryExpression' && node.type !== 'LogicalExpression'))
    return null;
  if (node.type === 'LogicalExpression') return null;
  const operator = typeof node.operator === 'string' ? node.operator : '';
  const leftMember = memberParts(node.left);
  const rightMember = memberParts(node.right);
  const leftString =
    isNode(node.left) &&
    (node.left.type === 'StringLiteral' || node.left.type === 'Literal') &&
    typeof node.left.value === 'string'
      ? node.left.value
      : null;
  const rightString =
    isNode(node.right) &&
    (node.right.type === 'StringLiteral' || node.right.type === 'Literal') &&
    typeof node.right.value === 'string'
      ? node.right.value
      : null;
  const modeMember =
    leftMember?.property === 'mode' && isContextExpression(leftMember.object, contextBindings)
      ? leftMember
      : rightMember?.property === 'mode' && isContextExpression(rightMember.object, contextBindings)
        ? rightMember
        : null;
  const value = modeMember === leftMember ? rightString : leftString;
  if (!modeMember || (value !== 'tui' && value !== 'rpc')) return null;
  const equal = operator === '===' || operator === '==';
  const unequal = operator === '!==' || operator === '!=';
  if (!equal && !unequal) return null;
  const trueInTui = (value === 'tui' && equal) || (value === 'rpc' && unequal);
  return trueInTui ? 'true' : 'false';
}

function collectDetectedApis(root: AstNode): Set<PiExtensionUiApi> {
  const { contextBindings, extensionApiBindings, uiBindings, methodBindings } =
    collectBindings(root);
  const detected = new Set<PiExtensionUiApi>();

  const visit = (node: AstNode, tuiOnly: boolean): void => {
    if (node.type === 'IfStatement' && isNode(node.test) && isNode(node.consequent)) {
      const comparison = modeComparison(node.test, contextBindings);
      visit(node.test, tuiOnly);
      visit(node.consequent, tuiOnly || comparison === 'true');
      if (isNode(node.alternate)) visit(node.alternate, tuiOnly || comparison === 'false');
      return;
    }
    if (
      node.type === 'ConditionalExpression' &&
      isNode(node.test) &&
      isNode(node.consequent) &&
      isNode(node.alternate)
    ) {
      const comparison = modeComparison(node.test, contextBindings);
      visit(node.test, tuiOnly);
      visit(node.consequent, tuiOnly || comparison === 'true');
      visit(node.alternate, tuiOnly || comparison === 'false');
      return;
    }
    if (
      node.type === 'LogicalExpression' &&
      node.operator === '&&' &&
      isNode(node.left) &&
      isNode(node.right)
    ) {
      const comparison = modeComparison(node.left, contextBindings);
      visit(node.left, tuiOnly);
      visit(node.right, tuiOnly || comparison === 'true');
      return;
    }
    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && !tuiOnly) {
      const directName = identifierName(node.callee);
      const boundMethod = directName ? methodBindings.get(directName) : undefined;
      if (boundMethod) detected.add(boundMethod);
      const member = memberParts(node.callee);
      if (member && isUiExpression(member.object, contextBindings, uiBindings)) {
        const method = member.property as PiExtensionUiApi;
        if (KNOWN_UI_APIS.has(method)) detected.add(method);
      }
      if (member && isExtensionApiExpression(member.object, extensionApiBindings)) {
        const method = member.property as PiExtensionUiApi;
        if (KNOWN_UI_APIS.has(method)) detected.add(method);
      }
    }
    if (!tuiOnly) {
      const member = memberParts(node);
      if (
        member &&
        isUiExpression(member.object, contextBindings, uiBindings) &&
        member.property === 'theme'
      ) {
        detected.add('theme');
      }
    }
    for (const child of collectChildNodes(node)) visit(child, tuiOnly);
  };

  visit(root, false);
  return detected;
}

function collectImports(root: AstNode): string[] {
  const imports = new Set<string>();
  walk(root, (node) => {
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration') &&
      isNode(node.source) &&
      typeof node.source.value === 'string'
    ) {
      imports.add(node.source.value);
      return;
    }
    if (node.type !== 'CallExpression' && node.type !== 'OptionalCallExpression') return;
    const calleeName = identifierName(node.callee);
    const isDynamicImport = isNode(node.callee) && node.callee.type === 'Import';
    if (calleeName !== 'require' && !isDynamicImport) return;
    const first = Array.isArray(node.arguments) ? node.arguments.find(isNode) : undefined;
    if (
      first &&
      (first.type === 'StringLiteral' || first.type === 'Literal') &&
      typeof first.value === 'string'
    ) {
      imports.add(first.value);
    }
  });
  return [...imports];
}

function parseModule(source: string): ParsedModule {
  const ast = parse(source, {
    sourceType: 'unambiguous',
    errorRecovery: true,
    plugins: ['typescript', 'jsx', 'decorators-legacy', 'importAttributes'],
  }) as unknown as AstNode;
  return {
    root: ast,
    imports: collectImports(ast),
    recoveredErrors: Array.isArray(ast.errors) && ast.errors.length > 0,
  };
}

async function readSourceFileBounded(
  file: string,
  packageRoot: string,
): Promise<{ source: string; bytes: number }> {
  const { handle, stat } = await openConstrainedRegularFile(
    packageRoot,
    file,
    'Pi extension analysis contains an escaped link',
    'Pi extension source changed before analysis',
  );
  try {
    if (stat.size > MAX_FILE_BYTES) throw new Error('Pi extension source exceeds analysis limit');
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await handle.read(buffer, bytes, buffer.length - bytes, bytes);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_FILE_BYTES) throw new Error('Pi extension source exceeds analysis limit');
    const after = await handle.stat();
    if (!sameStableFileIdentity(stat, after) || bytes !== after.size) {
      throw new Error('Pi extension source changed during analysis');
    }
    return { source: buffer.subarray(0, bytes).toString('utf8'), bytes };
  } finally {
    await handle.close();
  }
}

async function resolveLocalModule(
  fromFile: string,
  specifier: string,
  packageRoot: string,
): Promise<string | null> {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = new Set<string>([base]);
  const currentExtension = path.extname(base).toLowerCase();
  if (currentExtension) {
    for (const extension of LOCAL_MODULE_EXTENSIONS)
      candidates.add(`${base.slice(0, -currentExtension.length)}${extension}`);
  } else {
    for (const extension of LOCAL_MODULE_EXTENSIONS) candidates.add(`${base}${extension}`);
    for (const extension of LOCAL_MODULE_EXTENSIONS)
      candidates.add(path.join(base, `index${extension}`));
  }
  const rootPrefix = `${packageRoot}${path.sep}`;
  for (const candidate of candidates) {
    try {
      const { canonicalPath: canonical, stat } = await resolveStablePackagePath(
        candidate,
        'Pi extension module changed during analysis',
      );
      if (canonical !== packageRoot && !canonical.startsWith(rootPrefix)) continue;
      if (stat.isFile()) return canonical;
    } catch {
      // Try the next legal module candidate.
    }
  }
  return null;
}

export async function analyzePiExtensionCompatibility(
  entryFile: string,
  packageRoot: string,
): Promise<PiExtensionCompatibilityAnalysis> {
  const { canonicalPath: canonicalRoot } = await resolveStablePackagePath(
    packageRoot,
    'Pi extension package root changed during analysis',
  );
  const rootPrefix = `${canonicalRoot}${path.sep}`;
  const { canonicalPath: canonicalEntry } = await resolveStablePackagePath(
    entryFile,
    'Pi extension entry changed during analysis',
  );
  const queue = [canonicalEntry];
  const visited = new Set<string>();
  const detectedApis = new Set<PiExtensionUiApi>();
  let totalBytes = 0;
  let incomplete = false;
  const startedAt = Date.now();

  while (queue.length > 0) {
    if (Date.now() - startedAt > MAX_ANALYSIS_MS) {
      incomplete = true;
      break;
    }
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    if (!isWithinConfinement(canonicalRoot, file)) {
      incomplete = true;
      continue;
    }
    if (visited.size >= MAX_FILES) {
      incomplete = true;
      break;
    }
    visited.add(file);
    try {
      const sourceFile = await readSourceFileBounded(file, canonicalRoot);
      if (totalBytes + sourceFile.bytes > MAX_TOTAL_BYTES) {
        incomplete = true;
        continue;
      }
      totalBytes += sourceFile.bytes;
      const parsed = parseModule(sourceFile.source);
      if (parsed.recoveredErrors) incomplete = true;
      for (const api of collectDetectedApis(parsed.root)) detectedApis.add(api);
      for (const specifier of parsed.imports) {
        const resolved = await resolveLocalModule(file, specifier, canonicalRoot);
        if (resolved && !visited.has(resolved)) queue.push(resolved);
        else if (specifier.startsWith('.') && !resolved) incomplete = true;
      }
    } catch {
      incomplete = true;
    }
  }

  const apis = [...detectedApis].sort();
  const issues = [
    ...new Set(
      apis.flatMap((api) => {
        const issue = ISSUE_BY_API[api];
        return issue ? [issue] : [];
      }),
    ),
  ].sort();
  if (incomplete) issues.push('analysis-incomplete');
  return {
    compatibility: issues.some((issue) => issue !== 'analysis-incomplete')
      ? 'partial'
      : incomplete
        ? 'unknown'
        : 'supported',
    compatibilityIssues: issues,
    detectedApis: apis,
    scannedFiles: visited.size,
  };
}
