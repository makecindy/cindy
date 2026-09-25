import { describe, expect, it, vi } from 'vitest';

import {
  validateGhostManifest,
  type GhostManifest,
  type InstalledGhost,
} from '../../../shared/ghost.js';
import {
  abortAllGhostInstallConsentPrompts,
  assertGhostInstallConsent,
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

function installed(base: GhostManifest): InstalledGhost {
  return {
    manifest: base,
    dir: '/userData/cindy-brain/weather-chip',
    enabled: true,
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
  };
}

const userPrompt = (answer: boolean | Error) =>
  vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });

describe('obtainGhostInstallConsent', () => {
  it('prompts on first install and returns a confirmed decision', async () => {
    const prompt = userPrompt(true);
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt, initiator: 'user', origin: 'market' },
      null,
      manifest(['api.weather.test']),
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
      ),
    ).resolves.toEqual({ mode: 'unprompted' });
    expect(prompt).not.toHaveBeenCalled();
  });

  it('cancels when the user declines and fails closed when no prompt can be shown', async () => {
    const policy = (answer: boolean | Error) =>
      ({ mode: 'prompt', prompt: userPrompt(answer), initiator: 'user', origin: 'local-file' }) as const;
    await expect(
      obtainGhostInstallConsent(policy(false), null, manifest(['api.weather.test'])),
    ).rejects.toMatchObject({ code: 'MUTATION_CANCELLED' });
    await expect(
      obtainGhostInstallConsent(policy(new Error('no window')), null, manifest(['api.weather.test'])),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('never confirms on the user’s behalf for background updates', async () => {
    const error = await obtainGhostInstallConsent(
      { mode: 'automatic' },
      installed(manifest(['api.weather.test'])),
      manifest(['api.weather.test', 'upload.weather.test'], '2.0.0'),
    ).catch((caught: unknown) => caught);
    expect(isGhostInstallConsentRequiredError(error)).toBe(true);
    await expect(
      obtainGhostInstallConsent(
        { mode: 'automatic' },
        installed(manifest(['api.weather.test'])),
        manifest(['api.weather.test'], '1.1.0'),
      ),
    ).resolves.toEqual({ mode: 'unprompted' });
  });

  it('skips confirmation only for server default installs', async () => {
    await expect(
      obtainGhostInstallConsent(
        { mode: 'exempt', reason: 'server-default-install' },
        null,
        manifest(['api.weather.test']),
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
    );
    expect(() => assertGhostInstallConsent(decision, current, next)).not.toThrow();
  });

  it('rejects when the package gained permissions after confirmation', async () => {
    const current = installed(manifest(['api.weather.test']));
    const decision = await obtainGhostInstallConsent(
      { mode: 'prompt', prompt: userPrompt(true), initiator: 'user', origin: 'market' },
      current,
      manifest(['api.weather.test', 'upload.weather.test'], '2.0.0'),
    );
    expect(() =>
      assertGhostInstallConsent(
        decision,
        current,
        manifest(['api.weather.test', 'upload.weather.test', 'extra.weather.test'], '2.0.0'),
      ),
    ).toThrow(/PRECONDITION_FAILED/);
  });

  it('rejects an unprompted decision once the install turns out to need consent', () => {
    const error = (() => {
      try {
        assertGhostInstallConsent({ mode: 'unprompted' }, null, manifest(['api.weather.test']));
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
