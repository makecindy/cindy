// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useMemo } from 'react';
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { transpileModule, ScriptTarget } from 'typescript';
import type { Session } from '@/lib/ccAgent.types';
import type { BotGroupNode } from '../features/cc-agent/lib/projectGrouping';
import {
  advanceViewedPriorityHold,
  getMainListEntrySessions,
  type MainListEntry,
  type MainListPriorityContext,
} from '../features/cc-agent/lib/mainListModel';
import { getSessionListCollapseView } from '../features/cc-agent/lib/sessionListCollapse';

// Execute the production memo and its dependency list, then the real collapse model.
// This catches both missing Bot scans and stale memo results when only Bots change.
const source = readFileSync(resolve(__dirname, '../features/cc-agent/sidebar/sections/ProjectsSection.tsx'), 'utf8');
const declaration = source.match(/const priorityContext = useMemo\([\s\S]+?\n  \]\);/);
if (!declaration) throw new Error('ProjectsSection priority memo not found');
const compiled = transpileModule(declaration[0], { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
const runMemo = new Function('useMemo', 'input', `
  const { runningSessionIds, notifications, urgentSet, attentionKinds, projects, dialogues,
    unclassified, bots, remoteActivityRevision, viewedIdForSort, viewedPriorityHold,
    getRemoteSessionActivity, advanceViewedPriorityHold } = input;
  ${compiled}
  return priorityContext;
`) as (memo: typeof useMemo, input: ReturnType<typeof inputs>) => MainListPriorityContext;

afterEach(cleanup);

function bot(id: string): BotGroupNode {
  return {
    botId: id, displayName: id, avatar: '', avatarColor: '', latestActivityAt: '2020-01-01',
    sessions: [{ id, title: id, createdAt: '2020-01-01', updatedAt: '2020-01-01', status: 'active' } as Session],
  };
}

function inputs(bots: BotGroupNode[], activity: Map<string, { phase: string }>) {
  return {
    runningSessionIds: new Set<string>(), notifications: new Set<string>(), urgentSet: new Set<string>(),
    attentionKinds: new Map(), projects: [], dialogues: [], unclassified: [], bots,
    remoteActivityRevision: 1, viewedIdForSort: undefined,
    viewedPriorityHold: { heldPriorityRanks: new Map(), recentlyViewedAtMs: new Map() },
    getRemoteSessionActivity: (id: string) => activity.get(id), advanceViewedPriorityHold,
  };
}

function visibleBots(bots: BotGroupNode[], context: MainListPriorityContext) {
  const exempt = new Set([...context.attentionSessionIds, ...context.runningSessionIds]);
  const entries: MainListEntry[] = bots.map((item) => ({ kind: 'bot-group', bot: item }));
  return getSessionListCollapseView({
    entries, minVisibleCount: 1, showAll: false, disableCollapse: false, isFiltering: false,
    isActiveEntry: () => false,
    hasAttentionEntry: (entry) => getMainListEntrySessions(entry).some((s) => exempt.has(s.id)),
  }).visibleEntries;
}

describe('remote Bot lamp fold exemptions', () => {
  it.each(['running', 'needs-interaction', 'error', 'completed'])(
    'keeps a Bot beyond the section limit visible for remote %s activity', (phase) => {
      const bots = [bot('first'), bot('idle'), bot('lit')];
      const input = inputs(bots, new Map([['lit', { phase }]]));
      const { result } = renderHook(() => runMemo(useMemo, input));
      expect(visibleBots(bots, result.current).map((entry) => getMainListEntrySessions(entry)[0].id))
        .toEqual(['first', 'lit']);
    },
  );

  it('recomputes when Bot rows change without another remote activity revision', () => {
    const lit = bot('lit');
    const input = inputs([], new Map([['lit', { phase: 'running' }]]));
    const { result, rerender } = renderHook((props) => runMemo(useMemo, props), { initialProps: input });
    expect(result.current.runningSessionIds.has('lit')).toBe(false);
    rerender({ ...input, bots: [lit] });
    expect(result.current.runningSessionIds.has('lit')).toBe(true);
  });
});
