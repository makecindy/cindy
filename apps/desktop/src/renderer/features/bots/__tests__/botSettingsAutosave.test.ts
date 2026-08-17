import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botCapabilitiesEqual,
  botSettingsPayloadEqual,
  createBotSettingsAutosave,
  normalizeBotSettingsPayload,
  type BotAutosaveStatus,
  type BotSettingsPayload,
} from '../botSettingsAutosave';
import type { BotCapabilities } from '../botStore';

function capabilities(overrides: Partial<BotCapabilities> = {}): BotCapabilities {
  return {
    model: 'claude-x',
    providerId: null,
    effort: 'medium',
    fastMode: false,
    harness: 'claude',
    skillMode: 'inherit',
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    automation: false,
    permissions: 'ask',
    sessionControlMode: 'none',
    ...overrides,
  };
}

function payload(overrides: Partial<BotSettingsPayload> = {}): BotSettingsPayload {
  return {
    name: 'PR steward',
    description: 'Delivery steward',
    identitySource: '',
    userContextSource: '',
    avatar: '🧭',
    avatarColor: 'violet',
    capabilities: capabilities(),
    skills: [],
    ...overrides,
  };
}

/**
 * Test harness: a mutable "current draft" + a baseline that only advances on a
 * successful commit — exactly the contract the React hook implements.
 */
function harness(options: { textDelayMs?: number; instantDelayMs?: number } = {}) {
  let current = payload();
  let baseline = payload();
  const commits: BotSettingsPayload[] = [];
  const statuses: BotAutosaveStatus[] = [];
  let failNext = 0;
  let resolveGate: (() => void) | null = null;

  const autosave = createBotSettingsAutosave({
    textDelayMs: options.textDelayMs ?? 1200,
    instantDelayMs: options.instantDelayMs ?? 0,
    readPayload: () => current,
    readBaseline: () => baseline,
    commit: async (next) => {
      commits.push(next);
      if (resolveGate) {
        await new Promise<void>((resolve) => {
          resolveGate = resolve;
        });
      }
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('ipc failed');
      }
      baseline = next;
    },
    onStatusChange: (status) => statuses.push(status),
  });

  return {
    autosave,
    commits,
    statuses,
    edit(patch: Partial<BotSettingsPayload>) {
      current = { ...current, ...patch };
    },
    get baseline() {
      return baseline;
    },
    failNextCommits(count: number) {
      failNext = count;
    },
    /** Hold the next commit open so a trailing edit lands mid-flight. */
    gate() {
      resolveGate = () => undefined;
      return {
        release: () => {
          const resolve = resolveGate;
          resolveGate = null;
          resolve?.();
        },
      };
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeBotSettingsPayload', () => {
  it('trims name/description and falls back to the existing Bot name when cleared', () => {
    const result = normalizeBotSettingsPayload(
      {
        name: '   ',
        description: '  spaced  ',
        identitySource: '  kept as typed  ',
        userContextSource: '',
        avatar: '🧭',
        avatarColor: 'violet',
        capabilities: capabilities(),
        skills: [],
      },
      'PR steward',
    );

    expect(result.name).toBe('PR steward');
    expect(result.description).toBe('spaced');
    // Long-form prompt text is stored verbatim: trimming it would silently edit
    // the user's system prompt.
    expect(result.identitySource).toBe('  kept as typed  ');
  });

  it('produces an equal snapshot for the baseline and the untouched draft', () => {
    const draft = {
      name: 'PR steward',
      description: '  padded  ',
      identitySource: '',
      userContextSource: '',
      avatar: '🧭',
      avatarColor: 'violet',
      capabilities: capabilities(),
      skills: [],
    };
    // The mount-time baseline goes through the same normalizer, so a padded
    // stored value must not read as dirty on open (which would write to disk —
    // and on an archived Bot, write at all).
    expect(
      botSettingsPayloadEqual(
        normalizeBotSettingsPayload(draft, 'PR steward'),
        normalizeBotSettingsPayload(draft, 'PR steward'),
      ),
    ).toBe(true);
  });
});

describe('botSettingsPayloadEqual', () => {
  it('detects changes in every persisted field', () => {
    const base = payload();
    expect(botSettingsPayloadEqual(base, payload())).toBe(true);
    expect(botSettingsPayloadEqual(base, payload({ name: 'Other' }))).toBe(false);
    expect(botSettingsPayloadEqual(base, payload({ identitySource: 'x' }))).toBe(false);
    expect(botSettingsPayloadEqual(base, payload({ avatar: '🤖' }))).toBe(false);
    expect(botSettingsPayloadEqual(base, payload({ avatarColor: 'teal' }))).toBe(false);
    expect(botSettingsPayloadEqual(base, payload({ skills: ['review'] }))).toBe(false);
    expect(
      botSettingsPayloadEqual(base, payload({ capabilities: capabilities({ memory: false }) })),
    ).toBe(false);
    expect(
      botSettingsPayloadEqual(
        base,
        payload({ capabilities: capabilities({ mcpServers: ['a'] }) }),
      ),
    ).toBe(false);
  });

  it('treats a null and an undefined providerId as the same "none"', () => {
    // The store normalizes to null while local state may hold undefined; a
    // phantom diff here would autosave on every page open.
    expect(
      botCapabilitiesEqual(capabilities({ providerId: null }), capabilities({ providerId: undefined })),
    ).toBe(true);
  });

  it('notices a capability key the equality helper was never told about', () => {
    const extended = { ...capabilities(), futureFlag: true } as unknown as BotCapabilities;
    expect(botCapabilitiesEqual(capabilities(), extended)).toBe(false);
  });
});

