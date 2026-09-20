import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Execute the production validator without booting register.ts's Electron host.
const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('register.ts', source, ts.ScriptTarget.Latest, true);
let validator = '';
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'requireQueuedMessage') {
    validator = node.initializer!.getText(ast);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (!validator) throw new Error('Queued IPC validator not found');
const compiled = ts.transpileModule(`(${validator})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

describe('queued IPC host policy boundary', () => {
  it.each([false, true])('strips caller tool policy with device-link=%s', (remote) => {
    const validate = runInNewContext(compiled, {
      isDeviceLinkInvoke: () => remote,
      requireSessionRefs: () => undefined,
      requireTrustedReferenceContexts: () => undefined,
      throwIpcError: (_code: string, message: string) => { throw new Error(message); },
    });
    for (const toolsDisabled of [true, false, 'true']) {
      const input = {
        clientId: 'ordinary', text: 'Hello', persistedContent: 'Hello',
        chatMessage: { clientId: 'ordinary', role: 'user', content: 'Hello' },
        createOpts: { agentKind: 'pi' }, toolsDisabled,
      };
      const result = validate(input);
      expect(result).not.toHaveProperty('toolsDisabled');
      expect(result.text).toBe(input.text);
      expect(result.createOpts).toEqual(input.createOpts);
      expect(input.toolsDisabled).toBe(toolsDisabled);
    }
  });
});
