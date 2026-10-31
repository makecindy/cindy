/**
 * Unit, keys/SSH step through the production request/answer pair
 * (docs/product-rules/new-device-setup-migration.md §3 invariant 1). The source handler is the one
 * dispatch calls; the target client talks to it through a fake invoke, so sealing and opening use
 * the real crypto. New step: no existing coverage. Minimal inputs: one provider key, one refusal,
 * one tampered reply, a second request while the first prompt is open.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SetupSecretBundle, SetupTransferRequest } from '@cindy/device-link';

import {
  SetupTransferBox,
  createSetupTransferSource,
  requestSetupTransfer,
  type SetupTransferPrompt,
  type SetupTransferSourceDeps,
} from '../transfer.js';

const BUNDLE: SetupSecretBundle = {
  providers: [{ id: 'or', config: { id: 'or', runtimes: {} }, keys: { codex: 'sk-test-only' } }],
  mcpServers: [],
  builtinKeys: [],
  plugins: [],
};

function source(overrides: Partial<SetupTransferSourceDeps> = {}) {
  let owner: string | null = 'owner-a';
  const prompts: SetupTransferPrompt[] = [];
  const deps: SetupTransferSourceDeps = {
    ownerKey: () => owner,
    requesterName: async (id) => (id === 'dev-new' ? 'New MacBook' : null),
    describeSecrets: async (request) => request.providers.map((id) => `Provider ${id}`),
    describeSshHosts: async (hosts) => [...hosts],
    sshKeyFingerprint: () => 'SHA256:test',
    confirm: vi.fn(async (prompt: SetupTransferPrompt) => {
      prompts.push(prompt);
      return true;
    }),
    collectSecrets: vi.fn(async () => BUNDLE),
    authorizeSsh: vi.fn(async () => []),
    ...overrides,
  };
  const handle = createSetupTransferSource(deps);
  return { deps, handle, prompts, setOwner: (next: string | null) => (owner = next) };
}

function client(handle: ReturnType<typeof source>['handle'], tamper?: (reply: Record<string, unknown>) => void) {
  return {
    invoke: async (_deviceId: string, request: SetupTransferRequest) => {
      try {
        const reply = (await handle(JSON.parse(JSON.stringify(request)), 'dev-new')) as unknown as Record<string, unknown>;
        if (typeof reply.sealed === 'string') tamper?.(reply);
        return reply;
      } catch (error) {
        // dispatch turns handler errors into `[CODE] …` messages.
        throw Object.assign(new Error(`[${(error as Error).message}] setup transfer unavailable`), { code: 'IPC_ERROR' });
      }
    },
    randomId: () => 'request-0001',
  };
}

describe('setup transfer', () => {
  it('copies keys only after the person there allowed it, showing the same code on both computers', async () => {
    const { handle, prompts } = source();
    const codes: string[] = [];
    const outcome = await requestSetupTransfer(client(handle), {
      deviceId: 'dev-old',
      secrets: { providers: ['or'], mcpServers: [], builtinKeys: [], plugins: [] },
      ssh: null,
      onCode: (code) => codes.push(code),
    });
    expect(outcome.secrets).toEqual(BUNDLE);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ requester: 'New MacBook', secrets: ['Provider or'], ssh: null });
    expect(codes).toEqual([prompts[0].code]);
    expect(prompts[0].code).toMatch(/^\d{6}$/);
  });

  it('reads nothing when refused, and the new computer learns why', async () => {
    const collectSecrets = vi.fn(async () => BUNDLE);
    const { handle } = source({ confirm: async () => false, collectSecrets });
    await expect(
      requestSetupTransfer(client(handle), {
        deviceId: 'dev-old',
        secrets: { providers: ['or'], mcpServers: [], builtinKeys: [], plugins: [] },
        ssh: null,
        onCode: () => {},
      }),
    ).rejects.toThrow('SETUP_TRANSFER_DECLINED');
    expect(collectSecrets).not.toHaveBeenCalled();
  });

  it('rejects a reply that was changed on the way', async () => {
    const { handle } = source();
    const flip = (reply: Record<string, unknown>) => {
      const sealed = reply.sealed as string;
      reply.sealed = `${sealed.slice(0, -2)}${sealed.endsWith('AA') ? 'BB' : 'AA'}`;
    };
    await expect(
      requestSetupTransfer(client(handle, flip), {
        deviceId: 'dev-old',
        secrets: { providers: ['or'], mcpServers: [], builtinKeys: [], plugins: [] },
        ssh: null,
        onCode: () => {},
      }),
    ).rejects.toThrow('SETUP_TRANSFER_INVALID');
  });

  it('answers one request at a time and stops if the account changed while asking', async () => {
    let release: (allowed: boolean) => void = () => {};
    const confirm = vi.fn(() => new Promise<boolean>((resolve) => (release = resolve)));
    const harness = source({ confirm });
    const request = {
      action: 'transfer',
      requestId: 'request-0001',
      publicKey: new SetupTransferBox().publicKey,
      secrets: { providers: ['or'] },
      ssh: null,
    };
    const first = harness.handle(request, 'dev-new');
    await expect(harness.handle(request, 'dev-new')).rejects.toThrow('SETUP_TRANSFER_BUSY');
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    harness.setOwner('owner-b');
    release(true);
    await expect(first).rejects.toThrow('SETUP_SOURCE_UNAVAILABLE');
    expect(harness.deps.collectSecrets).not.toHaveBeenCalled();
  });
});
