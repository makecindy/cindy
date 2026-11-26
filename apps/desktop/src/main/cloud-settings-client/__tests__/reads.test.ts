import { afterEach, expect, it } from 'vitest';
import { fixture } from './fixture';
import type { SettingsWebCommand } from '../../../shared/settingsWeb';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));

async function setup(batch: boolean) {
  const f = fixture();
  cleanups.push(f.stop);
  const original = f.request.getMockImplementation()!;
  const commands: SettingsWebCommand[] = [];
  f.request.mockImplementation(async (...args) => {
    if (args[1].endsWith('/requests') && args[2] === 'POST') {
      const { command, requestId } = args[3] as { command: SettingsWebCommand; requestId: string };
      commands.push(command);
      const domain =
        command.kind === 'readBatch'
          ? command.domains[0]
          : command.kind === 'read'
            ? command.domain
            : null;
      const memory = f.state();
      if (!memory.ok || !('settings' in memory)) throw Error('fixture');
      const read =
        domain === 'lsp'
          ? {
              ok: true,
              settings: {
                ...memory.settings,
                domain: 'lsp',
                value: { enabled: true },
                defaults: { enabled: true },
              },
            }
          : memory;
      const result =
        command.kind === 'readBatch'
          ? {
              ok: true,
              entries: [{ domain, result: read }],
              remainingDomains: command.domains.slice(1),
            }
          : read;
      return { requestId, status: 'complete', result };
    }
    const response = await original(...args);
    if (args[1].endsWith('/sessions')) {
      const cap = { ...(response as Record<string, unknown>) };
      delete cap.readBatch;
      return { ...cap, domains: ['memory', 'lsp'], ...(batch ? { readBatch: true } : {}) };
    }
    return response;
  });
  const bridge = f.bridge(),
    { handle } = await bridge.open({ deviceId: 'cloud-a' });
  return { ...f, bridge, handle, commands };
}
it('follows remainingDomains and assembles the selected category in order', async () => {
  const f = await setup(true);
  const results = await f.bridge.read({ handle: f.handle, domains: ['memory', 'lsp'] });
  expect(results.map((r) => r.ok && 'settings' in r && r.settings.domain)).toEqual([
    'memory',
    'lsp',
  ]);
  expect(f.commands).toEqual([
    { kind: 'readBatch', domains: ['memory', 'lsp'] },
    { kind: 'readBatch', domains: ['lsp'] },
  ]);
});
it('uses individual reads only when readBatch was not advertised', async () => {
  const f = await setup(false);
  await f.bridge.read({ handle: f.handle, domains: ['memory', 'lsp'] });
  expect(f.commands).toEqual([
    { kind: 'read', domain: 'memory' },
    { kind: 'read', domain: 'lsp' },
  ]);
});
it('rejects an unrelated result or a batch with no progress', async () => {
  const f = await setup(true);
  f.request.mockImplementation(async (_identity, _path, _method, body) => ({
    requestId: (body as { requestId: string }).requestId,
    status: 'complete',
    result: { ok: true, entries: [], remainingDomains: ['memory', 'lsp'] },
  }));
  await expect(f.bridge.read({ handle: f.handle, domains: ['memory', 'lsp'] })).rejects.toThrow(
    'INVALID_RESPONSE',
  );
});
