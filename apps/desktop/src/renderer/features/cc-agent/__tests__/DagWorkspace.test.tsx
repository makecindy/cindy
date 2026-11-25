// @vitest-environment jsdom
// Renderer unit: preparing a historical child must identify the actual native branch to the
// canvas; a failed fork must not consume the question. Checking only saveDraft missed that receipt.
import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { DagChildSendBridge } from '../DagChildSend';
import type { AgentInputProjection } from '../../../../shared/agentInputQueue';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { DagNode, SessionDagCanvasProps } from '../session-dag/types';
import { webcrypto } from 'node:crypto';
const f = vi.hoisted(() => ({ fork: vi.fn(), refresh: vi.fn(), receipt: vi.fn(), position: vi.fn(), tip: vi.fn(), flush: vi.fn(), send: vi.fn(),
  device: vi.fn<() => string | undefined>(), snapshot: vi.fn(), subscribe: vi.fn(), failure: vi.fn(),
}));
import { saveDraft, getDraft, clearDraft } from '@/lib/composerDraftStore';
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: f.device }));
vi.mock('@/features/device-link/refreshRemoteSessions', () => ({ refreshRemoteDeviceSessions: vi.fn() }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: {
  getSnapshot: f.snapshot, subscribe: f.subscribe,
  getLightSnapshot: () => ({ agentStatus: {} }), subscribeLight: () => () => {},
} }));
vi.mock('@/lib/sessionService', () => ({ forkAtMessage: f.fork }));
vi.mock('@/lib/composerDraftStore', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/composerDraftStore')>()), flushDraft: f.flush }));
vi.mock('@/components/chat/useForkAtMessage', () => ({
  textToTiptapDoc: (text: string) => ({ text }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
const node = {
  id: 'turn-2',
  parentId: null,
  sessionId: 'branch',
  question: 'Q2',
  answer: 'A2',
  userMessageId: 'user2',
  answerMessageId: 'answer2',
};
let graphNodes: DagNode[] = [node];
let childAnchor: string;
vi.mock('../useDagFamilyTurns', () => ({
  isDagAnswerAtTip: f.tip, dagAnswerPosition:f.position,
  useDagFamilyTurns: () => ({ rootId: 'root', nodes: graphNodes, family: [{ id: 'root' }, { id: 'branch', parentSessionId: 'root', deviceLinkDeviceId: f.device() }, { id:'third', parentSessionId:'root' }, { id:'fourth', parentSessionId:'root' }, { id: 'native-aside', source: 'side-chat', parentSessionId: 'root' }], loading: false, error: null }),
}));
vi.mock('../session-dag/SessionDagCanvas', () => ({
  SessionDagCanvas: (p: SessionDagCanvasProps) => (
    <div>
      <output aria-label="画布节点">{p.nodes.map(n => n.id).join(',')}</output>
      <output aria-label="完整历史">{p.historyReady ? p.fullFamilyNodes?.map(n => n.id).join(',') : 'loading'}</output>
      <button onClick={() => p.onRetryFailed?.(graphNodes[0])}>恢复失败卡</button>
      {p.onOpenChat && <button aria-label="打开对话" onClick={p.onOpenChat}>打开对话</button>}
      <button onClick={() => p.onOpen(node)}>卡片</button>
      <button onClick={() => p.onPin?.(node)}>固定卡片</button>
      {p.nodes.map((n, i) => <button key={n.id} onClick={async () => { try { f.receipt(await p.onAction(n,'advance',{question:`问题${i}`,context:'',branchQuestionId:`draft-${i}`})); } catch(e) { f.failure(e); } }}>发送分支{i}</button>)}
      {(['retry', 'unchanged-retry', 'no-id-aside', 'advance', 'force-advance', 'aside'] as const).map((action) => (
        <button
          key={action}
          onClick={async () => {
            try {
              const kind = action === 'force-advance' ? 'advance' : action === 'unchanged-retry' ? 'retry' : action === 'no-id-aside' ? 'aside' : action;
              f.receipt(await p.onAction(node, kind, {
                question: action === 'unchanged-retry' ? node.question : '新问题', context: '引用 A 的快照',
                ...(action !== 'advance' && action !== 'no-id-aside' && {branchQuestionId: `request-${action}`}),
              }));
            } catch (e) { f.failure(e); }
          }}
        >
          {action}
        </button>
      ))}
    </div>
  ),
}));
import { DagWorkspace } from '../DagWorkspace';
function mount(readOnly = false) {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('electronAPI', {
    safeStorageRead: vi.fn().mockResolvedValue(null),
    safeStorageStore: vi.fn().mockResolvedValue(true),
  });
  childAnchor = '';
  f.fork.mockImplementation(async (parentSessionId: string, anchor: string) => {
    childAnchor = anchor;
    return { id: 'child', parentSessionId, forkedAtMessageId: anchor };
  });
  f.send.mockImplementation(async (_id, _text, opts) => { opts.onInputCreated('child-input'); return opts.beforeEnqueue(); });
  f.snapshot.mockReturnValue({ messages: [], agentStatus: {}, pendingQueue: [] });
  f.subscribe.mockReturnValue(() => {});
  f.position.mockResolvedValue('historical');
  const device = f.device();
  return render(
    <DagWorkspace
      session={{ id: 'root', userId: 'owner' } as Session}
      sessions={['root', 'branch','third','fourth', 'native-aside'].map(id => ({ id, userId: 'owner', title: id, status: 'active', deviceLinkDeviceId: device } as Session))}
      messages={[]}
      readOnly={readOnly}
      refresh={f.refresh}
      renderChat={(p, _, submission, retry) => (
        <div aria-label="原生目标">
          {retry && <button onClick={() => retry.cancel()}>{`取消原生重试 ${p.id}:${retry.userMessageId}`}</button>}
          {retry && <button onClick={() => retry.start({ id: p.id,
            target: () => ({ key: 'error-1', kind: 'active-turn', clientId: 'user2', source: 'user2', priorQueue: [] }),
            withPreparedRetry: dispatch => dispatch(),
            retry: async observe => observe({ sessionId: p.id, error: null, recovery: null,
              pendingQueue: [{ clientId: 'clone2', retrySourceClientId: 'user2', supersedesUserClientId: 'user2' }] } as AgentInputProjection),
          })}>模拟原生受理回执</button>}
          {submission && <DagChildSendBridge request={submission} session={{ id: p.id, userId: 'owner', parentSessionId: p.id === 'branch' || p.id === 'root' || p.id === 'native-aside' || ['third','fourth'].includes(p.id) ? null : 'branch',
            forkedAtMessageId: p.id === 'child' ? childAnchor : null, deviceLinkDeviceId: device } as Session} writable={!readOnly}
            send={(text, opts) => f.send(p.id, text, opts)} />}
          {p.id}:{p.jump?.messageClientId}
        </div>
      )}
    />,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const id of ['child', 'root', 'branch']) clearDraft(id);
  vi.clearAllMocks();
  f.tip.mockReset();
  f.device.mockReset();
  graphNodes = [node];
});
describe('DAG right-hand native chat', () => {
  it('opens an empty session in its own composer without manufacturing a turn or a fork', async () => {
    graphNodes = [];
    mount();
    fireEvent.click(await screen.findByLabelText('打开对话'));
    expect(screen.getByLabelText('画布节点').textContent).toBe('');
    expect(screen.getByLabelText('原生目标').textContent).toBe('root:');
    expect(f.fork).not.toHaveBeenCalled();
  });
  it('keeps side branches in the complete family and reachable via tabs, not in the main canvas', async () => {
    graphNodes = [node, { ...node, id: 'side-node', sessionId: 'native-aside', parentId: node.id }];
    mount();
    expect((await screen.findByLabelText('画布节点')).textContent).toBe(node.id);
    expect(screen.getByLabelText('完整历史').textContent).toBe(`${node.id},side-node`);
    fireEvent.click(screen.getByLabelText('打开对话'));
    fireEvent.click(screen.getByText('native-aside'));
    expect(screen.getByLabelText('原生目标').textContent).toBe('native-aside:');
  });
  it('rejects even a direct action callback when the hosting session is read-only', async () => {
    mount(true);
    fireEvent.click(await screen.findByText('retry'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(false));
    expect(f.fork).not.toHaveBeenCalled();
    expect(getDraft('child')).toBeUndefined();
  });
  it('routes a failed tip to its own native retry, preserving the composer even on refusal', async () => {
    graphNodes = [{ ...node, runState: 'failed' }];
    mount();
    saveDraft('branch', { text: { text: '未发送的旁注' }, attachments: [] });
    fireEvent.click(await screen.findByText('恢复失败卡'));
    fireEvent.click(await screen.findByText('取消原生重试 branch:user2'));
    expect((await screen.findByRole('alert')).textContent).toContain('未创建新卡');
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(getDraft('branch')?.text?.text).toBe('未发送的旁注');
  });
  it('saves the confirmed replacement IDs with the current graph, not a second card or composer draft', async () => {
    graphNodes = [{ ...node, runState: 'failed' }];
    mount();
    fireEvent.click(await screen.findByText('恢复失败卡'));
    fireEvent.click(await screen.findByText('模拟原生受理回执'));
    await waitFor(() => expect(window.electronAPI.safeStorageStore).toHaveBeenCalledOnce());
    const [, saved] = vi.mocked(window.electronAPI.safeStorageStore).mock.calls[0];
    expect(JSON.parse(saved).retryLinks).toEqual([['branch', 'clone2', 'user2', 'user2']]);
    expect(getDraft('branch')).toBeUndefined();
    expect(f.fork).not.toHaveBeenCalled();
  });
  it('never retries a later failure on behalf of an older failed card, even for identical questions', async () => {
    graphNodes = [{ ...node, runState: 'failed' }, { ...node, id: 'tip', userMessageId: 'later', runState: 'failed' }];
    mount();
    fireEvent.click(await screen.findByText('恢复失败卡'));
    expect(screen.getByRole('alert').textContent).toContain('当前失败的一轮');
    expect(screen.queryByLabelText('原生目标')).toBeNull();
    expect(f.fork).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('opens the selected branch and anchor without dispatch; collapsing preserves the graph', async () => {
    mount();
    fireEvent.click(await screen.findByText('卡片'));
    expect(screen.getByLabelText('原生目标').textContent).toBe('branch:user2');
    expect(f.fork).not.toHaveBeenCalled();
    expect(getDraft('child')).toBeUndefined();
    fireEvent.click(screen.getByLabelText('收起聊天'));
    expect(screen.queryByLabelText('原生目标')).toBeNull();
    expect(screen.getByText('卡片')).toBeTruthy();
  });
  it('can switch back and forth between the pinned path and live chat in a narrow window', async () => {
    mount();
    fireEvent.click(await screen.findByText('卡片'));
    fireEvent.click(screen.getByText('固定卡片'));
    const fixed = screen.getByLabelText('固定分支对照');
    const chat = screen.getByLabelText('节点原生对话');
    expect(fixed.classList.contains('hidden')).toBe(false);
    expect(chat.classList.contains('hidden')).toBe(true);
    fireEvent.click(screen.getByLabelText('查看节点对话'));
    expect(fixed.classList.contains('hidden')).toBe(true);
    expect(chat.classList.contains('hidden')).toBe(false);
    fireEvent.click(screen.getByLabelText('查看固定分支'));
    expect(chat.classList.contains('hidden')).toBe(true);
  });
  it('refuses a native fork error without changing the source draft or choosing a different target', async () => {
    mount();
    saveDraft('branch', { text: { text: '原草稿' }, attachments: [] });
    f.fork.mockRejectedValueOnce(Object.assign(new Error('历史消息不可用'), {code:'NOT_FOUND'}));
    fireEvent.click(await screen.findByText('retry'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(false));
    expect(screen.getByRole('alert').textContent).toContain('历史消息不可用');
    expect(getDraft('branch')?.text?.text).toBe('原草稿');
    expect(screen.queryByLabelText('原生目标')).toBeNull(); expect(f.send).not.toHaveBeenCalled();
  });
  it('does not create a branch or write a draft if an advance caller omits explicit submission identity', async () => {
    mount(); fireEvent.click(await screen.findByText('advance'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(false));
    expect(f.fork).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
    expect(getDraft('branch')).toBeUndefined(); expect(getDraft('child')).toBeUndefined();
  });
  it('continues an idle native tip even with a visible child in a different branch, never changing its draft', async () => {
    graphNodes = [node,{...node, id:'child-card', sessionId:'root', parentId:node.id}];
    mount(); f.position.mockResolvedValue('tip');
    saveDraft('branch', {text:{text:'不能覆盖'},attachments:[]});
    fireEvent.click(await screen.findByText('force-advance'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(false));
    expect(getDraft('branch')?.text?.text).toBe('不能覆盖'); expect(f.send).not.toHaveBeenCalled();
    clearDraft('branch');
    f.send.mockImplementationOnce(async (_id,_text,opts) => { opts.onInputCreated('accepted-1'); return opts.beforeEnqueue(); });
    fireEvent.click(screen.getByText('force-advance'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith({ sessionId:'branch',delivery:'accepted',userMessageId:'accepted-1',reused:true }));
    expect(f.fork).not.toHaveBeenCalled(); expect(f.position).toHaveBeenCalledWith(expect.objectContaining({id:'branch'}),'answer2','user2');
    expect(f.send).toHaveBeenCalledWith('branch','新问题\n\n【引用资料】\n引用 A 的快照',expect.objectContaining({expectedDagTip:{answerId:'answer2',userMessageId:'user2'}}));
  });
  it.each(['busy','queued','unknown','remote'])('never forks or sends when an existing tip is %s', async reason => {
    if (reason === 'remote') f.device.mockReturnValue('peer');
    mount(); f.position.mockResolvedValue(reason === 'unknown' ? 'unknown' : 'tip');
    f.snapshot.mockReturnValue({messages:[],agentStatus:{isRunning:reason==='busy'},pendingQueue:reason==='queued'?[{clientId:'other'}]:[]});
    fireEvent.click(await screen.findByText('force-advance'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(false)); expect(f.fork).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it('keeps concurrent native handoffs bound to each branch across focus changes, without registering a duplicate pane', async () => {
    graphNodes = [node,...['root','third','fourth'].map(id=>({...node,sessionId:id,id}))];
    mount(); f.position.mockResolvedValue('tip');
    const finish = new Map<string,()=>void>();
    f.send.mockImplementation((id:string,_text:string,opts) => new Promise<boolean>(resolve=>{
      opts.onInputCreated(`input-${id}`); finish.set(id,() => { void opts.beforeEnqueue().then(resolve); });
    }));
    const buttons = await screen.findAllByText(/发送分支/);
    for (const button of buttons) fireEvent.click(button);
    await waitFor(()=>expect(f.send).toHaveBeenCalledTimes(4));
    expect(screen.getAllByLabelText('原生目标')).toHaveLength(4);
    expect(screen.queryByLabelText('收起聊天')).toBeNull();
    fireEvent.click(screen.getByText('卡片'));
    expect(screen.getAllByLabelText('原生目标')).toHaveLength(4);
    fireEvent.click(screen.getByLabelText('收起聊天'));
    expect(new Set(f.send.mock.calls.map(([id])=>id))).toEqual(new Set(['root','branch','third','fourth']));
    for(const id of ['third','root','fourth','branch']) {
      await act(async()=>finish.get(id)!()); expect(f.receipt).toHaveBeenCalledWith({sessionId:id,delivery:'accepted',userMessageId:`input-${id}`,reused:true});
    }
    expect(f.fork).not.toHaveBeenCalled(); expect(screen.queryByLabelText('原生目标')).toBeNull();
  });
  it('refuses a changed tip at final admission without forking; a later explicit attempt uses its new position', async () => {
    mount(); f.position.mockResolvedValueOnce('tip').mockResolvedValue('historical');
    f.send.mockImplementationOnce(async (_id,_text,opts) => { opts.onInputCreated('first'); return opts.beforeEnqueue(); });
    const button = await screen.findByText('force-advance'); fireEvent.click(button);
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(false)); expect(f.fork).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith({sessionId:'child',delivery:'accepted',userMessageId:'child-input'}));
    expect(f.fork).toHaveBeenCalledExactlyOnceWith('branch','answer2');
  });
  it.each(['force-advance', 'aside', 'retry'])('never replays %s after an acceptance without an input ID',async action=>{
    mount(); f.position.mockResolvedValue('tip'); f.send.mockResolvedValueOnce(true);
    const button=await screen.findByText(action); fireEvent.click(button);
    await waitFor(()=>expect(f.failure).toHaveBeenCalledOnce()); fireEvent.click(button);
    await waitFor(()=>expect(f.failure).toHaveBeenCalledTimes(2)); expect(f.send).toHaveBeenCalledOnce();
    expect(f.fork).toHaveBeenCalledTimes(action === 'force-advance' ? 0 : 1);
  });
  it('waits for native acceptance, rejects a double click, and retries only the existing child', async () => {
    mount();
    let rejectSend!: (accepted: boolean) => void;
    f.send.mockImplementationOnce(() => new Promise<boolean>(resolve => { rejectSend = resolve; }));
    const button = await screen.findByText('force-advance');
    fireEvent.click(button);
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(f.receipt).not.toHaveBeenCalled();
    fireEvent.click(button);
    await act(async () => rejectSend(false));
    expect(screen.getByRole('alert').textContent).toContain('分支已创建，问题未发送');
    saveDraft('child', { text: { text: '保留这段话' }, attachments: [] });
    fireEvent.click(button);
    expect((await screen.findByRole('alert')).textContent).toContain('原草稿');
    expect(getDraft('child')?.text?.text).toBe('保留这段话');
    clearDraft('child');
    fireEvent.click(button);
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith({ sessionId: 'child', delivery: 'accepted', userMessageId: 'child-input' }));
    expect(f.fork).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls.map(([id]) => id)).toEqual(['child', 'child']);
  });
  it('never dispatches again when the clicked operation lost its native receipt', async () => {
    mount();
    f.send.mockRejectedValueOnce(new Error('IPC disconnected'));
    const button = await screen.findByText('force-advance');
    fireEvent.click(button);
    await waitFor(() => expect(f.failure).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('alert').textContent).toContain('未确认');
    fireEvent.click(button);
    await waitFor(() => expect(f.failure).toHaveBeenCalledTimes(2));
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.fork).toHaveBeenCalledTimes(1);
  });
  it('retains an ambiguous historical fork without creating a duplicate on a later click', async () => {
    mount(); f.fork.mockRejectedValueOnce(new Error('lost IPC reply'));
    const button = await screen.findByText('force-advance'); fireEvent.click(button);
    await waitFor(() => expect(f.failure).toHaveBeenCalledOnce()); fireEvent.click(button);
    await waitFor(() => expect(f.failure).toHaveBeenCalledTimes(2));
    expect(f.fork).toHaveBeenCalledOnce(); expect(f.send).not.toHaveBeenCalled();
  });
  it('does not send after an owner change during the native fork', async () => {
    mount();
    f.fork.mockImplementationOnce(async () => {
      setDataOwnerGeneration('other');
      return { id: 'child', parentSessionId: 'branch', forkedAtMessageId: 'answer2' };
    });
    fireEvent.click(await screen.findByText('force-advance'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(false));
    expect(f.send).not.toHaveBeenCalled();
    setDataOwnerGeneration(null);
  });
  it('does not treat device outbox admission or another message as the child receipt', async () => {
    f.device.mockReturnValue('remote');
    mount();
    f.send.mockImplementationOnce(async (_id, _text, options) => { options.onInputCreated('mine'); return true; });
    fireEvent.click(await screen.findByText('force-advance'));
    await waitFor(() => expect(f.send).toHaveBeenCalledTimes(1));
    expect(f.subscribe.mock.calls[0][0]).toBe('child');
    const notify = f.subscribe.mock.calls[0][1];
    f.snapshot.mockReturnValue({ pendingQueue: [{ clientId: 'other' }, { clientId: 'mine', isPendingEnqueue: true }], messages: [] });
    await act(async () => notify());
    expect(f.receipt).not.toHaveBeenCalled();
    f.snapshot.mockReturnValue({ pendingQueue: [{ clientId: 'mine' }], messages: [] });
    await act(async () => notify());
    expect(f.receipt).toHaveBeenCalledWith({ sessionId: 'child', delivery: 'accepted', userMessageId:'mine' });
  });
  it('keeps a main draft across an aside tab and only mounts two distinct native targets after pinning', async () => {
    mount();
    saveDraft('root', { text: { text: '主线草稿' }, attachments: [] });
    fireEvent.click(await screen.findByText('aside'));
    await waitFor(() => expect(f.receipt).toHaveBeenCalledWith({sessionId:'child', delivery:'accepted', userMessageId:'child-input'}));
    expect(screen.queryByLabelText('原生目标')).toBeNull();
    expect(screen.queryByLabelText('固定分支对照')).toBeNull();
    fireEvent.click(screen.getByLabelText('打开对话'));
    expect(screen.getByLabelText('原生目标').textContent).toBe('root:');
    expect(getDraft('root')?.text?.text).toBe('主线草稿');
    fireEvent.click(screen.getByText('旁问'));
    fireEvent.click(screen.getByLabelText('固定此对话'));
    expect(screen.getAllByLabelText('原生目标').map(el => el.textContent).sort()).toEqual(['child:', 'root:']);
    fireEvent.click(screen.getByLabelText('取消固定'));
    expect(screen.getAllByLabelText('原生目标')).toHaveLength(1);
  });
  it('does not fork or send from an aside without an explicit request or an unedited failed retry', async () => {
    graphNodes = [{ ...node, runState:'failed' }]; mount();
    fireEvent.click(await screen.findByText('no-id-aside'));
    fireEvent.click(screen.getByText('unchanged-retry'));
    await waitFor(() => expect(f.receipt.mock.calls).toEqual([[false], [false]]));
    expect(f.fork).not.toHaveBeenCalled(); expect(f.send).not.toHaveBeenCalled();
  });
  it.each([['retry', 'user2'], ['aside', 'answer2'], ['force-advance', 'answer2']])(
    '%s forks at the original native boundary and accepts only the child input, without changing the selected pane or its draft',
    async (action, anchor) => {
      if (action === 'retry') graphNodes = [{ ...node, runState:'failed' }];
      mount(); f.position.mockResolvedValue(action === 'force-advance' ? 'historical' : 'tip');
      fireEvent.click(await screen.findByText('卡片'));
      saveDraft('branch', {text:{text:'原分支草稿'},attachments:[]});
      const button = screen.getByText(action); fireEvent.click(button);
      const receipt = {sessionId:'child', delivery:'accepted', userMessageId:'child-input'};
      await waitFor(() => expect(f.receipt).toHaveBeenCalledWith(receipt));
      fireEvent.click(button); await waitFor(() => expect(f.receipt.mock.calls).toEqual([[receipt], [receipt]]));
      expect(f.fork).toHaveBeenCalledExactlyOnceWith('branch', anchor);
      expect(f.send).toHaveBeenCalledExactlyOnceWith('child','新问题\n\n【引用资料】\n引用 A 的快照',expect.objectContaining({literalText:true,independent:true}));
      expect(getDraft('child')).toBeUndefined(); expect(getDraft('branch')?.text?.text).toBe('原分支草稿');
      expect(screen.getByLabelText('原生目标').textContent).toBe('branch:user2');
      if (action === 'aside') {
        const saved = vi.mocked(window.electronAPI.safeStorageStore).mock.calls.at(-1)?.[1];
        expect(JSON.parse(saved!).asideSessions).toEqual(['child']);
      }
    },
  );
});
