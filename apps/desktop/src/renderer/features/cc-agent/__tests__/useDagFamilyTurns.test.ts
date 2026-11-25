// @vitest-environment jsdom
/** Unit: the native fork transaction copies rows with fresh client IDs. A nested
 * retry at a copied user row must resolve to the original predecessor, without
 * removing a later independent question with the very same content. Existing
 * canvas tests start from projected cards and cannot exercise this boundary. */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import type { Message, Session } from '@/lib/ccAgent.types';
import { CONTINUE_AFTER_ERROR_PROMPT } from '@cindy/maker-shared/synthetic-trigger';
import { makerChatStore, type ChatMessage } from '@/lib/makerChatStore';
import { createDagPaneReader, dagAnswerPosition, isDagAnswerAtTip, dagFamily, projectDagTurns, readDagHistory, savedDagRetryLinks, useDagFamilyTurns } from '../useDagFamilyTurns';

// No real device discovery, SQLite access, owner state or chat subscriptions.
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: () => undefined }));
import { listMessagesFor } from '@/lib/makerTransport';
vi.mock('@/lib/makerTransport', () => ({ listMessagesFor: vi.fn() }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { getSnapshot: vi.fn(), subscribe: vi.fn(() => () => {}) } }));
vi.mock('@cindy/maker-shared/interaction', () => ({ isAnsweredAsyncQuestionClientId: () => false }));

const branch = (id: string, parentSessionId?: string, forkedAtMessageId?: string, extra?: Partial<Session>) =>
  ({ id, parentSessionId, forkedAtMessageId, userId: 'owner', createdAt: new Date(100).toISOString(), clearedAt: null, ...extra } as Session);
const row = (id: string, role: 'user' | 'assistant' | 'agent_switch', at: number, text = id, reply?: string) => ({ id, role, at, text, reply });
const nodeId = (s: string, u: string) => JSON.stringify([s, u]);
const historyMessage = (sessionId: string) => (id: string, role: Message['role'], content: unknown, agentMeta: Message['agentMeta'] = null): Message =>
  ({ sessionId, id, clientId:id, role, content, agentMeta, toolUseId:null, createdAt:new Date(1).toISOString() });

