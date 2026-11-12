import { readFileSync } from 'node:fs';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { MAKER_INVOKE } from '../channels';

// Execute the production registration with fake Electron dependencies, without
// starting Desktop or duplicating the handler's security checks in the test.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8');
const start = source.indexOf('ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_REVOKEINVITE,');
const end = source.indexOf('ipcMain.handle(MAKER_INVOKE.CHAT_SERVER_ACCEPTINVITE,', start);
if (start < 0 || end <= start) throw new Error('invite revoke registration not found');
const compiled = transpileModule(source.slice(start, end), {
  compilerOptions: { target: ScriptTarget.ES2022 },
}).outputText;

const input = {
  groupId: '00000000-0000-4000-8000-000000000001',
  link: `cindy://chat-invite/${'a'.repeat(43)}`,
  clientId: '00000000-0000-4000-8000-000000000002',
};
const trustedSender = {};
type Handler = (event: { sender: object }, payload: typeof input) => Promise<unknown>;

function bridge(ready = true) {
  const handlers = new Map<string, Handler>();
  const guard = vi.fn((event: { sender: object }) => {
    if (event.sender !== trustedSender) throw Object.assign(new Error('untrusted sender'), { code: 'PERMISSION_DENIED' });
  });
  const revokeInvite = vi.fn().mockResolvedValue({ ok: true, revoked: true });
  const readService = vi.fn(() => ({ revokeInvite }));
  const deps = {
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    MAKER_INVOKE,
    assertTrustedAppRendererEvent: guard,
    botGroupChatServiceHolder: ready ? { get chatServer() { return readService(); } } : null,
  };
  new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  expect([...handlers.keys()]).toEqual([MAKER_INVOKE.CHAT_SERVER_REVOKEINVITE]);
  return { guard, revokeInvite, readService, invoke: handlers.get(MAKER_INVOKE.CHAT_SERVER_REVOKEINVITE)! };
}

describe('invitation revoke IPC sender boundary', () => {
  it('rejects an untrusted sender before accessing or calling the revocation service', async () => {
    const api = bridge();
    const event = { sender: {}, trusted: true };
    await expect(api.invoke(event, input)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(api.guard).toHaveBeenCalledWith(event);
    expect(api.readService).not.toHaveBeenCalled();
    expect(api.revokeInvite).not.toHaveBeenCalled();
  });

  it('delegates the unchanged request from a trusted sender', async () => {
    const api = bridge();
    const event = { sender: trustedSender };
    await expect(api.invoke(event, input)).resolves.toEqual({ ok: true, revoked: true });
    expect(api.guard).toHaveBeenCalledWith(event);
    expect(api.guard.mock.invocationCallOrder[0]).toBeLessThan(api.readService.mock.invocationCallOrder[0]);
    expect(api.revokeInvite).toHaveBeenCalledExactlyOnceWith(input);
  });

  it('checks the sender even when the host is not ready, then returns its fallback for a trusted sender', async () => {
    const api = bridge(false);
    await expect(api.invoke({ sender: {} }, input)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(api.invoke({ sender: trustedSender }, input)).resolves.toEqual({ ok: false, errorCode: 'HOST_NOT_READY' });
    expect(api.revokeInvite).not.toHaveBeenCalled();
  });
});
