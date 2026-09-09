import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

// Execute the actual shared composer callback without mounting the editor/model tree.
const source = ts.createSourceFile('ChatInput.tsx', readFileSync(resolve(__dirname,
  '../../../components/new-chat/ChatInput.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let callback = '';
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'handlePermissionModeChange') {
    callback = (node.initializer as ts.CallExpression).arguments[0]!.getText(source);
  }
  ts.forEachChild(node, visit);
}
visit(source);
if (!callback) throw new Error('Permission switch callback missing');
const compiled = ts.transpileModule(`const handle = ${callback};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;

function fixture() {
  const runtime = vi.fn(async (): Promise<void> => undefined);
  const persist = vi.fn(async () => undefined);
  const changed = vi.fn();
  const confirm = vi.fn(async () => true);
  const error = vi.fn();
  const env = {
    sessionId: 'bot-canonical', settingsLocked: false,
    activePermissionModeRef: { current: 'bypassPermissions' },
    requiresFullAccessConfirmation: (_previous: string, next: string) => next === 'bypassPermissions',
    confirmDialog: confirm, t: (key: string) => key,
    React: { createElement: () => null }, FullAccessConfirmContent: () => null, TriangleAlert: () => null,
    getSessionDeviceId: () => null,
    window: { electronAPI: { maker: { setPermissionMode: runtime } } },
    sessionService: { update: persist }, onPermissionModeDidChange: changed,
    log: { warn: vi.fn() }, toast: { error },
  };
  const change = new Function(...Object.keys(env), `${compiled}; return handle;`)(...Object.values(env)) as
    (mode: string) => Promise<void>;
  return { runtime, persist, changed, confirm, error, change };
}

describe('companion canonical task uses the standard live permission switch', () => {
  it('applies ask to the running task before saving or reporting success', async () => {
    const f = fixture();
    let release!: () => void;
    f.runtime.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = f.change('ask');
    expect(f.runtime).toHaveBeenCalledWith('bot-canonical', 'ask');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    release();
    await pending;
    expect(f.persist).toHaveBeenCalledWith('bot-canonical', { permissionMode: 'ask' });
    expect(f.changed).toHaveBeenCalledWith('ask');
  });

  it('does not persist or claim a downgrade when the running task rejects it', async () => {
    const f = fixture();
    f.runtime.mockRejectedValueOnce(new Error('runtime failed'));
    await f.change('ask');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.error).toHaveBeenCalled();
  });

  it('restores the running task when persistence fails', async () => {
    const f = fixture();
    f.persist.mockRejectedValueOnce(new Error('database failed'));
    await f.change('ask');
    expect(f.runtime.mock.calls).toEqual([
      ['bot-canonical', 'ask'], ['bot-canonical', 'bypassPermissions'],
    ]);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before enabling full access', async () => {
    const f = fixture();
    f.confirm.mockResolvedValueOnce(false);
    await f.change('bypassPermissions');
    expect(f.runtime).not.toHaveBeenCalled();
    await f.change('bypassPermissions');
    expect(f.runtime).toHaveBeenCalledWith('bot-canonical', 'bypassPermissions');
    expect(f.changed).toHaveBeenCalledWith('bypassPermissions');
  });
});