describe('native session family turns', () => {
  it('selects the whole family from a descendant without crossing origins or traversing cycles', () => {
    const sessions = [branch('a'), branch('b','a'), branch('sibling','a'), branch('private','a',undefined,{userId:'other'}),
      branch('remote','a',undefined,{deviceLinkDeviceId:'device'}), branch('unrelated'), branch('x','y'), branch('y','x')];
    expect(dagFamily('b',sessions).map(s => s.id)).toEqual(['a','b','sibling']);
    expect(dagFamily('x',sessions)).toEqual([]);
  });

  it('does not traverse the origin link of a side chat promoted to an independent task', () => {
    const sessions = [branch('origin'), branch('promoted', 'origin', 'old-answer', { source: 'desktop', sideChatPromoted: true }),
      branch('fork', 'promoted')];
    expect(dagFamily('origin', sessions).map(s => s.id)).toEqual(['origin']);
    expect(dagFamily('fork', sessions).map(s => s.id)).toEqual(['promoted', 'fork']);
  });

  it('retains all answer segments, deduplicates native copies and resolves copied anchors across generations', () => {
    const root = [row('u1','user',1,'same'),row('a1','assistant',2,'part 1'),row('a2','assistant',3,'part 2'),row('u2','user',4,'same')];
    const copy = root.slice(0,3).map(r => ({ ...r,id:`copied-${r.id}` }));
    const nodes = projectDagTurns([branch('r'),branch('c','r','a1'),branch('g','c','copied-u1')],new Map([
      ['r',root],['c',[...copy,row('new-u','user',101,'same'),row('new-a','assistant',102)]],['g',[row('again','user',110,'same')]],
    ]));
    expect(nodes.map(n => [n.id,n.parentId])).toEqual([
      [nodeId('r','u1'),null],[nodeId('r','u2'),nodeId('r','u1')],[nodeId('c','new-u'),nodeId('r','u1')],[nodeId('g','again'),null],
    ]);
    expect(nodes[0]).toMatchObject({ answer:'part 1\n\npart 2',userMessageId:'u1',answerMessageId:'a2' });
    expect(nodes[1].answerMessageId).toBeUndefined();
  });

  it('excludes the retry question itself and stops an assistant fork prefix at an engine switch', () => {
    const a = [row('u','user',1),row('a','assistant',2),row('switch','agent_switch',3),row('u2','user',5)];
    const nodes = projectDagTurns([branch('r'),branch('retry','r','u2'),branch('side','r','a')],new Map([
      ['r',a],['retry',[...a.slice(0,3).map(r => ({...r,id:`dup${r.id}`})),row('edited','user',101)]],
      ['side',[...a.slice(0,2).map(r => ({...r,id:`dup${r.id}`})),row('new','user',101)]],
    ]));
    expect(nodes.map(n => [n.sessionId,n.userMessageId,n.parentId])).toEqual([
      ['r','u',null],['r','u2',nodeId('r','u')],['retry','edited',nodeId('r','u')],['side','new',nodeId('r','u')],
    ]);
  });

  it('does not consume a later answer as a copy just because the text matches; explicit replies can interleave', () => {
    const parent = [row('u','user',1),row('a','assistant',2,'same'),row('a2','assistant',103,'same')];
    const child = [row('copied-u','user',1,'u'),row('copied-a','assistant',2,'same'),row('new','user',101),
      row('later','user',102),row('reply','assistant',103,'same','new')];
    const nodes = projectDagTurns([branch('r'),branch('c','r','a')],new Map([['r',parent],['c',child]]));
    expect(nodes.filter(n => n.sessionId === 'c').map(n => [n.userMessageId,n.answerMessageId])).toEqual([['new','reply'],['later',undefined]]);
  });

  it('traverses short newest-first pages to EOF and fences cancellation before the next read', async () => {
    const raw = (id: string, role: 'assistant'|'user') => ({ id,sessionId:'r',clientId:id,role,createdAt:new Date(1).toISOString(),content:id } as Message);
    const list = vi.fn().mockResolvedValueOnce([raw('a','assistant')]).mockResolvedValueOnce([raw('q','user')]).mockResolvedValueOnce([]);
    expect((await readDagHistory(branch('r'),() => true,list)).map(r => r.id)).toEqual(['q','a']);
    expect(list.mock.calls.map(([,opt]) => opt.before)).toEqual([undefined,'a','q']);
    let current = true;
    const stale = vi.fn(async () => { current = false; return [raw('stale','user')]; });
    expect(await readDagHistory(branch('r'),() => current,stale)).toEqual([]);
    expect(stale).toHaveBeenCalledTimes(1);
  });

  it('does not treat an empty or filtered history as evidence of a matching native tail', async () => {
    const b = branch('r');
    const answer = { sessionId:'r', role:'assistant', clientId:'a' } as Message;
    const list = vi.mocked(listMessagesFor);
    list.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...answer, role:'tool_result' }]).mockResolvedValueOnce([answer]);
    expect(await isDagAnswerAtTip(b,'a')).toBe(false);
    expect(await isDagAnswerAtTip(b,'a')).toBe(false);
    expect(await isDagAnswerAtTip(b,'a')).toBe(true);
  });

  it('distinguishes a completed turn with trailing tool rows from a confirmed historical answer and an absent anchor', async () => {
    const m = historyMessage('r'), list = vi.mocked(listMessagesFor), b = branch('r');
    const a = m('a','assistant','answer'), u = m('u','user','same');
    list.mockResolvedValueOnce([m('tool','tool_result','done'), a, u]);
    expect(await dagAnswerPosition(b,'a','u')).toBe('tip');
    list.mockResolvedValueOnce([m('u2','user','same')]).mockResolvedValueOnce([a,u]);
    expect(await dagAnswerPosition(b,'a','u')).toBe('historical');
    list.mockResolvedValueOnce([m('b','assistant','late',{replyToClientId:'u'}),m('u2','user','same'),u]);
    expect(await dagAnswerPosition(b,'b','u')).toBe('unknown');
    list.mockResolvedValueOnce([m('e','error','failure'), a,u]);
    expect(await dagAnswerPosition(b,'a','u')).toBe('unknown');
    list.mockResolvedValueOnce([a,u]).mockResolvedValueOnce([]);
    expect(await dagAnswerPosition(b,'gone','u')).toBe('unknown');
  });

  it('indexes only visible tool names, associates terminal failure and streaming with their actual turns', async () => {
    const raw = (id: string, role: Message['role'], content: unknown, agentMeta?: Message['agentMeta']) =>
      ({ id, sessionId:'r', clientId:id, role, content, agentMeta, createdAt:new Date(10).toISOString() } as Message);
    const rows = [raw('u','user','first'), raw('tool','tool_use',{ toolName:'Read',input:{path:'private input'} }),
      raw('sub','tool_use',{toolName:'Hidden'}, {parentUuid:'sub'} as Message['agentMeta']),
      raw('result','tool_result','private result'), raw('fail','error',{ message:'private error' })];
    const b = branch('r');
    const history = await readDagHistory(b, () => true, vi.fn().mockResolvedValueOnce(rows.reverse()).mockResolvedValueOnce([]));
    const nodes = projectDagTurns([b],new Map([['r',[...history,row('u2','user',20),{...row('a2','assistant',21),streaming:true}]]]));
    expect(nodes.map(n => [n.runState,n.toolText])).toEqual([['failed','Read'],['running',undefined]]);
    expect(JSON.stringify(history)).not.toMatch(/private|Hidden/);
  });

  // Unit regression: native history and its live projection, not canvas fixtures. A
  // hidden retry used to orphan its answer; an unmarked identical question is real.
  it('routes checkpoint replies to the failed question and keeps generic triggers isolated', async () => {
    const raw = historyMessage('r');
    const b = branch('r');
    const rows = [raw('u','user','继续'),raw('a','assistant','前半'),raw('e','error',{message:'private error'}),
      raw('q2','user','继续'),raw('resume','user',{text:CONTINUE_AFTER_ERROR_PROMPT},{recoveryCheckpoint:{version:1, source:'manual', mode:'fast', attempt:1,
        failedUserClientId:'u', rootUserClientId:'u', contextTokens:1, contextWindow:100, contextRatio:0.01,
        progressCount:1, createdAt:new Date(1).toISOString(), recentProgress:[]}}),
      raw('answer','assistant','后半',{replyToClientId:'resume'}),raw('generic','user','[UI_ACTION_TRIGGER] other'),raw('other','assistant','private tool response')];
    const history = await readDagHistory(b, () => true, vi.fn().mockResolvedValueOnce(rows.reverse()).mockResolvedValueOnce([]));
    const nodes = projectDagTurns([b],new Map([['r',history]]));
    expect(nodes.map(n => [n.userMessageId,n.answer,n.runState])).toEqual([['u','前半\n\n后半',undefined],['q2','',undefined]]);
  });

  it('keeps the observed zero-output replacement on the same card across native soft deletion', () => {
    const b = branch('r');
    const read = createDagPaneReader('r',new Map());
    const snap = (state: Record<string, unknown>) => vi.mocked(makerChatStore.getSnapshot).mockReturnValue({
      messages:[], pendingQueue:[], ...state,
    } as unknown as ReturnType<typeof makerChatStore.getSnapshot>);
    const show = (history: ReturnType<typeof row>[]) => projectDagTurns([b],new Map([['r',history]]),new Map([['r',read()]]));
    const q = row('u','user',1,'同一问题');
    const clone = row('clone','user',3,'同一问题');
    const genuine = row('later','user',5,'同一问题');
    snap({error:'failed',inputRecovery:{kind:'active-turn',item:{clientId:'u'}}});
    expect(show([q,genuine]).map(n => n.runState)).toEqual(['failed',undefined]);
    snap({pendingQueue:[{clientId:'clone',supersedesUserClientId:'u',retrySourceClientId:'u'}]});
    read(); // Main emits the queue identity before persisting/soft-deleting rows.
    snap({});
    for (const history of [[q,clone], [clone]]) {
      expect(show([...history,row('answer','assistant',4),genuine]).map(n => [n.id,n.userMessageId,n.answer])).toEqual([
        [nodeId('r','u'),'clone','answer'],[nodeId('r','later'),'later',''],
      ]);
    }
  });

  it('reopens a collapsed sibling using only visible native history, without inferring a deleted clone source', async () => {
    const root = branch('r'), child = branch('c','r');
    const raw = historyMessage('c');
    const show = async (...rows: Message[]) => projectDagTurns([root,child], new Map([['c',await readDagHistory(child,() => true,
      vi.fn().mockResolvedValueOnce(rows.reverse()).mockResolvedValueOnce([]))]]));
    const q = raw('u','user','继续'), part = raw('p','assistant','part'), answer = raw('a','assistant','end');
    // The native terminal writer snapshots the last vendor metadata, including a nested tool parent.
    for (const content of ['legacy failure', {message:'overloaded',reason:'turn-failed'}, {message:'silent',reason:'silent-stop-exhausted'}]) {
      const error = raw('err','error',content,{parentUuid:'old-tool'});
      expect((await show(q,part,error)).map(n => [n.id,n.runState])).toEqual([[nodeId('c','u'),'failed']]);
      for (const resume of [raw('next','user',CONTINUE_AFTER_ERROR_PROMPT), raw('auto','user','继续',{autoResume:true})]) {
        expect((await show(q,part,error,resume,answer)).map(n => [n.id,n.answer,n.runState])).toEqual([[nodeId('c','u'),'part\n\nend',undefined]]);
      }
    }
    expect((await show(raw('clone','user','继续'),answer)).map(n => [n.id,n.answer])).toEqual([[nodeId('c','clone'),'end']]);
  });

  it('restores saved replacement IDs only for the same scope and branch, independently of soft-deletion timing', () => {
    const scope = JSON.stringify(['owner','local','r']);
    const saved = {scope,rows:[['c','replacement','original','original']] as const};
    const q = row('original','user',1,'same'), replacement = row('replacement','user',2,'same'), later = row('new','user',4,'same');
    for (const prefix of [[],[q]]) {
      const histories = new Map([['r',[replacement]],['c',[...prefix,replacement,row('a','assistant',3,'ok'),later]]]);
      const family = [branch('r'),branch('c','r')];
      const show = (key: string) => projectDagTurns(family,histories,undefined,savedDagRetryLinks(saved,key)).map(n => [n.id,n.userMessageId,n.answer]);
      expect(show(scope)).toEqual([[nodeId('r','replacement'),'replacement',''],[nodeId('c','original'),'replacement','ok'],[nodeId('c','new'),'new','']]);
      expect(show(JSON.stringify(['owner','other-device','r']))).toContainEqual([nodeId('c','replacement'),'replacement','ok']);
    }
  });

  it('attributes normalized live automatic and manual continuation replies without exposing the trigger', () => {
    const b = branch('r');
    for (const hidden of [{systemCardType:'auto-resume'},{isContinuationTrigger:true}]) {
      const messages = [{clientId:'resume',role:'user',content:'',isSyntheticTrigger:true,...hidden},
        {clientId:'delta',role:'assistant',content:'恢复中',replyToClientId:'resume',isStreaming:true}] as ChatMessage[];
      const nodes = projectDagTurns([b],new Map([['r',[row('u','user',1)]]]),new Map([['r',{messages}]]));
      expect(nodes.map(n => [n.id,n.answer,n.runState])).toEqual([[nodeId('r','u'),'恢复中','running']]);
    }
  });

  it('preserves a mounted editor across refresh and additive forks, but fences a clear even with an added branch', async () => {
    const root = branch('r');
    const raw = historyMessage('r');
    const messages: ChatMessage[] = [];
    vi.mocked(makerChatStore.getSnapshot).mockReturnValue({messages, pendingQueue:[]} as unknown as ReturnType<typeof makerChatStore.getSnapshot>);
    vi.mocked(listMessagesFor).mockResolvedValueOnce([raw('q','user','original')]).mockResolvedValueOnce([])
      .mockImplementation(() => new Promise(() => {}));
    function Editors({sessions, revision}: {sessions:Session[];revision:number}) {
      const graph = useDagFamilyTurns(true,'r',sessions,messages,revision);
      return createElement('div', {'aria-busy':graph.loading}, graph.nodes.map(n => createElement('input',{key:n.id,defaultValue:n.question})));
    }
    const view = render(createElement(Editors, {sessions:[root],revision:0}));
    try {
      const editor = await view.findByDisplayValue('original');
      fireEvent.change(editor, {target:{value:'编辑中的草稿'}});
      for (const sessions of [[root], [root,branch('c','r')]]) {
        view.rerender(createElement(Editors,{sessions,revision:1}));
        expect(view.getByDisplayValue('编辑中的草稿')).toBe(editor);
        expect(editor.parentElement?.getAttribute('aria-busy')).toBe('true');
      }
      view.rerender(createElement(Editors,{sessions:[{...root,clearedAt:new Date().toISOString()},branch('c','r')],revision:1}));
      expect(view.queryByRole('textbox')).toBeNull();
    } finally { view.unmount(); vi.mocked(listMessagesFor).mockReset(); }
  });

  it('projects an answer from the tracked child after closing its native pane, without another history read', async () => {
    const family = [branch('r'), branch('c', 'r', 'root-answer')];
    const listeners = new Map<string, () => void>();
    const root = historyMessage('r'), child = historyMessage('c');
    const list = vi.mocked(listMessagesFor).mockReset();
    list.mockResolvedValueOnce([root('root-answer','assistant','A'), root('root-input','user','Q')]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([child('child-input','user','旁问'),child('copy-a','assistant','A'),child('copy-q','user','Q')]).mockResolvedValueOnce([]);
    const empty: ChatMessage[] = []; let live = empty;
    vi.mocked(makerChatStore.getSnapshot).mockImplementation(id => ({messages:id === 'c' ? live : empty, pendingQueue:[]} as unknown as ReturnType<typeof makerChatStore.getSnapshot>));
    vi.mocked(makerChatStore.subscribe).mockImplementation((id, notify) => { listeners.set(id, notify); return () => { listeners.delete(id); }; });
    const hook = renderHook(({active}: { active?: string }) => useDagFamilyTurns(true,'r',family,empty,0,active,undefined,undefined,['c']),{initialProps:{active:'c' as string | undefined}});
    try {
      await waitFor(() => expect(hook.result.current.loading).toBe(false));
      hook.rerender({active:undefined});
      live = [{clientId:'own-answer',role:'assistant',content:'旁问真实回答',replyToClientId:'child-input',createdAt:new Date(20).toISOString()} as ChatMessage];
      act(() => listeners.get('c')!());
      expect(hook.result.current.nodes.find(n => n.sessionId === 'c' && n.userMessageId === 'child-input')).toMatchObject({
        parentId:nodeId('r','root-input'),answer:'旁问真实回答',answerMessageId:'own-answer',
      });
      expect(list).toHaveBeenCalledTimes(4);
    } finally { hook.unmount(); list.mockReset(); vi.mocked(makerChatStore.subscribe).mockReset(); }
    expect(listeners.size).toBe(0);
  });

  it('rejects non-advancing cursors and history from a different session', async () => {
    const message = { id:'m', sessionId:'r', role:'user', clientId:'c',content:'q' } as Message;
    await expect(readDagHistory(branch('r'),() => true,async () => [message])).rejects.toThrow();
    await expect(readDagHistory(branch('s'),() => true,async () => [message])).rejects.toThrow();
  });
});
