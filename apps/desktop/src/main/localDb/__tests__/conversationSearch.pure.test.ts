import { describe, expect, it, vi } from 'vitest';

import {
  collectContentHitsUntilUniqueSessions,
  fuzzyTitleMatch,
  mergeConversationSearchResults,
  normalizeConversationContentPreview,
  textPreview,
  visibleMessageTextForConversationSearch,
} from '../conversationSearch.pure';
import type { ConversationSearchSessionSummary } from '../../../shared/conversationSearch';

function session(
  id: string,
  title: string,
  updatedAt: string,
): ConversationSearchSessionSummary {
  return {
    id,
    title,
    workingDir: null,
    workspaceKind: 'project',
    agentKind: 'cc',
    status: 'active',
    source: 'desktop',
    orcaRole: null,
    parentSessionId: null,
    userSendAt: null,
    updatedAt,
    createdAt: updatedAt,
    _count: { messages: 1 },
  };
}

describe('conversationSearch.pure', () => {
  it('scores and highlights fuzzy title matches', () => {
    const match = fuzzyTitleMatch('Chat History', 'ch');
    expect(match).not.toBeNull();
    expect(match?.indices).toEqual([0, 1]);
  });

  it('keeps title matches above content-only matches', () => {
    const titleSession = session('s1', 'Billing Search', '2026-01-01T00:00:00.000Z');
    const contentSession = session('s2', 'Unrelated', '2026-06-01T00:00:00.000Z');
    const results = mergeConversationSearchResults({
      titleMatches: [{ session: titleSession, score: 10, indices: [0] }],
      contentHits: [{
        session: contentSession,
        hit: {
          messageId: 'm2',
          messageClientId: 'c2',
          role: 'assistant',
          createdAt: contentSession.updatedAt,
          snippet: null,
          preview: 'billing search details',
          score: 99,
          ftsRank: null,
          vectorRank: 1,
        },
      }],
      limit: 10,
    });
    expect(results.map((r) => r.session.id)).toEqual(['s1', 's2']);
  });

  it('can sort merged results by newest activity', () => {
    const olderTitleSession = session('s1', 'Billing Search', '2026-01-01T00:00:00.000Z');
    const newerContentSession = session('s2', 'Unrelated', '2026-06-01T00:00:00.000Z');
    const results = mergeConversationSearchResults({
      titleMatches: [{ session: olderTitleSession, score: 10, indices: [0] }],
      contentHits: [{
        session: newerContentSession,
        hit: {
          messageId: 'm2',
          messageClientId: 'c2',
          role: 'assistant',
          createdAt: newerContentSession.updatedAt,
          snippet: null,
          preview: 'billing search details',
          score: 99,
          ftsRank: null,
          vectorRank: 1,
        },
      }],
      limit: 10,
      sortBy: 'activityDesc',
    });
    expect(results.map((r) => r.session.id)).toEqual(['s2', 's1']);
  });

  it('uses relevance as a tie-breaker for activity sorting', () => {
    const titleSession = session('s1', 'Billing Search', '2026-06-01T00:00:00.000Z');
    const contentSession = session('s2', 'Unrelated', '2026-06-01T00:00:00.000Z');
    const results = mergeConversationSearchResults({
      titleMatches: [{ session: titleSession, score: 10, indices: [0] }],
      contentHits: [{
        session: contentSession,
        hit: {
          messageId: 'm2',
          messageClientId: 'c2',
          role: 'assistant',
          createdAt: contentSession.updatedAt,
          snippet: null,
          preview: 'billing search details',
          score: 99,
          ftsRank: null,
          vectorRank: 1,
        },
      }],
      limit: 10,
      sortBy: 'activityAsc',
    });
    expect(results.map((r) => r.session.id)).toEqual(['s1', 's2']);
  });

  it('merges title and content hits for the same session', () => {
    const target = session('s1', 'Search Settings', '2026-01-01T00:00:00.000Z');
    const results = mergeConversationSearchResults({
      titleMatches: [{ session: target, score: 10, indices: [0] }],
      contentHits: [{
        session: target,
        hit: {
          messageId: 'm1',
          messageClientId: 'c1',
          role: 'user',
          createdAt: target.updatedAt,
          snippet: 'search settings',
          preview: 'search settings preview',
          score: 1,
          ftsRank: 1,
          vectorRank: null,
        },
      }],
      limit: 10,
    });
    expect(results).toHaveLength(1);
    expect(results[0].matchKind).toBe('both');
    expect(results[0].contentHit?.messageClientId).toBe('c1');
    expect(results[0].contentHits.map((hit) => hit.messageClientId)).toEqual(['c1']);
  });

  it('keeps multiple content hit positions for the same session', () => {
    const target = session('s1', 'Search Settings', '2026-01-01T00:00:00.000Z');
    const results = mergeConversationSearchResults({
      titleMatches: [],
      contentHits: [
        {
          session: target,
          hit: {
            messageId: 'm1',
            messageClientId: 'c1',
            role: 'user',
            createdAt: '2026-01-01T00:00:00.000Z',
            snippet: 'older search settings',
            preview: 'older search settings preview',
            score: 1,
            ftsRank: 2,
            vectorRank: null,
          },
        },
        {
          session: target,
          hit: {
            messageId: 'm2',
            messageClientId: 'c2',
            role: 'assistant',
            createdAt: '2026-01-02T00:00:00.000Z',
            snippet: 'newer search settings',
            preview: 'newer search settings preview',
            score: 9,
            ftsRank: 1,
            vectorRank: null,
          },
        },
      ],
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0].matchKind).toBe('content');
    expect(results[0].titleScore).toBeNull();
    expect(results[0].contentHit?.messageClientId).toBe('c2');
    expect(results[0].contentHits.map((hit) => hit.messageClientId)).toEqual(['c2', 'c1']);
  });

  it('keeps paging content hits until enough unique sessions are collected', async () => {
    const fetchPage = vi.fn(async ({ offset }: { limit: number; offset: number }) => {
      if (offset === 0) {
        return {
          hits: [
            { sessionId: 's1', messageId: 'm1' },
            { sessionId: 's1', messageId: 'm2' },
          ],
          vectorUsed: true,
          vectorSkipReason: null,
          poolCapped: false,
          nextOffset: 2,
        };
      }
      return {
        hits: [
          { sessionId: 's2', messageId: 'm3' },
        ],
        vectorUsed: false,
        vectorSkipReason: 'fts only',
        poolCapped: true,
        nextOffset: null,
      };
    });

    const result = await collectContentHitsUntilUniqueSessions({
      maxPages: 3,
      pageLimit: 2,
      targetUniqueSessions: 2,
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls.map(([arg]) => arg.offset)).toEqual([0, 2]);
    expect(result.hits.map((hit) => hit.messageId)).toEqual(['m1', 'm2', 'm3']);
    expect(result.vectorUsed).toBe(true);
    expect(result.vectorSkipReason).toBe('fts only');
    expect(result.poolCapped).toBe(true);
  });

  it('extracts readable previews from structured message content', () => {
    expect(textPreview({ text: 'hello', files: [{ path: '/tmp/a.ts' }] })).toContain('hello');
  });

  it('builds user previews from visible text instead of attachment JSON fields', () => {
    const content = {
      text: 'please inspect the billing flow',
      images: [{ url: 'xdt-image://s/a.png', mimeType: 'image/png', originalName: 'diagram.png' }],
      files: [{ name: 'secret-plan.md', path: '/tmp/secret-plan.md' }],
    };

    expect(visibleMessageTextForConversationSearch('user', content)).toBe('please inspect the billing flow');
    expect(normalizeConversationContentPreview('user', content, 'billing')).toMatchObject({
      preview: 'please inspect the billing flow',
      snippet: 'please inspect the billing flow',
      keywordMatchedVisibleText: true,
    });
    expect(normalizeConversationContentPreview('user', content, 'images')).toMatchObject({
      preview: 'please inspect the billing flow',
      snippet: null,
      keywordMatchedVisibleText: false,
    });
    expect(normalizeConversationContentPreview('user', content, 'secret')).toMatchObject({
      preview: 'please inspect the billing flow',
      snippet: null,
      keywordMatchedVisibleText: false,
    });
  });

  it('hides synthetic UI trigger rows from search previews and keyword matching', async () => {
    const { UI_ACTION_TRIGGER_PREFIX } = await import('../../../shared/interruptedTurn.js');
    // 隐藏续跑指令(合成 user 行)对用户不可见,搜索 preview/snippet 也不能露出,
    // 否则用户搜 continue/task 等常见词会看到隐藏英文指令。
    const synthetic = `${UI_ACTION_TRIGGER_PREFIX}Please continue the interrupted task.`;
    expect(visibleMessageTextForConversationSearch('user', synthetic)).toBe('');
    expect(normalizeConversationContentPreview('user', synthetic, 'continue')).toMatchObject({
      preview: '',
      snippet: null,
      keywordMatchedVisibleText: false,
    });
  });

  it('extracts visible AskUser and plan review text for conversation search', () => {
    expect(visibleMessageTextForConversationSearch('ask_user', {
      questions: [{ question: 'Which branch should I use?' }],
      answers: { q0: 'Use main' },
    })).toBe('Which branch should I use? Use main');
    expect(visibleMessageTextForConversationSearch('plan_review', {
      plan: 'Update the search index',
      feedback: 'Keep the UI stable',
    })).toBe('Update the search index Keep the UI stable');
  });
});
