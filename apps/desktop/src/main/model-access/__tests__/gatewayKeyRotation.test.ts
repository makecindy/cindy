import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GatewayCodexRestartService } from '../../maker-ipc/gatewayCodexRestart.js';
import { CodexCredentialModeSwitchBusyError } from '../../maker-host/codex-credential-switch.js';

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

// Execute the production writer with boundary/IO fixtures, without initializing
// Electron or the model catalog. No copied implementation or source assertions.
const source = ts.createSourceFile('index.ts', readFileSync(path.resolve(__dirname, '../index.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const writer = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'writeXdKeyWithCodexSideEffect')!;
const compiled = ts.transpileModule(writer.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(schedule = vi.fn(), beforeStore = () => {}) {
  const owner = { scope: 'cloud:account-a:1', pending: false };
  const write = vi.fn(() => true);
  const notify = vi.fn();
  const context = vm.createContext({
    activeOwnerScopeKey: () => owner.scope,
    isAppSessionBoundaryPending: () => owner.pending,
    scheduleCodexGatewayKeyRefresh: schedule,
    getProviderSecretStore: () => { beforeStore(); return { set: write }; },
    notifyXdProviderKeyChanged: notify,
    log: { warn: vi.fn() },
  });
  const rotate = vm.runInContext(`${compiled}\nwriteXdKeyWithCodexSideEffect`, context) as (key: string) => Promise<boolean>;
  return { owner, schedule, write, notify, rotate };
}

describe('gateway key rotation writer', () => {
  it('saves the key synchronously before scheduling gateway host refresh', async () => {
    const h = harness();
    h.schedule.mockImplementation(() => { expect(h.write).toHaveBeenCalledOnce(); });
    const result = h.rotate('invalid-test-key');
    expect(h.write).toHaveBeenCalledExactlyOnceWith('xd', 'invalid-test-key');
    expect(await result).toBe(true);
    expect(h.notify).toHaveBeenCalledOnce();
    expect(h.schedule).toHaveBeenCalledOnce();
  });

  it('does not start a rotation during account handoff', async () => {
    const h = harness();
    h.owner.pending = true;
    expect(await h.rotate('invalid-test-key')).toBe(false);
    expect(h.schedule).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it.each(['different-owner', 'same-owner-new-generation', 'handoff-pending'])('does not write across an owner boundary: %s', async change => {
    const h = harness(vi.fn(), () => {
      if (change === 'different-owner') h.owner.scope = 'cloud:account-b:2';
      if (change === 'same-owner-new-generation') h.owner.scope = 'cloud:account-a:3';
      if (change === 'handoff-pending') h.owner.pending = true;
    });
    expect(await h.rotate('invalid-account-a-key')).toBe(false);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });

  it.each(['busy', 'starting', 'credential change in progress'])('still saves the key when host refresh is deferred: %s', async reason => {
    let blocked = true;
    const restarted = vi.fn();
    const service = new GatewayCodexRestartService({
      listHostKeys: () => ['gateway'],
      hasBusySession: () => reason === 'busy' && blocked,
      listSessionIds: () => ['gateway-session'],
      restartHost: async (_key, stillValid) => {
        if (blocked) throw new CodexCredentialModeSwitchBusyError([]);
        if (await stillValid()) restarted();
      },
      onQueueGateReleased: vi.fn(),
    });
    const h = harness(vi.fn(() => service.schedule()));
    try {
      expect(await h.rotate('invalid-new-key')).toBe(true);
      expect(h.write).toHaveBeenCalledExactlyOnceWith('xd', 'invalid-new-key');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(restarted).not.toHaveBeenCalled();
      blocked = false;
      service.onSessionSettled();
      await vi.advanceTimersByTimeAsync(0);
      expect(restarted).toHaveBeenCalledOnce();
    } finally { service.clear(); }
  });

  it('keeps the successful write result if restart scheduling fails', async () => {
    const h = harness(vi.fn(() => { throw new Error('host unavailable'); }));
    expect(await h.rotate('invalid-test-key')).toBe(true);
    expect(h.write).toHaveBeenCalledOnce();
  });

  it('does not schedule a restart when credential storage rejects the write', async () => {
    const h = harness();
    h.write.mockReturnValue(false);
    expect(await h.rotate('invalid-test-key')).toBe(false);
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.schedule).not.toHaveBeenCalled();
  });
});
