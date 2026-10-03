import { describe, expect, it } from 'vitest';

import {
  remoteContentScriptsUnverified,
  type InstallScriptsTrust,
} from '../installScriptsTrust';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const FROM = 'd'.repeat(40);
const REWRITTEN = 'e'.repeat(40);

function trust(
  overrides: Partial<InstallScriptsTrust> & { ancestry?: Array<[string, string]> } = {},
): InstallScriptsTrust {
  const ancestry = new Set((overrides.ancestry ?? []).map(([a, b]) => `${a}>${b}`));
  return {
    unverifiedRemote: overrides.unverifiedRemote ?? (() => []),
    rewrites: overrides.rewrites ?? (() => []),
    published: overrides.published ?? (() => []),
    contains: overrides.contains ?? (async (a, b) => ancestry.has(`${a}>${b}`)),
  };
}

describe('remoteContentScriptsUnverified', () => {
  it('runs the scripts of this computer’s own content', async () => {
    await expect(remoteContentScriptsUnverified(A, trust())).resolves.toBe(false);
  });

  it('skips the scripts while a taken-over fork tip is not verified', async () => {
    await expect(
      remoteContentScriptsUnverified(A, {
        ...trust({ ancestry: [[TIP, A]] }),
        unverifiedRemote: () => [TIP],
      }),
    ).resolves.toBe(true);
  });

  it('runs the scripts again once a generated personal version covers the tip', async () => {
    await expect(
      remoteContentScriptsUnverified(A, {
        ...trust({ ancestry: [[TIP, A], [TIP, B]] }),
        unverifiedRemote: () => [TIP],
        published: () => [B],
      }),
    ).resolves.toBe(false);
  });

  it('does not block on fork tips this task does not contain', async () => {
    await expect(
      remoteContentScriptsUnverified(A, {
        ...trust(),
        unverifiedRemote: () => [TIP],
      }),
    ).resolves.toBe(false);
  });

  it('keeps the provenance across an adopted rewrite of the taken-over content', async () => {
    // An official update rebased the personal commits: the content survives under
    // new hashes, and the unverified tip travels through the rewrite record.
    const rewritten = {
      ...trust({ ancestry: [[TIP, FROM], [REWRITTEN, A]] }),
      unverifiedRemote: () => [TIP],
      rewrites: () => [{ from: [FROM], to: REWRITTEN }],
    };
    await expect(remoteContentScriptsUnverified(A, rewritten)).resolves.toBe(true);
    // A version published from somewhere else does not verify the rewritten content…
    await expect(
      remoteContentScriptsUnverified(A, { ...rewritten, published: () => [B] }),
    ).resolves.toBe(true);
    // …but a generated personal version that covers it does.
    await expect(
      remoteContentScriptsUnverified(A, {
        ...rewritten,
        published: () => [B],
        contains: async (a, b) =>
          new Set([`${TIP}>${FROM}`, `${REWRITTEN}>${B}`]).has(`${a}>${b}`),
      }),
    ).resolves.toBe(false);
  });

  it('decides conservatively for an unreadable base commit', async () => {
    await expect(remoteContentScriptsUnverified('not-a-commit', trust())).resolves.toBe(true);
  });

  it('surfaces Git failures so the caller can skip the scripts', async () => {
    await expect(
      remoteContentScriptsUnverified(A, {
        ...trust(),
        unverifiedRemote: () => [TIP],
        contains: async () => {
          throw Object.assign(new Error('git failed'), { exitCode: 128 });
        },
      }),
    ).rejects.toThrow('git failed');
  });
});