describe('createBotSettingsAutosave scheduling', () => {
  it('merges a typing burst into a single commit after the debounce window', async () => {
    const h = harness();
    for (const name of ['P', 'PR', 'PR s', 'PR st']) {
      h.edit({ name });
      h.autosave.schedule('text');
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(h.commits).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1200);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.name).toBe('PR st');
  });

  it('commits a discrete selection right away and merges the whole burst into one call', async () => {
    const h = harness();
    // One interaction in the capability editor can write capabilities and skills
    // in the same handler; both must land as a single IPC.
    h.edit({ capabilities: capabilities({ skillMode: 'allowlist' }), skills: ['review'] });
    h.autosave.schedule('instant');
    h.autosave.schedule('instant');

    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.skills).toEqual(['review']);
  });

  it('does not let later typing postpone a pending discrete selection', async () => {
    const h = harness();
    h.edit({ capabilities: capabilities({ memory: false }) });
    h.autosave.schedule('instant');
    h.edit({ name: 'Typed too' });
    h.autosave.schedule('text');

    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits).toHaveLength(1);
    // The toggle's prompt save carries the freshly typed text along with it.
    expect(h.commits[0]?.name).toBe('Typed too');
  });

  it('sends no IPC when the scheduled burst left the payload unchanged', async () => {
    const h = harness();
    // Typed and reverted: the payload is back to the saved snapshot.
    h.edit({ name: 'PR stewardX' });
    h.edit({ name: 'PR steward' });
    h.autosave.schedule('text');
    await vi.advanceTimersByTimeAsync(1200);

    expect(h.commits).toHaveLength(0);
    expect(h.statuses).toEqual([]);
  });

  it('sends no second IPC when a later burst re-reaches the saved snapshot', async () => {
    const h = harness();
    h.edit({ description: 'changed' });
    h.autosave.schedule('text');
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.commits).toHaveLength(1);

    h.autosave.schedule('text');
    await vi.advanceTimersByTimeAsync(1200);
    expect(h.commits).toHaveLength(1);
  });

  it('reports saving then saved, and stays quiet when there is nothing to save', async () => {
    const h = harness();
    h.edit({ description: 'changed' });
    h.autosave.schedule('instant');
    await vi.advanceTimersByTimeAsync(0);

    expect(h.statuses).toEqual(['saving', 'saved']);
  });
});

describe('createBotSettingsAutosave flush & failure', () => {
  it('flush() commits immediately instead of waiting out the debounce', async () => {
    const h = harness();
    h.edit({ identitySource: 'You are a delivery steward.' });
    h.autosave.schedule('text');

    await h.autosave.flush();
    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.identitySource).toBe('You are a delivery steward.');

    // The cancelled debounce timer must not fire a second, redundant IPC.
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.commits).toHaveLength(1);
  });

  it('flush() is a no-op when nothing changed', async () => {
    const h = harness();
    await h.autosave.flush();
    expect(h.commits).toHaveLength(0);
  });

  it('flushDetached() fires the pending commit on unmount', () => {
    const h = harness();
    h.edit({ description: 'typed then left' });
    h.autosave.schedule('text');

    h.autosave.flushDetached();

    expect(h.commits).toHaveLength(1);
    expect(h.commits[0]?.description).toBe('typed then left');
  });

  it('flushDetached() writes nothing when the page was never edited', () => {
    // Guards the read-only surfaces (archived Bot) against an autosave-induced write.
    const h = harness();
    h.autosave.flushDetached();
    expect(h.commits).toHaveLength(0);
  });

  it('flushDetached() stops emitting status once the component is gone', async () => {
    const h = harness();
    h.edit({ description: 'typed then left' });
    h.autosave.flushDetached();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.statuses).toEqual([]);
  });

  it('re-commits the trailing edit that landed while a save was in flight', async () => {
    const h = harness();
    const gate = h.gate();
    h.edit({ description: 'first' });
    void h.autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits).toHaveLength(1);

    // Edited again mid-flight: dropping this would lose the last keystrokes.
    h.edit({ description: 'second' });
    h.autosave.schedule('instant');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits).toHaveLength(1);

    gate.release();
    await vi.advanceTimersByTimeAsync(10);
    expect(h.commits).toHaveLength(2);
    expect(h.commits[1]?.description).toBe('second');
  });

  it('surfaces an error, keeps the change dirty, and retries on demand', async () => {
    const h = harness();
    h.failNextCommits(1);
    h.edit({ description: 'changed' });
    await h.autosave.flush();

    expect(h.statuses).toEqual(['saving', 'error']);
    expect(h.autosave.isDirty()).toBe(true);
    expect(h.baseline.description).toBe('Delivery steward');

    await h.autosave.retry();
    expect(h.commits).toHaveLength(2);
    expect(h.autosave.isDirty()).toBe(false);
    expect(h.statuses).toEqual(['saving', 'error', 'saving', 'saved']);
  });

  it('cancel() drops the pending timer without committing', async () => {
    const h = harness();
    h.edit({ description: 'changed' });
    h.autosave.schedule('text');
    h.autosave.cancel();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.commits).toHaveLength(0);
  });
});
