// @vitest-environment jsdom
import { act, createElement, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { createComposerDraftSource, useComposerVoiceDraftWriter, type ComposerDraftSource } from '@/session/composerDraftSource';
import { textComposerDocument } from '@/session/composerDocument';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
afterEach(() => { act(() => root?.unmount()); root = undefined; });

it('typing and streamed dictation update subscribers without rendering the task or message list', () => {
  const source = createComposerDraftSource(textComposerDocument(''));
  const container = document.createElement('div');
  const counts = { task: 0, messages: 0, input: 0 };
  function Messages() { counts.messages++; return null; }
  function Input() {
    counts.input++;
    const snapshot = useSyncExternalStore(source.subscribe, source.getSnapshot);
    return createElement('span', null, snapshot.draft);
  }
  function Task() {
    counts.task++;
    return createElement('div', null, createElement(Messages), createElement(Input));
  }
  root = createRoot(container);
  act(() => root!.render(createElement(Task)));
  const before = { ...counts };
  for (let index = 1; index <= 100; index++) {
    act(() => source.setDocument(textComposerDocument('听写内容'.repeat(index))));
  }
  expect(counts.task).toBe(before.task);
  expect(counts.messages).toBe(before.messages);
  expect(counts.input).toBe(before.input + 100);
  expect(container.textContent).toBe('听写内容'.repeat(100));
});

it('task switches detach old drafts and clearing the editor preserves the send snapshot', () => {
  const first = createComposerDraftSource(textComposerDocument('first draft'));
  const second = createComposerDraftSource(textComposerDocument('second draft'));
  const container = document.createElement('div');
  function Input({ source }: { source: ComposerDraftSource }) {
    return createElement('span', null, useSyncExternalStore(source.subscribe, source.getSnapshot).draft);
  }
  root = createRoot(container);
  act(() => root!.render(createElement(Input, { source: first })));
  const atSend = first.getSnapshot();
  act(() => first.setDocument(textComposerDocument('')));
  expect(atSend.draft).toBe('first draft');
  act(() => root!.render(createElement(Input, { source: second })));
  act(() => first.setDocument(textComposerDocument('late old-task update')));
  expect(container.textContent).toBe('second draft');
  expect(first.getSnapshot()).toBe(first.getSnapshot());
});

it('a running voice writer follows replaced drafts but cannot write after leaving its task', () => {
  const first = createComposerDraftSource(textComposerDocument('first'));
  const replacement = createComposerDraftSource(textComposerDocument('file inserted'));
  const other = createComposerDraftSource(textComposerDocument('other task'));
  let writeVoice: (draft: string) => void;
  function Controller({ sessionId, source }: { sessionId: string; source: ComposerDraftSource }) {
    writeVoice = useComposerVoiceDraftWriter(sessionId, (draft) => source.setDocument(textComposerDocument(draft)));
    return null;
  }
  root = createRoot(document.createElement('div'));
  act(() => root!.render(createElement(Controller, { sessionId: 'a', source: first })));
  const ongoingControllerWrite = writeVoice!;
  act(() => root!.render(createElement(Controller, { sessionId: 'a', source: replacement })));
  expect(writeVoice!).toBe(ongoingControllerWrite);
  act(() => ongoingControllerWrite('file inserted plus dictation'));
  expect(replacement.getSnapshot().draft).toBe('file inserted plus dictation');
  expect(first.getSnapshot().draft).toBe('first');
  act(() => root!.render(createElement(Controller, { sessionId: 'b', source: other })));
  act(() => ongoingControllerWrite('late a'));
  expect(other.getSnapshot().draft).toBe('other task');
  act(() => root!.render(createElement(Controller, { sessionId: 'a', source: replacement })));
  act(() => ongoingControllerWrite('late a after returning'));
  expect(replacement.getSnapshot().draft).toBe('file inserted plus dictation');
  const currentWrite = writeVoice!;
  act(() => root!.render(null));
  act(() => currentWrite('after unmount'));
  expect(replacement.getSnapshot().draft).toBe('file inserted plus dictation');
});
