import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  botCapabilitiesEqual,
  botSettingsChanges,
  botSettingsPayloadEqual,
  createBotSettingsAutosave,
  normalizeBotSettingsPayload,
  reconcileBotSettingsDraft,
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
    modelChain: [{ harness: 'claude', model: 'claude-x', providerId: null, effort: 'medium', fastMode: false }],
    skillMode: 'inherit',
    skillsExcluded: [],
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    permissions: 'ask',
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
  const modelSelections: boolean[] = [];
  const statuses: BotAutosaveStatus[] = [];
  let failNext = 0;
  let resolveGate: (() => void) | null = null;

  const autosave = createBotSettingsAutosave({
    textDelayMs: options.textDelayMs ?? 1200,
    instantDelayMs: options.instantDelayMs ?? 0,
    readPayload: () => current,
    readBaseline: () => baseline,
    commit: async (next, modelSelection) => {
      commits.push(next);
      modelSelections.push(modelSelection === true);
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
    modelSelections,
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

// #10985: unit coverage through the production scheduler. Existing retry tests
// only cover transient errors; a 12001-unit changed source must never reach IPC,
// including blur/retry/unmount, while the complete draft remains editable.
it('blocks oversized edits across save boundaries and resumes after correction', async () => {
  const h = harness();
  h.edit({ identitySource: 'x'.repeat(12001) });
  h.autosave.schedule('text');
  await vi.runAllTimersAsync();
  await h.autosave.flush();
  await h.autosave.retry();
  expect(h.commits).toHaveLength(0);
  expect(h.autosave.isDirty()).toBe(true);
  expect(h.baseline.identitySource).toBe('');
  h.edit({ identitySource: '' });
  await h.autosave.flush();
  expect(h.statuses.at(-1)).toBe('idle');
  expect(h.commits).toHaveLength(0);
  h.edit({ identitySource: 'x'.repeat(12000) });
  await h.autosave.flush();
  expect(h.commits).toHaveLength(1);
  expect(h.baseline.identitySource).toHaveLength(12000);
  h.edit({ userContextSource: 'y'.repeat(12001) });
  h.autosave.flushDetached();
  await Promise.resolve();
  expect(h.commits).toHaveLength(1);
});

it('leaves an unchanged oversized source intact when other settings change', async () => {
  let baseline = payload({ identitySource: 'x'.repeat(12001) });
  let draft = { ...baseline };
  const commit = vi.fn(async (next: BotSettingsPayload) => { baseline = next; });
  const autosave = createBotSettingsAutosave({ readPayload: () => draft, readBaseline: () => baseline, commit });
  await autosave.flush();
  expect(commit).not.toHaveBeenCalled();
  draft = { ...draft, name: 'Changed name' };
  await autosave.flush();
  expect(commit).toHaveBeenCalledTimes(1);
  draft = { ...draft, identitySource: 'y' + draft.identitySource.slice(1) };
  await autosave.flush();
  expect(commit).toHaveBeenCalledTimes(1);
  expect(draft.identitySource).toHaveLength(12001);
});

it.each([
  ['  ' + 'x'.repeat(12000) + '\n', true],
  ['😀'.repeat(6000), true],
  ['😀'.repeat(6000) + 'x', false],
])('uses the host trim and UTF-16 counting for profile edits', async (value, accepted) => {
  const h = harness();
  h.edit({ identitySource: value as string });
  await h.autosave.flush();
  expect(h.commits).toHaveLength(accepted ? 1 : 0);
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
    // The host trims every profile text (`readText`); comparing the same way keeps
    // surrounding whitespace from reading as an unsaved change.
    expect(result.identitySource).toBe('kept as typed');
  });

  it('keeps whitespace still being typed when a save settles', () => {
    const saved = payload({ name: 'Filo', description: 'Own releases', identitySource: 'You ship.' });
    const draft = {
      ...saved,
      name: 'Filo ',
      description: 'Own releases\n',
      identitySource: 'You ship.\n\n',
    };
    const next = reconcileBotSettingsDraft(saved, draft, saved);
    expect(next.name).toBe('Filo ');
    expect(next.description).toBe('Own releases\n');
    expect(next.identitySource).toBe('You ship.\n\n');
    // Nothing unsaved: the whitespace alone does not trigger another save.
    expect(botSettingsPayloadEqual(normalizeBotSettingsPayload(next, 'Filo'), saved)).toBe(true);
    // A cleared name still snaps back to the saved one rather than staying blank.
    expect(reconcileBotSettingsDraft(saved, { ...draft, name: '' }, saved).name).toBe(saved.name);
    // A newer value from elsewhere still replaces an untouched field.
    expect(reconcileBotSettingsDraft(saved, saved, { ...saved, description: 'From phone' }).description).toBe('From phone');
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
  // PR #11347 review regression (unit): the public scheduler must retain a
  // reverted draft while a different snapshot may still reach persistence.
  // Previous detached coverage changed to a third value, never the old baseline.
  it.each([false, true])('keeps a reverted draft pending until the older write settles (rejected=%s)', async rejected => {
    const h = harness();
    if (rejected) h.failNextCommits(1);
    const original = h.baseline.name;
    const gate = h.gate();
    h.edit({ name: 'Temporary edit' });
    const first = h.autosave.flush();
    h.edit({ name: original });
    const leaving = h.autosave.flush();
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all([first, leaving]);
    expect(h.autosave.isDirty()).toBe(true);
    h.autosave.flushDetached();
    const statuses = [...h.statuses];
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.baseline.name).toBe(original);
    expect(h.commits.map(row => row.name)).toEqual(rejected ? ['Temporary edit'] : ['Temporary edit', original]);
    expect(h.autosave.isDirty()).toBe(false);
    expect(h.statuses).toEqual(statuses);
    expect(vi.getTimerCount()).toBe(0);
  });

  // PR #11347 review regression (unit): one public flush must share its 30s
  // budget across serial requests. Existing timeout coverage used one request.
  it('bounds concurrent navigation flushes across an earlier save and a trailing save', async () => {
    const h = harness();
    const firstGate = h.gate();
    h.edit({ name: 'First edit' });
    const first = h.autosave.flush();
    await vi.advanceTimersByTimeAsync(1000);
    h.edit({ name: 'Latest edit' });
    let returned = 0;
    const second = h.autosave.flush().then(() => { returned += 1; });
    const third = h.autosave.flush().then(() => { returned += 1; });
    await vi.advanceTimersByTimeAsync(28_000);
    firstGate.release();
    const trailingGate = h.gate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits.map(row => row.name)).toEqual(['First edit', 'Latest edit']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(returned).toBe(2);
    expect(h.statuses.at(-1)).toBe('error');
    expect(h.autosave.isDirty()).toBe(true);
    trailingGate.release();
    await Promise.all([first, second, third]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.baseline.name).toBe('Latest edit');
    expect(h.autosave.isDirty()).toBe(false);
    expect(h.statuses.at(-1)).toBe('saved');
    expect(vi.getTimerCount()).toBe(0);
  });

  // Unit regression: a host that never answers used to hold both the spinner
  // and every navigation flush forever. Existing rejection tests always settled.
  it('ends the UI wait without acknowledging or duplicating an unconfirmed write', async () => {
    const h = harness();
    const gate = h.gate();
    h.autosave.schedule('model');
    let returned = false;
    const flushing = h.autosave.flush().then(() => { returned = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.statuses).toEqual(['saving', 'error']);
    expect(returned).toBe(true);
    expect(h.autosave.hasPendingModelSelection()).toBe(true);
    await Promise.all([flushing, h.autosave.retry(), h.autosave.flush()]);
    expect(h.commits).toHaveLength(1);
    // Only the real receipt can acknowledge the choice; waiting longer or
    // pressing retry cannot manufacture success or resend an unknown write.
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.statuses.at(-1)).toBe('saved');
    expect(h.autosave.isDirty()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])('coalesces later choices after timeout without stale success (late rejection=%s)', async rejected => {
    const h = harness();
    if (rejected) h.failNextCommits(1);
    const first = h.gate();
    h.edit({ name: 'First' });
    void h.autosave.flush();
    await vi.advanceTimersByTimeAsync(30_000);
    h.edit({ name: 'Second' });
    h.autosave.schedule('model');
    await vi.advanceTimersByTimeAsync(0);
    h.edit({ name: 'Latest' });
    h.autosave.schedule('model');
    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits).toHaveLength(1);
    first.release();
    const latest = h.gate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.baseline.name).toBe(rejected ? 'PR steward' : 'First');
    expect(h.statuses).not.toContain('saved');
    expect(h.commits.map(row => row.name)).toEqual(['First', 'Latest']);
    latest.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.baseline.name).toBe('Latest');
    expect(h.autosave.isDirty()).toBe(false);
    expect(h.statuses.at(-1)).toBe('saved');
  });

  it('cleans the wait on unmount while finishing just the latest detached draft', async () => {
    const h = harness();
    const gate = h.gate();
    h.edit({ name: 'First' });
    const first = h.autosave.flush();
    h.edit({ name: 'Last before leaving' });
    h.autosave.flushDetached();
    await first;
    expect(vi.getTimerCount()).toBe(0);
    gate.release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.baseline.name).toBe('Last before leaving');
    expect(h.commits).toHaveLength(2);
    expect(h.statuses).toEqual(['saving']);
  });

  it('reports snapshot exceptions without leaving an unresolved flush', async () => {
    const statuses: BotAutosaveStatus[] = [];
    const save = createBotSettingsAutosave({ readPayload: () => { throw new Error('unavailable'); },
      readBaseline: () => payload(), commit: vi.fn(), onStatusChange: status => statuses.push(status) });
    await expect(save.flush()).resolves.toBeUndefined();
    expect(statuses).toEqual(['error']);
  });

  it('serializes multiple flushes waiting on the same earlier save', async () => {
    const h = harness();
    const firstGate = h.gate();
    h.edit({ name: 'First edit' });
    const first = h.autosave.flush();
    h.edit({ name: 'Latest edit' });
    const second = h.autosave.flush();
    const third = h.autosave.flush();
    firstGate.release();
    const secondGate = h.gate();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.commits).toHaveLength(2);
    secondGate.release();
    await Promise.all([first, second, third]);
    expect(h.commits).toHaveLength(2);
    expect(h.baseline.name).toBe('Latest edit');
    expect(h.autosave.isDirty()).toBe(false);
  });

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

  it.each(['flush', 'flushDetached'] as const)('accepts an unchanged model selection on %s, and only once', async (method) => {
    const h = harness();
    h.autosave.schedule('model');
    expect(h.autosave.isDirty()).toBe(true);
    await h.autosave[method]();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.modelSelections).toEqual([true]);
    expect(h.autosave.isDirty()).toBe(false);
    await h.autosave[method]();
    expect(h.commits).toHaveLength(1);
  });

  it('retains an unchanged model action after failure and retries it', async () => {
    const h = harness();
    h.failNextCommits(1);
    h.autosave.schedule('model');
    await h.autosave.flush();
    expect(h.autosave.isDirty()).toBe(true);
    await h.autosave.retry();
    expect(h.modelSelections).toEqual([true, true]);
    expect(h.autosave.isDirty()).toBe(false);
  });

  it.each([false, true])('does not acknowledge a later same-model choice from an earlier request (detached=%s)', async (detached) => {
    const h = harness();
    const gate = h.gate();
    h.autosave.schedule('model');
    void h.autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    h.autosave.schedule('model');
    const trailing = detached ? h.autosave.flushDetached() : h.autosave.flush();
    gate.release();
    await trailing;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.modelSelections).toEqual([true, true]);
    expect(h.autosave.isDirty()).toBe(false);
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


describe('settings changes preserve independently joined capabilities', () => {
  // Unit regression: a concurrent read must not replace the location of a
  // pending explicit re-selection, even if the route itself was unchanged.
  it('retains the remote primary mirror while retrying an unchanged selection', () => {
    const local = payload();
    const route = { ...local.capabilities.modelChain[0]!, agentDeviceId: 'share:one' };
    const saved = payload({ capabilities: capabilities({ ...route, modelChain: [route], modelChainOverride: [route] }) });
    const next = reconcileBotSettingsDraft(saved, saved, local, true);
    expect(next.capabilities.agentDeviceId).toBe('share:one');
    expect(botSettingsChanges(saved, saved, false, true).capabilities?.agentDeviceId).toBe('share:one');
    expect(botSettingsChanges(local, local, false, true).capabilities).not.toHaveProperty('agentDeviceId');
  });

  it('preserves an unacknowledged same-model choice while adopting unrelated host edits', () => {
    const saved = payload();
    const incoming = payload({ name: 'Host name', skills: ['host-skill'],
      capabilities: capabilities({ model: 'host-model', modelChain: [{ ...saved.capabilities.modelChain[0]!, model: 'host-model' }] }) });
    const next = reconcileBotSettingsDraft(saved, saved, incoming, true);
    expect(next.name).toBe('Host name');
    expect(next.skills).toEqual(['host-skill']);
    expect(next.capabilities.model).toBe(saved.capabilities.model);
    expect(next.capabilities.modelChain).toEqual(saved.capabilities.modelChain);
    expect(botSettingsChanges(saved, saved, true, true).capabilities).toMatchObject({ model: saved.capabilities.model });
    expect(botSettingsChanges(saved, saved)).toEqual({});
  });

  it('does not resend capability selections when only the name changes', () => {
    expect(botSettingsChanges(payload(), payload({ name: 'Updated' }))).toEqual({ name: 'Updated' });
  });
  it('updates only the selected capability group', () => {
    expect(botSettingsChanges(payload(), payload({ capabilities: capabilities({ mcpServers: ['docs'] }) }))).toEqual({ capabilities: { mcpServers: ['docs'] } });
  });
  it('carries only edited list baselines across consecutive saves', () => {
    const before = payload({ skills: ['old'], capabilities: capabilities({ mcpServers: ['mcp'], toolsets: ['tool'] }) });
    const after = { ...before, skills: ['new'], capabilities: { ...before.capabilities, toolsets: [] } };
    expect(botSettingsChanges(before, after, true)).toEqual({
      skills: ['new'], capabilities: { toolsets: [] },
      capabilityBaseline: { skills: ['old'], toolsets: ['tool'] },
    });
    expect(botSettingsChanges(after, { ...after, skills: [] }, true)).toEqual({
      skills: [], capabilityBaseline: { skills: ['new'] },
    });
    expect(botSettingsChanges(after, { ...after, name: 'Updated' }, true)).toEqual({ name: 'Updated' });
  });
});
