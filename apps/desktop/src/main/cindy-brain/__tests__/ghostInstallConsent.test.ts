import { getPluginToolUi } from '@cindy/plugin-protocol';
import { describe, expect, it, vi } from 'vitest';

import {
  validateGhostManifest,
  type GhostInstallApproval,
  type GhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import {
  abortAllGhostInstallConsentPrompts,
  assertGhostInstallConsent,
  confirmedTaskCapability,
  confirmedUiCapability,
  type GhostInstallConsentPrompt,
  isGhostInstallConsentRequiredError,
  obtainGhostInstallConsent,
  trackGhostInstallConsentPrompt,
} from '../ghostInstallConsent.js';

function manifest(hosts: string[], version = '1.0.0'): GhostManifest {
  const result = validateGhostManifest({
    schemaVersion: 3,
    minCindyVersion: '0.1.61',
    id: 'weather-chip',
    name: 'Weather',
    version,
    kind: 'chip',
    entry: 'main.js',
    network: { hosts },
  });
  if (!result.ok) throw new Error('invalid fixture');
  return result.manifest;
}

function installed(
  base: GhostManifest,
  approval: GhostInstallApproval = {
    state: 'approved',
    revision: '00000000-0000-4000-8000-000000000001',
  },
): InstalledGhost {
  return {
    manifest: base,
    dir: '/userData/cindy-brain/weather-chip',
    enabled: true,
    approval,
  };
}

const userPrompt = (answer: boolean | Error) =>
  vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });

