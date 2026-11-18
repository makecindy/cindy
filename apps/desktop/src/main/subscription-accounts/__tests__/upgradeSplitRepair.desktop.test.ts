/** Unit tier: desktop wiring of the upgrade-split repair (subscription-account-pools.md 升级拆坏的自动并回).
 * Rule basis: 2026-11-18 user decision and review findings — record a merge before starting it,
 * settle what went through even when the command fails afterwards, read the conditions again after
 * each merge, and read the built-in provider's own on/off switch (「停用供应商」), not only its
 * disconnect. The decision and record semantics are covered in ipc.test.ts with the real stores;
 * here the stores and the merge command are replaced.
 */
import { beforeEach, expect, it, vi } from 'vitest';

type Repair = { kind: 'anthropic' | 'openai'; providerId: string };
const h = vi.hoisted(() => ({
  queue: [] as Array<Repair | null>,
  calls: [] as string[],
  failMerge: false,
  eligibleAtWrite: true,
  shareChanged: null as null | (() => void),
  installed: null as null | (() => Promise<void>),
  disabledProviders: {} as Record<string, true>,
  presentation: {} as Record<string, { name?: string }>,
  remoteAllowed: new Set<string>(),
  groups: new Set<string>(),
  shares: null as null | Array<{ providerId: string }>,
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'owner', isAppSessionBoundaryPending: () => false }));
vi.mock('../../device-link/providerShareHost.js', () => ({
  getProviderShareHostCompleteSnapshot: () => h.shares,
  onProviderShareHostChanged: (callback: () => void) => { h.shareChanged = callback; },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../maker-host/createDesktopProviderService.js', () => ({
  setUpgradeSplitRepair: (repair: () => Promise<void>) => { h.installed = repair; },
}));
vi.mock('../../maker-host/model-disable-store.js', () => ({ readModelDisableOverrides: () => ({ disabledProviders: h.disabledProviders }) }));
vi.mock('../../maker-host/provider-presentation-store.js', () => ({ readProviderPresentation: (id: string) => h.presentation[id] ?? {} }));
vi.mock('../../maker-host/remote-provider-access-store.js', () => ({ isRemoteProviderInvocationAllowed: (id: string) => h.remoteAllowed.has(id) }));
vi.mock('../../provider-group/store.js', () => ({ readProviderGroup: (id: string) => h.groups.has(id) ? { members: [] } : null }));
vi.mock('../runtime.js', () => ({
  onSubscriptionAccountSignInEvidenceChanged: vi.fn(),
  onSubscriptionAccountsChanged: vi.fn(),
  subscriptionAccountSignInEvidence: () => 'unknown',
}));
vi.mock('../service.js', () => ({
  executeSubscriptionAccountCommand: async (
    command: { action: string; providerId: string; target: string },
    assertCanMerge: () => void,
  ) => {
    assertCanMerge();
    h.calls.push(`${command.action}:${command.providerId}->${command.target}`);
    if (h.failMerge) throw new Error('busy');
  },
}));
vi.mock('../upgradeSplitRepair.js', () => ({
  findUpgradeSplitRepair: (_deps: unknown, providerId?: string) => {
    if (providerId) {
      h.calls.push('check-before-write');
      return h.eligibleAtWrite ? { providerId } : null;
    }
    h.calls.push('check');
    return h.queue.shift() ?? null;
  },
  recordUpgradeSplitRepairStarted: async (providerId: string) => { h.calls.push(`start:${providerId}`); },
  settleUpgradeSplitRepairs: async () => { h.calls.push('settle'); },
}));
import { startUpgradeSplitRepair, upgradeSplitRepairDeps } from '../upgradeSplitRepair.desktop.js';

const first: Repair = { kind: 'anthropic', providerId: 'anthropic-sub-0ff053bb' };
const second: Repair = { kind: 'anthropic', providerId: 'anthropic-sub-bd13cd38' };
startUpgradeSplitRepair();
beforeEach(() => { h.calls = []; h.queue = []; h.failMerge = false; h.eligibleAtWrite = true; });

it('records each merge before the user merge command, settles it, and checks again after every merge', async () => {
  h.queue = [first, second, null];
  await h.installed!();
  expect(h.calls).toEqual([
    'settle', 'check', `start:${first.providerId}`, 'check-before-write', `merge:${first.providerId}->anthropic`, 'settle',
    'settle', 'check', `start:${second.providerId}`, 'check-before-write', `merge:${second.providerId}->anthropic`, 'settle',
    'settle', 'check',
  ]);
});

it('settles a failed merge, ends the run and never throws', async () => {
  h.queue = [first, second];
  h.failMerge = true;
  await expect(h.installed!()).resolves.toBeUndefined();
  expect(h.calls).toEqual(['settle', 'check', `start:${first.providerId}`, 'check-before-write', `merge:${first.providerId}->anthropic`, 'settle']);
});

// One repair candidate becomes ineligible while its placement write is pending.
it('leaves the accounts in place when eligibility changes before the write', async () => {
  h.queue = [first, null];
  h.eligibleAtWrite = false;
  await h.installed!();
  expect(h.calls).toEqual(['settle', 'check', `start:${first.providerId}`, 'check-before-write', 'settle']);
});

it('checks again as soon as the owned share snapshot changes', async () => {
  h.shareChanged!();
  await h.installed!();
  expect(h.calls).toEqual(['settle', 'check', 'settle', 'check']);
});

it('reads each condition from its own setting', () => {
  h.disabledProviders = { anthropic: true };
  h.presentation = { [second.providerId]: { name: 'Mine' } };
  h.remoteAllowed = new Set([first.providerId]);
  h.groups = new Set([first.providerId]);
  h.shares = [{ providerId: second.providerId }];
  expect([upgradeSplitRepairDeps.disabled('anthropic'), upgradeSplitRepairDeps.disabled('openai')]).toEqual([true, false]);
  expect([upgradeSplitRepairDeps.renamed(second.providerId), upgradeSplitRepairDeps.renamed(first.providerId)]).toEqual([true, false]);
  expect(upgradeSplitRepairDeps.remoteInvocationAllowed(first.providerId)).toBe(true);
  expect(upgradeSplitRepairDeps.hasProviderGroup(first.providerId)).toBe(true);
  expect([...upgradeSplitRepairDeps.sharedProviderIds()!]).toEqual([second.providerId]);
  h.shares = null;
  expect(upgradeSplitRepairDeps.sharedProviderIds()).toBeNull();
});
