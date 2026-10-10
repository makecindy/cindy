import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { AgentKind } from '@cindy/model-providers/types';
import type { ProviderView } from '@cindy/model-providers/registry';
import { mobileUnifiedEntries, resolveMobileModelConfig } from '@/session/unifiedMobileModels';

// Read the actual existing-task picker props; a fixture with a corrected agents list
// would miss this regression even if all shared catalog tests passed.
const source = ts.createSourceFile('screen.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let expression: ts.Expression | undefined;
function visit(node: ts.Node) {
  if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
    && node.tagName.getText(source) === 'ModelPickerSheet') {
    const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
    const id = attributes.find(attribute => attribute.name.getText(source) === 'testID');
    if (id?.initializer && ts.isStringLiteral(id.initializer) && id.initializer.text === 'session.modelSheet') {
      const unified = attributes.find(attribute => attribute.name.getText(source) === 'unified');
      if (unified?.initializer && ts.isJsxExpression(unified.initializer)
        && unified.initializer.expression && ts.isObjectLiteralExpression(unified.initializer.expression)) {
        const agents = unified.initializer.expression.properties.find(property =>
          ts.isPropertyAssignment(property) && property.name.getText(source) === 'agents');
        if (agents && ts.isPropertyAssignment(agents)) expression = agents.initializer;
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!expression) throw new Error('Existing-task model picker agents were not found');
const code = ts.transpileModule(`const agents = ${expression.getText(source)};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;
const pickerAgents = new Function('sessionAgentSwitchSupported', 'sessionAgentKind',
  `${code}; return agents;`) as (canSwitch: boolean, current: AgentKind) => AgentKind[];

const cursor: ProviderView = {
  id: 'cursor', name: 'Cursor', source: 'builtin', auth: { method: 'none' }, connected: true, agents: ['cursor'], routing: {},
  models: { cursor: ['cursor-default', 'native-one', 'native-two'].map((id, index) => ({
    id, name: ['Cursor Default', 'Native Model One', 'Native Model Two'][index],
    contextWindow: 0, efforts: [], defaultEffort: null,
  })) },
};
const current = { providerId: 'cursor', modelId: 'cursor-default', agent: 'cursor' as const };

describe('Cursor models in the actual mobile existing-task picker', () => {
  it.each(['cursor', 'codex'] as const)('lists native model choices while the current engine is %s', agent => {
    const entries = mobileUnifiedEntries([cursor], pickerAgents(true, agent), {}, true, current);
    expect(entries.map(entry => entry.modelId)).toEqual(['cursor-default', 'native-one', 'native-two']);
    expect(entries.map(entry => entry.displayName)).toEqual(['Cursor Default', 'Native Model One', 'Native Model Two']);
    expect(entries.every(entry => entry.nativeAgent === 'cursor')).toBe(true);
  });
  it('retains the current engine when the host cannot switch engines', () => {
    expect(pickerAgents(false, 'cursor')).toEqual(['cursor']);
    expect(mobileUnifiedEntries([cursor], pickerAgents(false, 'cursor'), {}, true, current)).toHaveLength(3);
  });
  it('continues honoring the host model visibility settings', () => {
    const entries = mobileUnifiedEntries([cursor], pickerAgents(true, 'cursor'), {
      'cursor:cursor:native-one': false,
    }, true, current);
    expect(entries.map(entry => entry.modelId)).toEqual(['cursor-default', 'native-two']);
  });
  it('selects the exact native model and keeps its Cursor engine and source', () => {
    const entries = mobileUnifiedEntries([cursor], pickerAgents(true, 'cursor'), {}, true, current);
    const entry = entries.find(item => item.modelId === 'native-two');
    expect(entry).toBeDefined();
    expect(resolveMobileModelConfig(entry!, { pinned: 'cursor', fastCapable: () => false })).toEqual({
      providerId: 'cursor', modelId: 'native-two', agent: 'cursor', effort: '', fast: false,
    });
  });
});