const reviewedDigest = 'a'.repeat(64);
// A change of source needs account-impact consent even without new permissions.
it('forces a source-change confirmation and pins it to the receiver receipt', async () => {
  const next = manifest(['api.weather.test']), old = installed(next), prompt = userPrompt(true);
  const decision = await obtainGhostInstallConsent({ mode: 'prompt', prompt, initiator: 'agent', origin: 'forge', force: true,
    target: { namespace: null, sourceChanged: true, otherCopies: 1 } }, old, next, reviewedDigest);
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ target: { namespace: null, sourceChanged: true, otherCopies: 1 }, facts: expect.objectContaining({ kind: 'update', added: [] }) }));
  assertGhostInstallConsent(decision, old, next, reviewedDigest);
  expect(() => assertGhostInstallConsent(decision, installed(next, { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' }), next, reviewedDigest)).toThrow();
  await expect(obtainGhostInstallConsent({ mode: 'prompt', prompt: userPrompt(false), initiator: 'agent', origin: 'forge', force: true }, old, next, reviewedDigest)).rejects.toThrow();
});
it('records tasks only when that capability was included in explicit install/update consent', async () => {
  const next = {...manifest(['api.weather.test']),agent:{tasks:true as const}};
  const policy = {mode:'prompt' as const,prompt:userPrompt(true),initiator:'user' as const,origin:'market' as const};
  const decision = await obtainGhostInstallConsent(policy,null,next,reviewedDigest);
  assertGhostInstallConsent(decision,null,next,reviewedDigest);
  expect(confirmedTaskCapability(decision,null,next)).toBe(true);
  expect(confirmedTaskCapability({mode:'exempt',reason:'server-default-install'},null,next)).toBeUndefined();
  expect(confirmedTaskCapability({mode:'unprompted'},null,next)).toBeUndefined();
  const old = installed(next);
  const expanded = {...next,network:{hosts:['api.weather.test','other.test']}};
  const unrelated = await obtainGhostInstallConsent(policy,old,expanded,reviewedDigest);
  assertGhostInstallConsent(unrelated,old,expanded,reviewedDigest);
  expect(confirmedTaskCapability(unrelated,old,expanded)).toBeUndefined();
});
const replacedDigest = 'b'.repeat(64);

describe('obtainGhostInstallConsent', () => {
  it('prompts on first install and returns a confirmed decision', async () => {
    const prompt = userPrompt(true);
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt, initiator: 'user', origin: 'market' },
      null,
      manifest(['api.weather.test']),
      reviewedDigest,
    );
    expect(decision.mode).toBe('confirmed');
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({ initiator: 'user', origin: 'market', facts: expect.objectContaining({ kind: 'install' }) }),
    );
  });

  it('does not prompt for an update without new permissions', async () => {
    const prompt = userPrompt(true);
    await expect(
      obtainGhostInstallConsent(
        { mode: 'prompt', prompt, initiator: 'agent', origin: 'forge' },
        installed(manifest(['api.weather.test'])),
        manifest(['api.weather.test'], '1.1.0'),
        reviewedDigest,
      ),
    ).resolves.toEqual({ mode: 'unprompted' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('cancels when the user declines and fails closed when no prompt can be shown', async () => {
    const policy = (answer: boolean | Error) =>
      ({ mode: 'prompt', prompt: userPrompt(answer), initiator: 'user', origin: 'local-file' }) as const;
    await expect(
      obtainGhostInstallConsent(policy(false), null, manifest(['api.weather.test']), reviewedDigest),
    ).rejects.toMatchObject({ code: 'MUTATION_CANCELLED' });
    await expect(
      obtainGhostInstallConsent(
        policy(new Error('no window')),
        null,
        manifest(['api.weather.test']),
        reviewedDigest,
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('never confirms on the user’s behalf for background updates', async () => {
    const error = await obtainGhostInstallConsent(
      { mode: 'automatic' },
      installed(manifest(['api.weather.test'])),
      manifest(['api.weather.test', 'upload.weather.test'], '2.0.0'),
      reviewedDigest,
    ).catch((caught: unknown) => caught);
    expect(isGhostInstallConsentRequiredError(error)).toBe(true);
    await expect(
      obtainGhostInstallConsent(
        { mode: 'automatic' },
        installed(manifest(['api.weather.test'])),
        manifest(['api.weather.test'], '1.1.0'),
        reviewedDigest,
      ),
    ).resolves.toEqual({ mode: 'unprompted' });
  });

  it('skips confirmation only for server default installs', async () => {
    await expect(
      obtainGhostInstallConsent(
        { mode: 'exempt', reason: 'server-default-install' },
        null,
        manifest(['api.weather.test']),
        reviewedDigest,
      ),
    ).resolves.toEqual({ mode: 'exempt', reason: 'server-default-install' });
  });
});

describe('assertGhostInstallConsent', () => {
  it('accepts the exact package and receiver the user confirmed', async () => {
    const next = manifest(['api.weather.test', 'upload.weather.test'], '2.0.0');
    const current = installed(manifest(['api.weather.test']));
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt: userPrompt(true), initiator: 'user', origin: 'market' },
      current,
      next,
      reviewedDigest,
    );
    expect(() => assertGhostInstallConsent(decision, current, next, reviewedDigest)).not.toThrow();
  });

  it('rejects when the package gained permissions after confirmation', async () => {
    const current = installed(manifest(['api.weather.test']));
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt: userPrompt(true), initiator: 'user', origin: 'market' },
      current,
      manifest(['api.weather.test', 'upload.weather.test'], '2.0.0'),
      reviewedDigest,
    );
    expect(() =>
      assertGhostInstallConsent(
        decision,
        current,
        manifest(['api.weather.test', 'upload.weather.test', 'extra.weather.test'], '2.0.0'),
        reviewedDigest,
      ),
    ).toThrow(/PRECONDITION_FAILED/);
  });

  it('rejects when the reviewed package bytes are replaced after confirmation', async () => {
    const next = manifest(['api.weather.test']);
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt: userPrompt(true), initiator: 'user', origin: 'market' },
      null,
      next,
      reviewedDigest,
    );
    expect(() => assertGhostInstallConsent(decision, null, next, reviewedDigest)).not.toThrow();
    expect(() => assertGhostInstallConsent(decision, null, next, replacedDigest)).toThrow(
      /PRECONDITION_FAILED/,
    );
  });

  it('rejects a confirmed update when the receiver receipt changed but version and permissions did not', async () => {
    const current = installed(manifest(['api.weather.test']));
    const next = manifest(['api.weather.test', 'upload.weather.test'], '2.0.0');
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt: userPrompt(true), initiator: 'user', origin: 'forge' },
      current,
      next,
      reviewedDigest,
    );
    const replacedReceiver = installed(manifest(['api.weather.test']), {
      state: 'approved',
      revision: '00000000-0000-4000-8000-000000000002',
    });
    expect(() => assertGhostInstallConsent(decision, replacedReceiver, next, reviewedDigest)).toThrow(
      /PRECONDITION_FAILED/,
    );
  });

  it('rejects a confirmed update once the receiver already covers the candidate permissions', async () => {
    const v1 = installed(manifest(['api.weather.test']));
    const v2 = manifest(['api.weather.test', 'upload.weather.test'], '2.0.0');
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt: userPrompt(true), initiator: 'user', origin: 'market' },
      v1,
      v2,
      reviewedDigest,
    );
    const v3 = installed(manifest(['api.weather.test', 'upload.weather.test'], '3.0.0'));
    expect(() => assertGhostInstallConsent(decision, v3, v2, reviewedDigest)).toThrow(
      /PRECONDITION_FAILED/,
    );
  });

  it('still accepts an originally unprompted decision when consent is no longer needed', () => {
    expect(() =>
      assertGhostInstallConsent(
        { mode: 'unprompted' },
        installed(manifest(['api.weather.test'], '3.0.0')),
        manifest(['api.weather.test'], '2.0.0'),
        reviewedDigest,
      ),
    ).not.toThrow();
  });

  it('rejects an unprompted decision once the install turns out to need consent', () => {
    const error = (() => {
      try {
        assertGhostInstallConsent(
          { mode: 'unprompted' },
          null,
          manifest(['api.weather.test']),
          reviewedDigest,
        );
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    expect(isGhostInstallConsentRequiredError(error)).toBe(true);
  });

  it('lets a server default install through without a prompt', () => {
    expect(() =>
      assertGhostInstallConsent(
        { mode: 'exempt', reason: 'server-default-install' },
        installed(manifest(['api.weather.test'])),
        manifest(['api.weather.test', 'upload.weather.test'], '2.0.0'),
        reviewedDigest,
      ),
    ).not.toThrow();
  });
});

describe('pending consent prompts', () => {
  it('are aborted together at an account boundary', () => {
    const first = new AbortController();
    const second = new AbortController();
    trackGhostInstallConsentPrompt(first);
    const untrack = trackGhostInstallConsentPrompt(second);
    untrack();
    abortAllGhostInstallConsentPrompts();
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });
});

it('records target consent only when the independent capability was shown', async () => {
  const previous = { ...manifest(['api.weather.test']), agent: { tasks: true } };
  const next = { ...previous, agent: { tasks: true, targets: true } };
  const prompt = userPrompt(true);
  const policy = { mode: 'prompt' as const, prompt, initiator: 'user' as const, origin: 'market' as const };
  const before = installed(previous);
  const decision = await obtainGhostInstallConsent(policy, before, next, reviewedDigest);
  assertGhostInstallConsent(decision, before, next, reviewedDigest);
  expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ added: [expect.objectContaining({ key: 'agent:targets' })] }) }));
  expect(confirmedTaskCapability(decision, before, next, 'targets')).toBe(true);
  expect(confirmedTaskCapability(decision, before, next)).toBeUndefined();
  expect(confirmedTaskCapability({ mode: 'unprompted' }, before, next, 'targets')).toBeUndefined();
  const alreadyDeclared = installed(next);
  const expanded = { ...next, network: { hosts: ['api.weather.test', 'other.test'] } };
  const unrelated = await obtainGhostInstallConsent(policy, alreadyDeclared, expanded, reviewedDigest);
  assertGhostInstallConsent(unrelated, alreadyDeclared, expanded, reviewedDigest);
  expect(confirmedTaskCapability(unrelated, alreadyDeclared, expanded, 'targets')).toBeUndefined();
});

