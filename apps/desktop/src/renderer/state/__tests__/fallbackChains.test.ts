// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { fallbackEntryUid } from '@cindy/maker-shared/fallback-chain';

import {
  appendFallbackEntry,
  fallbackChainKey,
  fallbackCountFor,
  getFallbackChain,
  findChainContaining,
  removeFallbackEntry,
  setFallbackChainEnabled,
  __resetForTest,
  __STORAGE_KEY,
} from '../fallbackChains';

const main = { uid: '', providerId: 'openai', modelId: 'gpt-5', agent: 'codex' };
const backup = {
  uid: 'anthropic::claude::claude-code',
  providerId: 'anthropic',
  modelId: 'claude',
  agent: 'claude-code',
};
const key = fallbackChainKey(main);
const mainEntry = { ...main, uid: key };

beforeEach(() => {
  __resetForTest();
  window.localStorage.clear();
  window.localStorage.removeItem(__STORAGE_KEY);
});

describe('fallbackChains store', () => {
  it('keys a chain by the main model identity including engine', () => {
    expect(fallbackChainKey({ providerId: 'openai', modelId: 'gpt-5', agent: 'codex' })).not.toBe(
      fallbackChainKey({ providerId: 'openai', modelId: 'gpt-5', agent: 'pi' }),
    );
  });

  it('persists an appended fallback and counts it', () => {
    appendFallbackEntry(key, mainEntry, backup);
    const chain = getFallbackChain(key);
    expect(chain?.entries).toHaveLength(2);
    expect(chain?.entries[1]?.modelId).toBe('claude');
    // The count excludes the main model.
    expect(fallbackCountFor(key)).toBe(1);
  });

  it('never removes the main model', () => {
    appendFallbackEntry(key, mainEntry, backup);
    removeFallbackEntry(key, mainEntry.uid);
    expect(getFallbackChain(key)?.entries[0]?.modelId).toBe('gpt-5');
  });

  it('drops the whole chain once the last fallback is removed', () => {
    appendFallbackEntry(key, mainEntry, backup);
    removeFallbackEntry(key, backup.uid);
    // A chain with only a main model carries no behaviour; no empty shell is kept.
    expect(getFallbackChain(key)).toBeNull();
  });

  it('reports zero fallbacks while disabled without discarding them', () => {
    appendFallbackEntry(key, mainEntry, backup);
    setFallbackChainEnabled(key, false);
    expect(fallbackCountFor(key)).toBe(0);
    expect(getFallbackChain(key)?.entries).toHaveLength(2);
  });

  it('normalizes legacy cc entries and never persists cc in fallback v2', () => {
    const main = {
      providerId: 'openai-5d3ca924',
      modelId: 'gpt-6-astra',
      agent: 'cc',
      effort: 'medium',
    };
    const mainEntry = { ...main, uid: 'openai-5d3ca924::gpt-6-astra::cc::medium' };
    const canonicalKey = fallbackEntryUid({ ...main, agent: 'claude-code' });
    const legacyEntry = {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      agent: 'cc',
      effort: 'medium',
      uid: 'anthropic::claude-sonnet-5::cc::medium',
      fast: false,
    };
    const legacyKey = mainEntry.uid;
    expect(legacyKey).not.toBe(canonicalKey);

    window.localStorage.setItem(
      __STORAGE_KEY,
      JSON.stringify({
        [legacyKey]: { enabled: true, entries: [mainEntry, legacyEntry] },
      }),
    );

    const loaded = getFallbackChain(canonicalKey);
    expect(loaded?.entries).toHaveLength(2);
    expect(getFallbackChain(legacyKey)).toBeNull();
    expect(loaded?.entries[0]).toMatchObject({
      providerId: 'openai-5d3ca924',
      modelId: 'gpt-6-astra',
      agent: 'claude-code',
      effort: 'medium',
      uid: canonicalKey,
    });
    expect(loaded?.entries[1]).toMatchObject({
      providerId: 'anthropic',
      modelId: 'claude-sonnet-5',
      agent: 'claude-code',
      effort: 'medium',
      uid: 'anthropic::claude-sonnet-5::claude-code::medium',
    });

    appendFallbackEntry(canonicalKey, mainEntry, {
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      agent: 'cc',
      effort: 'medium',
      uid: 'anthropic::claude-opus-5::cc::medium',
      fast: false,
    });

    const persisted = JSON.parse(window.localStorage.getItem(__STORAGE_KEY) ?? '{}');
    expect(persisted[legacyKey]).toBeUndefined();
    const persistedEntries = persisted[canonicalKey].entries;
    expect(persistedEntries).toHaveLength(3);
    expect(persistedEntries.every((entry: { agent: string }) => entry.agent !== 'cc')).toBe(true);
    expect(
      persistedEntries.every(
        (entry: { providerId: string; modelId: string; agent: string; effort?: string; uid: string }) =>
          entry.uid === fallbackEntryUid(entry),
      ),
    ).toBe(true);
  });
});

/**
 * After a failover the session runs entry #2, so a lookup keyed by the running
 * model finds nothing and the composer would show no chain at all - exactly when
 * the user most wants to see where in the chain they are.
 */
describe('findChainContaining', () => {
  it('finds the chain by any member, not just its key', () => {
    const backup = {
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
      agent: 'claude-code',
      effort: 'medium',
      uid: 'anthropic::claude-opus-5::claude-code::medium',
      fast: false,
    };
    appendFallbackEntry(key, mainEntry, backup);

    expect(findChainContaining(key), 'the keyed lookup must still work').not.toBeNull();

    const viaBackup = findChainContaining(backup.uid);
    expect(viaBackup, 'a fallback entry must find its own chain').not.toBeNull();
    expect(viaBackup?.entries[0]?.uid).toBe(mainEntry.uid);
  });

  it('returns null for a model that is on no chain', () => {
    expect(findChainContaining('nobody::nothing::codex::')).toBeNull();
  });
});
