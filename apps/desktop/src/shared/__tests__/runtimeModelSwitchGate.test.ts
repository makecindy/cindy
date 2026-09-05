import { describe, expect, it } from 'vitest';

import {
  assessRuntimeModelSwitchGate,
  buildDeferredRuntimeSelectionProfile,
  nextDeferredModelWindowRetry,
} from '../runtimeModelSwitchGate';

const million = 1_000_000;
const twoHundredK = 200_000;

const base = {
  inTurn: false,
  isRemote: false,
  agentKind: 'claude-code' as const,
  runtimeRouteChanged: true,
  verifiedTargetWindow: million,
  verifiedCurrentWindow: million,
  contextTokensKnown: true,
  contextTokens: 450_000,
};

describe('assessRuntimeModelSwitchGate', () => {
  it.each([
    {
      name: 'same route idle → hot apply, no rebuild',
      input: { ...base, runtimeRouteChanged: false },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'same route running → hot apply, no rebuild (does not interrupt turn)',
      input: { ...base, runtimeRouteChanged: false, inTurn: true },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'same-or-larger verified window idle → hot apply',
      input: base,
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'same-or-larger verified window running → hot apply',
      input: { ...base, inTurn: true },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'Cindy/unverified target window idle → fail-open hot apply',
      input: { ...base, verifiedTargetWindow: null },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'Cindy/unverified target window running → fail-open hot apply',
      input: { ...base, verifiedTargetWindow: null, inTurn: true },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'unknown current window → fail-open',
      input: { ...base, verifiedCurrentWindow: undefined },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'unknown usage → fail-open',
      input: { ...base, contextTokensKnown: false, contextTokens: 0 },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'zero/invalid target window → fail-open',
      input: { ...base, verifiedTargetWindow: 0 },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'shrink below danger idle → hot apply, no rebuild',
      input: {
        ...base,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 100_000,
      },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'shrink danger idle → live rebuild',
      input: {
        ...base,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 190_000,
      },
      want: { skipRebuild: false, defer: false },
    },
    {
      name: 'shrink overflow idle → live rebuild',
      input: {
        ...base,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 220_000,
      },
      want: { skipRebuild: false, defer: false },
    },
    {
      name: 'shrink danger running → defer, keep selection',
      input: {
        ...base,
        inTurn: true,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 190_000,
      },
      want: { skipRebuild: false, defer: true },
    },
    {
      name: 'remote running any route change → defer',
      input: { ...base, isRemote: true, inTurn: true },
      want: { skipRebuild: true, defer: true },
    },
    {
      name: 'remote running even when windows unknown → defer',
      input: {
        ...base,
        isRemote: true,
        inTurn: true,
        verifiedTargetWindow: null,
        contextTokensKnown: false,
      },
      want: { skipRebuild: true, defer: true },
    },
    {
      name: 'Pi running route change → defer',
      input: { ...base, agentKind: 'pi', inTurn: true },
      want: { skipRebuild: true, defer: true },
    },
    {
      name: 'Pi idle same window → hot apply',
      input: { ...base, agentKind: 'pi' },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'Pi running but route unchanged → hot apply (effort-only)',
      input: {
        ...base,
        agentKind: 'pi',
        inTurn: true,
        runtimeRouteChanged: false,
      },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'Codex running same window → hot apply',
      input: { ...base, agentKind: 'codex', inTurn: true },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'remote idle shrink danger → reject (cannot rebuild remotely)',
      input: {
        ...base,
        isRemote: true,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 190_000,
      },
      want: { skipRebuild: false, defer: false, reject: 'remote-shrink-rebuild' },
    },
    {
      name: 'remote idle unverified target → fail-open',
      input: { ...base, isRemote: true, verifiedTargetWindow: null },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'local BYOM unverified + running → fail-open hot apply',
      input: {
        ...base,
        agentKind: 'claude-code',
        inTurn: true,
        verifiedTargetWindow: null,
        verifiedCurrentWindow: million,
      },
      want: { skipRebuild: true, defer: false },
    },
    {
      name: 'shrink overflow running → defer, keep selection',
      input: {
        ...base,
        inTurn: true,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 220_000,
      },
      want: { skipRebuild: false, defer: true },
    },
    {
      name: 'Codex shrink danger running → defer',
      input: {
        ...base,
        agentKind: 'codex',
        inTurn: true,
        verifiedTargetWindow: twoHundredK,
        contextTokens: 190_000,
      },
      want: { skipRebuild: false, defer: true },
    },
    {
      name: 'remote running same-route effort-only → still defer',
      input: { ...base, isRemote: true, inTurn: true, runtimeRouteChanged: false },
      want: { skipRebuild: true, defer: true },
    },
    {
      name: 'Pi unverified target running → defer (cannot live-verify)',
      input: {
        ...base,
        agentKind: 'pi',
        inTurn: true,
        verifiedTargetWindow: null,
      },
      want: { skipRebuild: true, defer: true },
    },
  ])('$name', ({ input, want }) => {
    expect(assessRuntimeModelSwitchGate(input)).toEqual(want);
  });
});

describe('buildDeferredRuntimeSelectionProfile', () => {
  it('keeps the clicked high + Fast on the pending profile',
    () => {
      expect(
        buildDeferredRuntimeSelectionProfile({
          agentKind: 'claude-code',
          model: 'claude-fable-5',
          providerId: 'cindy',
          atomicSelection: { effort: 'high', fastMode: true },
          currentFastMode: false,
        }),
      ).toEqual({
        agentKind: 'claude-code',
        model: 'claude-fable-5',
        providerId: 'cindy',
        effort: 'high',
        fastMode: true,
      });
    },
  );

  it('no-rank model pending effort is null, not leftover high',
    () => {
      expect(
        buildDeferredRuntimeSelectionProfile({
          agentKind: 'claude-code',
          model: 'local-llama',
          providerId: 'custom:ollama',
          atomicSelection: { effort: null, fastMode: false },
          currentFastMode: true,
        }).effort,
      ).toBeNull();
    },
  );

  it('without atomic selection, Fast falls back to the live session, effort stays null',
    () => {
      expect(
        buildDeferredRuntimeSelectionProfile({
          agentKind: 'codex',
          model: 'gpt-5.5',
          providerId: 'openai',
          currentFastMode: true,
        }),
      ).toMatchObject({ effort: null, fastMode: true });
    },
  );
});

describe('nextDeferredModelWindowRetry', () => {
  it('idle settle with no extra confirmation is done',
    () => {
      expect(nextDeferredModelWindowRetry(false, undefined)).toEqual({ action: 'done' });
    },
  );

  it('retries with the verified window instead of dropping the selection',
    () => {
      expect(nextDeferredModelWindowRetry(true, 200_000)).toEqual({
        action: 'retry',
        confirmedContextWindow: 200_000,
      });
    },
  );

  it('cancels only when confirmation is required but no window was verified',
    () => {
      expect(nextDeferredModelWindowRetry(true, undefined)).toEqual({ action: 'cancel' });
      expect(nextDeferredModelWindowRetry(true, 0)).toEqual({ action: 'cancel' });
    },
  );
});