// Page capability is additive: old receipts retain the declaration but do not grant
// file reads. Existing generic permission tests do not cover app-only tool authority.
describe('interactive page consent', () => {
  function pages(): GhostManifest {
    return { ...manifest(['api.weather.test']), tools: [{ name: 'open', description: 'Open' }, { name: 'save', description: 'Save' }],
      mcpApps: { ui: { resources: [{
            uri: "ui://planner",
            file: 'ui/planner.html'
        }], tools: { open: { resourceUri: "ui://planner" }, save: { visibility: ['model'] } } } } };
  }
  it('requires explicit consent for preserved declarations and grants only the page capability', async () => {
    const { hasGhostUiPermission, validateInstalledGhostManifest } = await import('../../../shared/ghost.js');
    const { confirmedUiCapability } = await import('../ghostInstallConsent.js');
    const base = pages(), old = installed(base), prompt = userPrompt(true);
    expect(validateInstalledGhostManifest(base)).toMatchObject({ ok: true, manifest: { mcpApps: base.mcpApps } });
    expect(hasGhostUiPermission(old)).toBe(false);
    const decision = await obtainGhostInstallConsent({ mode: 'prompt', prompt, initiator: 'user', origin: 'market' }, old, base, reviewedDigest);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ added: [expect.objectContaining({ key: 'ui:pages' })] }) }));
    expect(confirmedUiCapability(decision, old, base)).toBe(true);
    expect(hasGhostUiPermission({ ...old, uiCapabilityApproved: true })).toBe(true);
    expect(hasGhostUiPermission({ ...old, uiCapabilityApproved: true, enabled: false })).toBe(false);
  });
  // unit: legacy remote installation confirms existing facts, not the newly negotiated UI capability.
  // Minimal input: accepted install with ui.pages and a prompt from a v0 controller.
  it.each([false, true])('grants pages only when the controller renders their facts (negotiated=%s)', async negotiated => {
    const next = pages();
    const prompt: GhostInstallConsentPrompt = Object.assign(userPrompt(true), { uiCapabilityApproval: negotiated });
    const decision = await obtainGhostInstallConsent({ mode: 'prompt', prompt, initiator: 'user', origin: 'market' }, null, next, reviewedDigest);
    assertGhostInstallConsent(decision, null, next, reviewedDigest);
    expect(confirmedUiCapability(decision, null, next)).toBe(negotiated);
    expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ permissions: expect.arrayContaining([
      expect.objectContaining({ key: 'ui:pages', detailKey: 'uiPageAccess', detailArgs: expect.objectContaining({ pages: 'ui://planner', tools: 'open' }) }),
    ]) }) }));
  });
  // Unit: server default delivery is the approval authority for pages, too.
  // Existing default-install tests lacked ui; minimal input adds one page to an
  // approved plugin whose old Host receipt has no uiCapabilityApproved fact.
  it.each([null, 'existing'] as const)('grants default-delivered pages with the package approval (%s)', async receiver => {
    const next = pages(), previous = manifest(['api.weather.test']);
    const old = receiver === null ? null : installed(previous);
    const decision = await obtainGhostInstallConsent({ mode: 'exempt', reason: 'server-default-install' }, old, next, reviewedDigest);
    assertGhostInstallConsent(decision, old, next, reviewedDigest);
    expect(confirmedUiCapability(decision, old, next)).toBe(true);
  });
  // URI renames are identifiers, not new authority. Exercise the install decision,
  // including rename + added domain, rather than comparing serializer strings. Tier: unit.
  it.each(['uri', 'file', 'uri-and-domain'] as const)('compares resource authority across %s changes', async kind => {
    const base = pages(), next = structuredClone(base);
    const old = { ...installed(base), uiCapabilityApproved: true as const };
    const ui = getPluginToolUi(next)!;
    if (kind === 'file') ui.resources[0].file = 'ui/replaced.html';
    else {
      ui.resources[0].uri = 'ui://renamed/v2';
      ui.tools.open.resourceUri = 'ui://renamed/v2';
    }
    if (kind === 'uri-and-domain') ui.resources[0].csp = { connectDomains: ['https://api.weather.test'] };
    const decision = obtainGhostInstallConsent({ mode: 'automatic' }, old, next, reviewedDigest);
    if (kind === 'uri-and-domain') await expect(decision).rejects.toThrow();
    else await expect(decision).resolves.toEqual({ mode: 'unprompted' });
  });
  it.each(['page', 'domain', 'app-access'] as const)('requires consent when adding %s', async kind => {
    const base = pages(), next = structuredClone(base), old = { ...installed(base), uiCapabilityApproved: true as const };
    if (kind === 'page') getPluginToolUi(next)!.resources.push({ uri: 'ui://second', file: 'ui/second.html' });
    if (kind === 'domain') getPluginToolUi(next)!.resources[0].csp = { connectDomains: ['https://api.weather.test'] };
    if (kind === 'app-access') getPluginToolUi(next)!.tools.save.visibility = ['model', 'app'];
    await expect(obtainGhostInstallConsent({ mode: 'automatic' }, old, next, reviewedDigest)).rejects.toThrow();
    const reduced = structuredClone(base); getPluginToolUi(reduced)!.tools.open.visibility = ['model'];
    await expect(obtainGhostInstallConsent({ mode: 'automatic' }, old, reduced, reviewedDigest)).resolves.toEqual({ mode: 'unprompted' });
  });
});

it('records observe consent only when that capability was shown', async () => {
  const previous = { ...manifest(['api.weather.test']), agent: { tasks: true } };
  const next = { ...previous, agent: { tasks: true, observe: true } };
  const prompt = userPrompt(true);
  const policy = { mode: 'prompt' as const, prompt, initiator: 'user' as const, origin: 'market' as const };
  const before = installed(previous);
  const decision = await obtainGhostInstallConsent(policy, before, next, reviewedDigest);
  assertGhostInstallConsent(decision, before, next, reviewedDigest);
  expect(confirmedTaskCapability(decision, before, next, 'observe')).toBe(true);
  expect(confirmedTaskCapability(decision, before, next, 'targets')).toBeUndefined();
  expect(confirmedTaskCapability({ mode: 'unprompted' }, before, next, 'observe')).toBeUndefined();
});
