/** Static extraction only. Never imports or executes an upstream registry or credential module. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';

export const COMPATIBILITY_FIELDS = new Set([
  'omitReasoningEffortWithToolsModels',
  'id', 'adapter', 'baseUrl', 'authKind', 'supportsOpenAiWebSearchToolFields',
  'supportsResponsesCustomTools', 'parallelToolCalls', 'modelSupportsVerbosity',
  'supportsVerbosity', 'modelWireDefaults', 'noReasoningModels', 'preserveReasoningContentModels',
  'modelReasoningEffortMap', 'modelSuffixBracketStrip', 'promptCacheKey', 'noTemperatureModels',
  'noTopPModels', 'noPenaltyModels', 'autoToolChoiceOnlyModels', 'escapeBuiltinToolNames',
  'openaiChatEofTolerance', 'statelessResponses', 'modelSupportsReasoningSummaries',
  'thinkingToggleModels', 'thinkingBudgetModels', 'reasoningWireFormat', 'googleMode',
  'modelResponsesTerminalRepair', 'responsesItemIdRepair', 'responsesPath',
  'preserveResponsesReasoningContent', 'requiresAdjacentResponsesToolResults',
  'annotateEmptyToolOutputs', 'requiresReasoningPlaceholderModels', 'directReasoningEffortModels',
  'reasoningSplitModels', 'reasoningDetailsModels', 'reasoningEffortMap',
]);

export function extractProviderProfiles(root) {
  const parsed = new Map();
  const parse = relative => {
    if (!parsed.has(relative)) {
      const text = fs.readFileSync(path.join(root, relative), 'utf8');
      parsed.set(relative, ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true));
    }
    return parsed.get(relative);
  };
  const variables = sf => new Map(sf.statements.filter(ts.isVariableStatement)
    .flatMap(statement => [...statement.declarationList.declarations])
    .filter(declaration => ts.isIdentifier(declaration.name))
    .map(declaration => [declaration.name.text, declaration.initializer]));
  const unwrap = node => {
    while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
    return node;
  };
  const scopes = [new Map()];
  const known = value => !(value && typeof value === 'object' && 'expression' in value);
  const resolve = (node, sf, seen = new Set()) => {
    node = unwrap(node);
    if (!node) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isNumericLiteral(node)) return Number(node.text);
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => {
      const spread = ts.isSpreadElement(element);
      const value = resolve(spread ? element.expression : element, sf, new Set(seen));
      return spread && Array.isArray(value) ? value : [value];
    });
    if (ts.isObjectLiteralExpression(node)) {
      const object = {};
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) {
          const key = ts.isComputedPropertyName(property.name)
            ? resolve(property.name.expression, sf, new Set(seen))
            : property.name.getText(sf).replace(/^['"]|['"]$/g, '');
          object[key] = resolve(property.initializer, sf, new Set(seen));
        } else if (ts.isSpreadAssignment(property)) {
          const value = resolve(property.expression, sf, new Set(seen));
          if (value && typeof value === 'object' && !value.expression) Object.assign(object, value);
          else object['...' + property.expression.getText(sf)] = value;
        }
      }
      return object;
    }
    if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      for (const span of node.templateSpans) {
        const value = resolve(span.expression, sf, new Set(seen));
        if (!known(value)) throw new Error('Unresolved template in compatibility registry');
        text += String(value) + span.literal.text;
      }
      return text;
    }
    if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) {
      const captured = new Map(scopes.at(-1));
      return (...args) => {
        const scope = new Map(captured);
        node.parameters.forEach((parameter, index) => scope.set(parameter.name.getText(sf), args[index]));
        scopes.push(scope);
        try { return resolve(node.body, sf); } finally { scopes.pop(); }
      };
    }
    if (ts.isConditionalExpression(node)) {
      const condition = resolve(node.condition, sf, new Set(seen));
      if (known(condition)) return resolve(condition ? node.whenTrue : node.whenFalse, sf, new Set(seen));
    }
    if (ts.isBinaryExpression(node)) {
      const left = resolve(node.left, sf, new Set(seen));
      const right = resolve(node.right, sf, new Set(seen));
      if (known(left) && known(right)) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return left === right;
        if (node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) return left !== right;
        if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return left + right;
        if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) return left || right;
        if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return left && right;
      }
    }
    if (ts.isCallExpression(node)) {
      const args = node.arguments.map(argument => resolve(argument, sf, new Set(seen)));
      if (ts.isPropertyAccessExpression(node.expression)) {
        const owner = node.expression.expression;
        const method = node.expression.name.text;
        if (owner.getText(sf) === 'Object' && method === 'fromEntries' && Array.isArray(args[0])) return Object.fromEntries(args[0]);
        const receiver = resolve(owner, sf, new Set(seen));
        if (Array.isArray(receiver) && ['map', 'filter'].includes(method) && typeof args[0] === 'function') return receiver[method](args[0]);
        if ((Array.isArray(receiver) || typeof receiver === 'string') && method === 'includes') return receiver.includes(args[0]);
        if (typeof receiver === 'string' && ['toLowerCase', 'toUpperCase', 'startsWith', 'endsWith'].includes(method)) return receiver[method](...args);
      } else {
        const callable = resolve(node.expression, sf, new Set(seen));
        if (typeof callable === 'function') return callable(...args);
      }
    }
    if (ts.isIdentifier(node)) {
      if (scopes.at(-1).has(node.text)) return scopes.at(-1).get(node.text);
      const key = sf.fileName + ':' + node.text;
      if (!seen.has(key)) {
        seen.add(key);
        const local = variables(sf).get(node.text);
        if (local) return resolve(local, sf, seen);
        for (const declaration of sf.statements) {
          if (!ts.isImportDeclaration(declaration)) continue;
          const bindings = declaration.importClause?.namedBindings;
          if (!bindings || !ts.isNamedImports(bindings)) continue;
          const binding = bindings.elements.find(element => element.name.text === node.text);
          const spec = declaration.moduleSpecifier.text;
          if (!binding || !spec.startsWith('.')) continue;
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(sf.fileName), spec));
          const relative = [base, base + '.ts', base + '/index.ts'].find(candidate => candidate.endsWith('.ts') && fs.existsSync(path.join(root, candidate)));
          if (relative) {
            const imported = parse(relative);
            const value = variables(imported).get(binding.propertyName?.text ?? binding.name.text);
            if (value) return resolve(value, imported, seen);
          }
        }
      }
    }
    return { expression: node.getText(sf), source: sf.fileName, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
  };
  const registry = parse('src/providers/registry.ts');
  const declaration = unwrap(variables(registry).get('PROVIDER_REGISTRY'));
  if (!declaration || !ts.isArrayLiteralExpression(declaration)) throw new Error('Upstream registry shape changed; review extractor.');
  const profiles = declaration.elements.map(element => {
    // Resolve selected properties only, avoiding unrelated account, pricing, and model catalog data.
    const object = unwrap(element);
    if (!ts.isObjectLiteralExpression(object)) throw new Error('Upstream provider declaration shape changed.');
    const result = {};
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) throw new Error('Upstream provider spread needs review.');
      const key = property.name.getText(registry).replace(/^['"]|['"]$/g, '');
      if (COMPATIBILITY_FIELDS.has(key)) result[key] = resolve(property.initializer, registry);
    }
    if (typeof result.id !== 'string' || typeof result.baseUrl !== 'string') throw new Error('Unresolved provider identity.');
    return result;
  });
  const assertResolved = value => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.expression === 'string' && typeof value.source === 'string') {
      throw new Error(`Unresolved compatibility expression at ${value.source}:${value.line}: ${value.expression}`);
    }
    for (const child of Object.values(value)) assertResolved(child);
  };
  assertResolved(profiles);
  const sources = [...parsed].map(([source, sf]) => ({ source, sha256: createHash('sha256').update(sf.text).digest('hex') }));
  return { profiles, sources };
}
