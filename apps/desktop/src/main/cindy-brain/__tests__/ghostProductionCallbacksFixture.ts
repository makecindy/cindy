import fs from 'node:fs';
import ts from 'typescript';
import { confirmedAutoTools, confirmedHostToolGroups, confirmedEventTopics, confirmedHostUiPermissions } from '../ghostInstallConsent.js';
import { setPluginEnabled } from '../pluginEnableService.js';
import { createGhostExecutionPipe } from '../executionPipe.js';
import { setTaskChangeListener } from '../../localDb/taskEvents.js';
import { ghostInstallTargetContext, resolveForgeInstallTarget } from '../ghostInstallTarget.js';
import { ghostInstallApprovalToken } from '../../../shared/ghost.js';
import { withPluginSchedulerApproval } from '../pluginSchedulerApproval.js';
import {
  parsePluginStoragePart,
  parsePluginInstallRelId,
  findInstalledGhostForDeliveryTarget,
  LOCAL_PLUGIN_NAMESPACE,
  isOrganizationPluginNamespace,
  installedGhostPhysicalRelId,
  installedGhostStoragePart,
  isPluginInstanceKey,
  resolvePluginInstanceQuery,
} from '../../../shared/pluginIdentity.js';

const productionIdentityDeps = {
  ghostInstallApprovalToken,
  withPluginSchedulerApproval,
  requestPluginHostToolCall: async () => ({ isError: true, content: [{ type: 'text', text: '{"ok":false,"errorCode":"HOST_NOT_READY"}' }] }),
  createGhostExecutionPipe,
  setTaskChangeListener,
  setPluginEnabled,
  parsePluginStoragePart,
  parsePluginInstallRelId,
  findInstalledGhostForDeliveryTarget,
  LOCAL_PLUGIN_NAMESPACE,
  isOrganizationPluginNamespace,
  confirmedAutoTools,
  confirmedHostToolGroups,
  confirmedEventTopics,
  confirmedHostUiPermissions,
  ghostInstallTargetContext,
  resolveForgeInstallTarget,
  installedGhostPhysicalRelId,
  installedGhostStoragePart,
  isPluginInstanceKey,
  resolvePluginInstanceQuery,
  libraryRestartRequiredReason: (): string | null => null,
};

/**
 * findGhostForInstanceId reads an exact instance key straight from the
 * manager. Tests that inject availableGhosts get the same answer from it.
 */
function instanceLookupDeps(deps: Record<string, unknown>): Record<string, unknown> {
  const availableGhosts = deps.availableGhosts as (() => Array<Parameters<typeof installedGhostStoragePart>[0]>) | undefined;
  if (!availableGhosts) return {};
  return {
    isAppSessionBoundaryPending: () => false,
    isGhostAvailableForActiveSession: () => true,
    getGhostManager: () => ({
      findInstalledInstance: (key: string) =>
        availableGhosts().find((ghost) => installedGhostStoragePart(ghost) === key),
    }),
  };
}

const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);

export function createGhostProductionCallbacks<Result>(options: {
  source?: URL;
  functions?: string[];
  variables?: string[];
  callbacks?: Record<string, readonly [callee: string, channel?: string]>;
  initialize?: string;
  transformCallback?: (source: string) => string;
}): (deps: Record<string, unknown>) => Result {
  const productionAst = options.source
    ? ts.createSourceFile(options.source.pathname, fs.readFileSync(options.source, 'utf8'), ts.ScriptTarget.Latest, true)
    : ast;
  const { functions = [], variables = [], callbacks = {} } = options;
  const names = [...functions, ...variables, ...Object.keys(callbacks)];
  if (new Set(names).size !== names.length) throw new Error('Duplicate production export names');
  const declarations = new Map<string, string>();
  const record = (name: string, declaration: string) => {
    if (declarations.has(name)) throw new Error('Duplicate production declaration: ' + name);
    declarations.set(name, declaration);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && functions.includes(node.name.text)) {
      record(node.name.text, node.getText(productionAst).replace(/^export /, ''));
    }
    if (ts.isVariableDeclaration(node) && variables.includes(node.name.getText(productionAst))) {
      record(node.name.getText(productionAst), 'const ' + node.getText(productionAst) + ';');
    }
    if (ts.isCallExpression(node)) {
      for (const [name, [callee, channel]] of Object.entries(callbacks)) {
        if (node.expression.getText(productionAst) !== callee) continue;
        const firstArgument = node.arguments[0];
        if (channel !== undefined && (!firstArgument || !ts.isStringLiteral(firstArgument) ||
            firstArgument.text !== channel)) continue;
        const callback = node.arguments[channel === undefined ? 0 : 1];
        if (!callback) throw new Error('Production callback missing: ' + name);
        const text = callback.getText(productionAst);
        record(name, 'const ' + name + ' = ' + (options.transformCallback?.(text) ?? text) + ';');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(productionAst);
  const missing = names.filter((name) => !declarations.has(name));
  if (missing.length) throw new Error('Production declarations missing: ' + missing.join(', '));
  const compiled = ts.transpileModule(
    (options.initialize ?? '') + '\n' + [...declarations.values()].join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
  ).outputText;
  return (deps) => {
    const merged = { ...productionIdentityDeps, ...instanceLookupDeps(deps), ...deps };
    return new Function(
      'deps', 'const {' + Object.keys(merged).filter(name => !names.includes(name)).join(',') + '} = deps;' + compiled +
        ';return {' + names.join(',') + '};',
    )(merged) as Result;
  };
}
