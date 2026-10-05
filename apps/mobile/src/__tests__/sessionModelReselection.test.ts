import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { modelNeedsReselection } from '@/session/modelReselection';

// Execute the screen's actual send selection and condition without mounting unrelated native UI.
const source = ts.createSourceFile('session.tsx', readFileSync(
  resolve(process.cwd(), 'app/sessions/[sessionId].tsx'), 'utf8',
), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const declarations = new Map<string, string>();
let condition = '';
function visit(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(source).includes('modelNeedsReselection(')) {
    condition = node.expression.getText(source);
    if (!ts.isBlock(node.parent)) throw new Error('Expected send guard block');
    for (const statement of node.parent.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer
          && ['sessionAtSend', 'intentAtSend', 'selectionAtSend'].includes(declaration.name.getText(source))) {
          declarations.set(declaration.name.getText(source), declaration.initializer.getText(source));
        }
      }
    }
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (declarations.size !== 3 || !condition) throw new Error('Missing send selection guard');
const runGuard = new Function('modelNeedsReselection', 'bindings', `
  const { readSessionRowNow, currentSession, resolveSessionAgentKind, getCachedDeviceProviders,
    deviceId, earlyLocalCommand, earlyDesktopCommand } = bindings;
  ${[...declarations].map(([name, value]) => `const ${name} = ${value};`).join('\n')}
  return { blocked: ${condition}, model: selectionAtSend.model };
`);

describe('existing task hidden-model send guard', () => {
  const currentSession = { agentKind: 'codex', model: 'old', providerId: 'old-source' };
  const target = { targetAgentKind: 'pi', model: 'next', providerId: 'new-source' };
  const visibility = { 'codex:old-source:old': false, 'pi:new-source:next': true };
  function check(intent: typeof target | null, overrides = visibility, localCommand = false) {
    return runGuard(modelNeedsReselection, {
      // Store is newer than the rendered row: intent is written while the current agent stays unchanged.
      readSessionRowNow: () => ({ ...currentSession, agentSwitchIntent: intent }), currentSession,
      resolveSessionAgentKind: (row: typeof currentSession) => row.agentKind,
      getCachedDeviceProviders: () => ({ modelVisibilityOverrides: overrides }), deviceId: 'device',
      earlyLocalCommand: localCommand, earlyDesktopCommand: false,
    });
  }
  it('allows an enabled cross-agent target despite the old hidden model', () => {
    expect(check(target)).toEqual({ blocked: false, model: 'next' });
  });
  it('rejects a hidden target and explains that target even when the old model is enabled', () => {
    expect(check(target, { 'codex:old-source:old': true, 'pi:new-source:next': false }))
      .toEqual({ blocked: true, model: 'next' });
  });
  it('keeps the original guard without an intent and preserves the local-command exception', () => {
    expect(check(null)).toEqual({ blocked: true, model: 'old' });
    expect(check(null, visibility, true).blocked).toBe(false);
  });
});
