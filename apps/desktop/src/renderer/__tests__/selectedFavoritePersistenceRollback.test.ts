import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const source = ts.createSourceFile('actions.ts', readFileSync(
  new URL('../components/new-chat/useUnifiedRowActions.ts', import.meta.url), 'utf8',
), ts.ScriptTarget.Latest, true);
let expression = '';
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'applySelectedFavoriteEdit') {
    expression = node.initializer!.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule(`const apply = ${expression}`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

it.each(['effort', 'fast', 'engine', 'draft'])('restores %s before propagating persistence failure', async mode => {
  const before = { agent: 'codex', engine: 'codex', wireModelId: 'old', effort: 'low', fast: false };
  const target = { ...before, effort: 'high', fast: true, agent: 'pi', wireModelId: 'new' };
  let state = { ...before };
  const events: string[] = [];
  const restoreSelection = vi.fn(async (...args: any[]) => {
    events.push('restore');
    const value = typeof args[0] === 'object' ? args[0] : { effort: args[2], fast: args[3].fast };
    expect(value.effort).toBe('low');
    expect(value.fast).toBe(false);
    state = { ...before };
    return true;
  });
  const apply = new Function('isLiveRow', 'inSession', 'runCrossEngineSwitch', 'sessionEngineFilter', 'runLive', 'onSelect',
    `${compiled}; return apply;`)(
    () => true, mode !== 'draft',
    async (args: any) => { state = { ...target }; return args.onApplied(); },
    { onCrossEngineSelect: restoreSelection },
    async () => { state = { ...target }; return true; }, restoreSelection,
  );
  const failure = new Error('remote persistence rejected');
  const favorite = { ...before };
  await expect(apply({
    anchor: { providerId: 'account', modelId: 'old' }, entry: {}, config: before,
    uid: 'favorite', target,
    live: ['effort', 'fast'].includes(mode) ? async () => { state = { ...target }; return true; } : null,
    rollback: async () => { events.push('restore'); state = { ...before }; },
    commit: async () => { events.push('commit'); throw failure; },
  })).rejects.toBe(failure);
  expect(events).toEqual(['commit', 'restore']);
  expect(state).toEqual(before);
  expect(favorite).toEqual(before);
});
