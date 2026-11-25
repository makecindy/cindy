// @vitest-environment jsdom
// Renderer unit: an authoritative withdrawal may race a later keystroke or lose its receipt.
// A second editable copy must never appear on mere intent, rejection or ambiguity.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import type { ChatMessage, QueuedMessage } from '@/lib/makerChatStore';
import { clearDraft, getDraft, plainTextToTiptapDoc, saveDraft, registerDraftFlush } from '@/lib/composerDraftStore';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { dagRecallRecoveryKey, prepareDagRecall, recallDagQueuedQuestion, takeDagRecalledDraft } from '../DagRecallDraft';
const f = vi.hoisted(() => ({ snapshot: vi.fn(), local: vi.fn(), device: vi.fn(), cancel: vi.fn() }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { getSnapshot: f.snapshot, isLocalSentUserMessage: f.local } }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: f.device }));
const session = { id: 'branch', userId: 'owner', source: 'desktop' as const, remoteHostId: null, deviceLinkDeviceId: undefined };
const message: ChatMessage = { clientId: 'q1', role: 'user', content: 'original', pastedTextRanges: [{ start: 0, end: 8, display: 'paste' }],
  images: [{ url: 'xdt-image://branch/example.png', mimeType: 'image/png', originalName: 'example.png' }] };
const queued = { clientId: 'q1', text: 'original', chatMessage: message, files: [{id:'img', name:'example.png', path:'xdt-image://branch/example.png', category:'image', ext:'.png', size:1, mimeType:'image/png'}] } as QueuedMessage;
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('electronAPI', { maker: { dagRecallQueued: f.cancel } });
  setDataOwnerGeneration('owner');
  f.device.mockReturnValue(undefined); f.local.mockReturnValue(true);
  f.snapshot.mockReturnValue({ pendingQueue:[queued], steeringQueueClientIds:[], queueEditLocks:[], agentStatus:{isRunning:false} });
});
afterEach(() => { clearDraft('branch'); clearDraft(dagRecallRecoveryKey('branch')); vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe('DAG recall', () => {
  it('does not touch input before the host commits; restores structured text and attachments only once', () => {
    const t = prepareDagRecall(session, message); if (!t.ok) throw Error(t.reason);
    t.assertReady(); expect(getDraft('branch')).toBeUndefined();
    expect(t.restore()).toEqual({ ok:true, attachments:1 });
    expect(getDraft('branch')?.text?.content?.[0]?.content?.[0].type).toBe('pastedTextChip');
    expect(getDraft('branch')?.attachments[0]).toMatchObject({url:'xdt-image://branch/example.png',cacheUrlShared:true,stagedPathShared:true});
    expect(t.restore().ok).toBe(false);
  });
  it('flushes debounced draft input before admitting deletion and refuses an external user row', () => {
    const off = registerDraftFlush('branch', () => saveDraft('branch', { text:plainTextToTiptapDoc('new'), attachments:[] }));
    try { expect(prepareDagRecall(session, message).ok).toBe(false); } finally { off(); }
    clearDraft('branch'); f.local.mockReturnValue(false); expect(prepareDagRecall(session, message).ok).toBe(false);
  });
  it('does not let history withdrawal cancel a running turn after preview', () => {
    const t = prepareDagRecall(session,message); if (!t.ok) throw Error(t.reason);
    f.snapshot.mockReturnValue({agentStatus:{isRunning:true}});
    expect(() => t.assertReady()).toThrow('仍在运行'); expect(getDraft('branch')).toBeUndefined();
  });
  it('stores a late recall separately while newer composer content is present, then allows user to recover it', () => {
    const t = prepareDagRecall(session, message); if (!t.ok) throw Error(t.reason);
    saveDraft('branch', { text:plainTextToTiptapDoc('new'), attachments:[] });
    expect(t.restore().ok).toBe(false); expect(getDraft('branch')?.text).toEqual(plainTextToTiptapDoc('new'));
    expect(takeDagRecalledDraft('branch').ok).toBe(false); clearDraft('branch');
    expect(takeDagRecalledDraft('branch')).toEqual({ok:true,attachments:1});
  });
  it('does not dispatch after the owner changes and rejects a changed or consumed queue row', async () => {
    const first = recallDagQueuedQuestion(session, queued, () => true); setDataOwnerGeneration('other');
    expect((await first).ok).toBe(false); expect(f.cancel).not.toHaveBeenCalled();
    f.snapshot.mockReturnValue({pendingQueue:[], steeringQueueClientIds:[], queueEditLocks:[]});
    expect((await recallDagQueuedQuestion(session,queued,()=>true)).ok).toBe(false); expect(f.cancel).not.toHaveBeenCalled();
  });
  it.each([true,false,'wrong','lost'] as const)('only restores the native cancellation for that specific session and question: %s', async result => {
    if (result === 'lost') f.cancel.mockRejectedValueOnce(Error('disconnected'));
    else f.cancel.mockResolvedValueOnce({ok:result !== false, sessionId:'branch', clientId:result === 'wrong' ? 'other' : 'q1', reason:'consumed'});
    expect((await recallDagQueuedQuestion(session,queued,()=>true)).ok).toBe(result === true);
    expect(f.cancel).toHaveBeenCalledTimes(1); expect(f.cancel.mock.calls[0][2]).toMatch(/^[a-f0-9]{64}$/);
    if (result === true) expect(getDraft('branch')?.attachments[0]).toMatchObject({id:'img',stagedPathShared:true});
    else expect(getDraft('branch')).toBeUndefined();
  });
});
