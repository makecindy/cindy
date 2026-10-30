import { readFileSync } from 'node:fs';
import { createSourceFile, forEachChild, isCallExpression, isFunctionDeclaration, isVariableDeclaration, ScriptTarget, transpileModule, type Node } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { assertCindyMakeEnabled, assertCindyMakeSessionAvailable } from '../../cindy-make/featureGate';
import { assertReviewSessionExternalInputAllowed } from '../../reviewer/reviewSessionInputPolicy';

const source = createSourceFile('register.ts', readFileSync(new URL('../register.ts', import.meta.url), 'utf8'), ScriptTarget.Latest, true);

function expressionMatching(predicate: (node: Node) => Node | undefined): string {
  let found: Node | undefined;
  function visit(node: Node): void {
    found ??= predicate(node);
    if (!found) forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error('IPC wiring not found');
  return found.getText(source);
}

function bind(expression: string, deps: Record<string, unknown>) {
  const compiled = transpileModule(`return (${expression});`, { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(deps), compiled)(...Object.values(deps));
}

describe('disabled Cindy Make execution', () => {
  it('refuses direct feature operations and both persisted purposes but leaves ordinary sources available', () => {
    expect(assertCindyMakeEnabled).toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    for (const source of ['cindy-make', 'cindy-make-merge']) {
      expect(() => assertCindyMakeSessionAvailable(source)).toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    }
    for (const source of ['desktop', 'bot', 'review', null, undefined]) {
      expect(() => assertCindyMakeSessionAvailable(source)).not.toThrow();
    }
  });

  it.each(['cindy-make', 'cindy-make-merge'])('blocks enqueue, steer, resume and retry for %s before preparation or dispatch', async (sessionSource) => {
    const prepareSharedTaskInput = vi.fn();
    const inputCoordinator = { getGeneration: vi.fn(), enqueue: vi.fn(), steer: vi.fn(), resume: vi.fn(), retryLastError: vi.fn() };
    const readSessionSource = vi.fn(async () => sessionSource);
    const assertExternalInput = bind(expressionMatching(node =>
      isFunctionDeclaration(node) && node.name?.text === 'assertReviewExternalInputAllowed' ? node : undefined,
    ), { readSessionSource, assertCindyMakeSessionAvailable, assertReviewSessionExternalInputAllowed });
    const assertRemoteInputControlBoundary = bind(expressionMatching(node =>
      isVariableDeclaration(node) && node.name.getText(source) === 'assertRemoteInputControlBoundary' ? node.initializer : undefined,
    ), { assertReviewExternalInputAllowed: assertExternalInput, inputCoordinator });
    for (const channel of ['INPUT_ENQUEUE', 'INPUT_STEER', 'INPUT_RESUME', 'INPUT_RETRY_LAST_ERROR']) {
      const handler = bind(expressionMatching(node =>
        isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle'
          && node.arguments[0]?.getText(source) === `MAKER_INVOKE.${channel}` ? node.arguments[1] : undefined,
      ), { requireSessionId: (id: string) => id, isDeviceLinkInvoke: () => false,
        assertReviewExternalInputAllowed: assertExternalInput, assertRemoteInputControlBoundary,
        prepareSharedTaskInput, inputCoordinator });
      await expect(handler({}, 'old-make', {})).rejects.toThrow(/\[UNSUPPORTED_CAPABILITY\]/);
    }
    expect(prepareSharedTaskInput).not.toHaveBeenCalled();
    for (const action of Object.values(inputCoordinator)) expect(action).not.toHaveBeenCalled();
  });
});
