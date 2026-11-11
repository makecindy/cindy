import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertCindyMakeEnabled } from '../cindy-make/featureGate';

const feature = vi.hoisted(() => ({ enabled: false }));
vi.mock('@cindy/maker-shared/cindy-make-feature', () => ({
  get CINDY_MAKE_ENABLED() {
    return feature.enabled;
  },
}));

const channels = [
  'app:cindy-make-personal-remote',
  'app:cindy-make-sync',
  'app:cindy-make-contribution',
];
const source = ts.createSourceFile(
  'bootstrap-electron.ts',
  readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.ES2022,
  true,
);
// Run the production callbacks without starting Electron or a GitHub controller.
const registrations: string[] = [];
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'ipcMain.handle') {
    const channel = node.arguments[0];
    if (channel && ts.isStringLiteral(channel) && channels.includes(channel.text))
      registrations.push(node.getText(source));
  }
  ts.forEachChild(node, visit);
}
visit(source);
const compiled = ts.transpileModule(registrations.join(';\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness() {
  const handlers = new Map<string, (event: unknown, request: unknown) => Promise<unknown>>();
  const act = vi.fn(async (request: unknown) => request);
  const deps = {
    ipcMain: {
      handle: (channel: string, handler: (event: unknown, request: unknown) => Promise<unknown>) =>
        handlers.set(channel, handler),
    },
    assertTrustedAppRendererEvent: (event: unknown) => {
      if (event !== 'trusted') throw new Error('untrusted');
    },
    assertCindyMakeEnabled,
    actPersonalRemote: act,
    actPersonalSync: act,
    actCindyMakeContribution: act,
  };
  new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  expect([...handlers.keys()]).toEqual(channels);
  return { handlers, act };
}

describe('Cindy Make GitHub IPC gates', () => {
  beforeEach(() => {
    feature.enabled = false;
  });

  it.each(channels)('rejects %s before any action when Make is disabled', async (channel) => {
    const { handlers, act } = harness();
    await expect(handlers.get(channel)!('trusted', { type: 'write' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    expect(act).not.toHaveBeenCalled();
  });

  it.each(channels)(
    'only dispatches %s from a trusted renderer with Make enabled',
    async (channel) => {
      feature.enabled = true;
      const { handlers, act } = harness();
      const request = { type: 'write' };
      await expect(handlers.get(channel)!('untrusted', request)).rejects.toThrow('untrusted');
      expect(act).not.toHaveBeenCalled();
      await expect(handlers.get(channel)!('trusted', request)).resolves.toBe(request);
      expect(act).toHaveBeenCalledExactlyOnceWith(request);
    },
  );
});
