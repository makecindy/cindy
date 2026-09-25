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

const reviewedDigest = 'a'.repeat(64);
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
