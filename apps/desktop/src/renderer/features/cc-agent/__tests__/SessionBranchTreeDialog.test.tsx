// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionTreeNode, SessionTreeSnapshot } from '@cindy/maker-core';
import type { Session } from '@/lib/ccAgent.types';
import { SessionBranchTreeDialog } from '../SessionBranchTreeDialog';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  getSessionTree: vi.fn(), navigateSessionTree: vi.fn(), reloadMessages: vi.fn(),
  saveDraft: vi.fn(), onOpenChange: vi.fn(), navigate: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/lib/makerTransport', () => ({ makerApiFor: () => mocks }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: mocks }));
vi.mock('@/lib/composerDraftStore', () => ({ saveDraft: mocks.saveDraft, plainTextToTiptapDoc: (text: string) => text }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), warning: vi.fn() } }));

function node(id: string, ...children: SessionTreeNode[]): SessionTreeNode {
  return { id, parentId: null, kind: 'message', role: 'user', preview: id, children };
}
function chain(length: number): SessionTreeNode {
  let next = node(`chain-${length - 1}`);
  for (let i = length - 2; i >= 0; i--) next = node(`chain-${i}`, next);
  return next;
}
const current = { id: 'session', agentKind: 'pi', title: 'Pi task' } as Session;
const snapshot = (roots: SessionTreeNode[]): SessionTreeSnapshot => ({ roots, leafId: 'leaf', activePathIds: ['p', 'leaf'] });
const row = (id: string) => screen.getByText(id).closest('button')!;
async function show(roots: SessionTreeNode[], flags = {}, familyDepth = false) {
  mocks.getSessionTree.mockResolvedValue(snapshot(roots));
  const session = familyDepth ? { ...current, parentSessionId: 'parent' } : current;
  render(<SessionBranchTreeDialog open onOpenChange={mocks.onOpenChange} session={session}
    sessions={familyDepth ? [{ id: 'parent', title: 'Parent' } as Session, session] : [session]}
    running={false} writeBlocked={false} {...flags} />);
  if (roots.length) await screen.findByText(roots[0].preview);
}
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('Pi tree visible indentation', () => {
  it('keeps a long single chain aligned inside a nested Cindy task', async () => {
    await show([chain(40)], {}, true);
    for (let i = 0; i < 40; i++) expect(row(`chain-${i}`).style.paddingLeft).toBe('46px');
  });
  it('groups forks once, including immediate and later nested forks', async () => {
    await show([node('p', node('a', node('a2', node('a3', node('c', node('c2', node('c3'))), node('d')))), node('b', node('e', node('e2')), node('f')))]);
    const depths = { p: 0, a: 1, a2: 2, a3: 2, c: 3, c2: 4, c3: 4, d: 3, b: 1, e: 2, e2: 3, f: 2 };
    for (const [id, depth] of Object.entries(depths)) expect(row(id).style.paddingLeft).toBe(`${28 + depth * 18}px`);
  });
  it('treats multiple roots as a virtual fork without drifting along their chains', async () => {
    await show([node('a', node('a2', node('a3'))), node('b')]);
    expect(['a', 'a2', 'a3', 'b'].map(id => row(id).style.paddingLeft)).toEqual(['46px', '64px', '64px', '46px']);
  });
  it.each([{ running: true }, { writeBlocked: true }])('keeps navigation blocked for %o', async flags => {
    await show([node('p', node('leaf'))], flags);
    fireEvent.click(row('p'));
    expect(row('p').disabled).toBe(true);
    expect(row('leaf').disabled).toBe(true);
    expect(mocks.navigateSessionTree).not.toHaveBeenCalled();
  });
  it('preserves active/current state and refreshes after navigation', async () => {
    const tree = snapshot([node('p', node('leaf')), node('other')]);
    mocks.navigateSessionTree.mockResolvedValue({ tree, draftText: 'resume this' });
    await show(tree.roots);
    expect(row('p').className).toContain('bg-[var(--surface-elevated)]');
    expect(row('leaf').disabled).toBe(true);
    fireEvent.click(row('other'));
    await waitFor(() => expect(mocks.onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.navigateSessionTree).toHaveBeenCalledWith('session', 'other', { summarize: false });
    expect(mocks.reloadMessages).toHaveBeenCalledWith('session');
    expect(mocks.saveDraft).toHaveBeenCalledWith('session', { text: 'resume this', attachments: [], focusAtEnd: true });
  });
});
