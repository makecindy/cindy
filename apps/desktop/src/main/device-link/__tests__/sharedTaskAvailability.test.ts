import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the exported predicate without starting Electron or its relay singleton.
const source = ts.createSourceFile('index.ts', readFileSync(resolve(process.cwd(), 'src/main/device-link/index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'isSharedTaskAvailable');
if (!declaration?.body) throw new Error('Shared task availability predicate not found');
const compiled = ts.transpileModule('function available() ' + declaration.body.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const available = (status: string, capable = true, authenticated = true, tornDown = false) => {
  const client = { getStatus: () => status, hasServerCapability: vi.fn(() => capable) };
  return new Function('client', 'linkTornDown', 'authManager', 'SHARED_TASK_CAPABILITY', compiled + '; return available();')(client, tornDown, { getAuthState: () => ({ isAuthenticated: authenticated }) }, 'shared-task-v2');
};
describe('desktop shared-task availability', () => {
  it.each(['connecting', 'stopped'])('rejects cached capabilities while %s', (status) => {
    expect(available(status)).toBe(false);
  });
  it('allows sharing again once relay is online and still supports it', () => {
    expect(available('online')).toBe(true);
    expect(available('connecting')).toBe(false);
    expect(available('online')).toBe(true);
  });
  it('retains capability, login and teardown guards', () => {
    expect(available('online', false)).toBe(false);
    expect(available('online', true, false)).toBe(false);
    expect(available('online', true, true, true)).toBe(false);
  });
});
