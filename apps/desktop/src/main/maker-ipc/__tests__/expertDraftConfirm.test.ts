import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ExpertDraft } from '@cindy/maker-core/expert-draft';

import { ExpertDraftConfirm, type ExpertDraftEvent } from '../expertDraftConfirm';

const draft: ExpertDraft = {
  slug: 'uk-cold-email',
  name: 'UK Cold Email Writer',
  description: 'Writes cold emails.',
  tags: [],
  memory: false,
  prompt: 'You write cold emails.',
};
const input = (sessionId = 's1') => ({ sessionId, draft, targetDir: '/x/uk-cold-email', markdown: '---\nname: x\n---\np\n' });

afterEach(() => {
  vi.useRealTimers();
});

function setup(timeoutMs = 1000) {
  const confirm = new ExpertDraftConfirm({ timeoutMs, now: () => 100 });
  const events: ExpertDraftEvent[] = [];
  confirm.onChange((e) => events.push(e));
  return { confirm, events };
}

describe('ExpertDraftConfirm (ROADMAP 3.8)', () => {
  it('pushes the request, lists it, and resolves on Approve', async () => {
    const { confirm, events } = setup();
    const wait = confirm.request(input());
    expect(events).toHaveLength(1);
    const request = events[0].type === 'request' ? events[0].request : null;
    expect(request).toMatchObject({ sessionId: 's1', targetDir: '/x/uk-cold-email', createdAt: 100, expiresAt: 1100 });
    expect(confirm.list('s1')).toEqual([request]);
    expect(confirm.list('other')).toEqual([]);

    expect(confirm.decide(request!.requestId, { approved: true })).toBe(true);
    await expect(wait).resolves.toEqual({ approved: true });
    expect(events[1]).toEqual({ type: 'settled', requestId: request!.requestId, sessionId: 's1', outcome: 'approved' });
    expect(confirm.list()).toEqual([]);
    expect(confirm.decide(request!.requestId, { approved: true })).toBe(false);
  });

  it('Reject carries a trimmed note; a malformed answer counts as Reject', async () => {
    const { confirm } = setup();
    const first = confirm.request(input('a'));
    confirm.decide(confirm.list('a')[0].requestId, { approved: false, note: '  shorter please ' });
    await expect(first).resolves.toEqual({ approved: false, reason: 'rejected', note: 'shorter please' });

    const second = confirm.request(input('b'));
    confirm.decide(confirm.list('b')[0].requestId, 'yes');
    await expect(second).resolves.toEqual({ approved: false, reason: 'rejected' });

    const third = confirm.request(input('c'));
    confirm.decide(confirm.list('c')[0].requestId, { approved: 'yes' });
    await expect(third).resolves.toEqual({ approved: false, reason: 'rejected' });
  });

  it('no answer before the timeout is a timeout, never an approval', async () => {
    vi.useFakeTimers();
    const { confirm, events } = setup(5000);
    const wait = confirm.request(input());
    vi.advanceTimersByTime(5000);
    await expect(wait).resolves.toEqual({ approved: false, reason: 'timeout' });
    expect(events.at(-1)).toMatchObject({ type: 'settled', outcome: 'timeout' });
  });

  it('allows one waiting draft per session', async () => {
    const { confirm } = setup();
    void confirm.request(input());
    await expect(confirm.request(input())).rejects.toThrow(/already waiting/);
    expect(confirm.list()).toHaveLength(1);
  });
});
