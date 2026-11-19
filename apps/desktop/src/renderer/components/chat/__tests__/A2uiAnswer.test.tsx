// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { A2uiAnswer } from '../A2uiAnswer';
import { A2UI_BASIC_CATALOG, readA2uiMessages, splitA2uiMessage } from '../a2uiMessage';
import { SessionQuickSendProvider } from '../SessionQuickSendContext';

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'a2ui-test-owner' } }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

// Tier 1. The real official processor/renderer and Cindy's send adapter are mounted.
// The sender is a test double, not evidence of a real model invocation.
// Contract: desktop-a2ui-messages.md, explicit submit, replay and readable fallback.
// RichAnswer tests cover cindy-ui, not the official processor's graph/action semantics.
// Minimal inputs: one bound field/button; invalid schema or a missing/cyclic child.
const message = (components: unknown[], dataModel: unknown = {}) => JSON.stringify({ version: '1.0', createSurface: {
  surfaceId: 'reading', catalogId: A2UI_BASIC_CATALOG, components, dataModel,
} });
const form = message([
  { id: 'root', component: 'Column', children: ['answer', 'submit'] },
  { id: 'answer', component: 'TextField', label: '中文主旨', variant: 'longText', value: { '@path': '/draft/answer' } },
  { id: 'submit', component: 'Button', child: 'label', action: { event: { name: 'cindy.sendMessage', userMessage: '请反馈我的主旨', context: { answer: { '@path': '/draft/answer' } } } } },
  { id: 'label', component: 'Text', text: '提交主旨' },
], { draft: { answer: '' } });
const ports = { renderMarkdown: (text: string) => <span>{text}</span>, renderMedia: vi.fn(() => <span>host media</span>) };
const draw = (source: string, stateKey: string, send?: (text: string) => Promise<boolean>) => render(
  <SessionQuickSendProvider value={send ? { send } : null}><A2uiAnswer {...ports} source={source} stateKey={stateKey} /></SessionQuickSendProvider>,
);

function deepQuery(root: ParentNode, selector: string): Element | null {
  const found = root.querySelector(selector);
  if (found) return found;
  for (const element of root.querySelectorAll('*')) {
    if (element.shadowRoot) {
      const nested = deepQuery(element.shadowRoot, selector);
      if (nested) return nested;
    }
  }
  return null;
}

it('binds edited text, previews the exact submission, retries failure and retains the draft after reopening', async () => {
  const send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  const view = draw(form, 'roundtrip', send);
  await waitFor(() => expect(deepQuery(view.container, 'textarea')).toBeTruthy());
  const input = deepQuery(view.container, 'textarea') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '这是测试输入，不是学习记录。' } });
  const expected = '请反馈我的主旨\n\n' + JSON.stringify({ answer: input.value }, null, 2);
  await waitFor(() => expect(screen.getByText((_text, element) => element?.tagName === 'P' && element.textContent === expected)).toBeTruthy());
  expect(send).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '提交主旨' }));
  await screen.findByRole('alert');
  expect(send).toHaveBeenCalledWith(expected, { literalText: true, independent: true });
  expect(input.value).toBe('这是测试输入，不是学习记录。');
  fireEvent.click(screen.getByRole('button', { name: '提交主旨' }));
  await screen.findByRole('button', { name: 'richAnswer.sent' });
  view.unmount();
  const reopened = draw(form, 'roundtrip', send);
  await waitFor(() => expect((deepQuery(reopened.container, 'textarea') as HTMLTextAreaElement)?.value).toBe('这是测试输入，不是学习记录。'));
  expect((screen.getByRole('button', { name: 'richAnswer.sent' }) as HTMLButtonElement).disabled).toBe(true);
  expect(send).toHaveBeenCalledTimes(2);
});

it('disables sends in a read-only surface and delegates media to the existing host', async () => {
  draw(form, 'readonly');
  expect((await screen.findByRole('button', { name: '提交主旨' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  draw(message([{ id: 'root', component: 'Image', url: 'https://example.invalid/image.png' }]), 'media');
  await screen.findByText('host media');
  expect(ports.renderMedia).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', props: { src: 'https://example.invalid/image.png' } }));
  expect(document.querySelector('img')).toBeNull();
});

// Real host IPC resolves later than the SDK's event forwarding. The immediate
// sender above did not catch an accepted submission incorrectly becoming retryable.
it('waits for a delayed host receipt before enabling retries or marking sent', async () => {
  let resolve!: (accepted: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  draw(form, 'delayed-host-receipt', send);
  fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Delayed IPC answer' } });
  fireEvent.click(screen.getByRole('button', { name: '提交主旨' }));
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  const pending = await screen.findByRole('button', { name: 'richAnswer.sending' });
  expect((pending as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(pending);
  await act(async () => { resolve(true); });
  expect((await screen.findByRole('button', { name: 'richAnswer.sent' }) as HTMLButtonElement).disabled).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
});

it('switches paragraphs locally and reopens the selected paragraph without sending or recording progress', async () => {
  const source = message([
    { id: 'root', component: 'Tabs', tabs: [{ title: '第 1 段', child: 'p1' }, { title: '第 2 段', child: 'p2' }] },
    { id: 'p1', component: 'Text', text: 'First test paragraph.' },
    { id: 'p2', component: 'Text', text: 'Second test paragraph.' },
  ]);
  const send = vi.fn().mockResolvedValue(true);
  const view = draw(source, 'navigation', send);
  fireEvent.click(await screen.findByRole('button', { name: '第 2 段' }));
  await screen.findByText('Second test paragraph.');
  expect(screen.queryByText('First test paragraph.')).toBeNull();
  expect(send).not.toHaveBeenCalled();
  view.unmount();
  draw(source, 'navigation', send);
  await screen.findByText('Second test paragraph.');
});

it.each([
  message([{ id: 'root', component: 'Text', text: 42 }]),
  message([{ id: 'root', component: 'UnknownComponent' }]),
  message([{ id: 'root', component: 'Column', children: ['missing'] }]),
  message([{ id: 'root', component: 'Column', children: ['root'] }]),
  form.replace('"version":"1.0"', '"version":"0.9"'),
])('degrades malformed schemas, missing/cyclic references and unsupported versions to readable source', async source => {
  draw(source, 'invalid');
  await screen.findByText('richAnswer.incomplete');
  expect(document.querySelector('pre')?.textContent).toBe(source);
  expect(document.querySelector('button')).toBeNull();
});

it('keeps quoted/unfinished fences as ordinary markdown and rejects executable requests', () => {
  expect(splitA2uiMessage('````text\n```a2ui\n{}\n```\n````').every(part => part.kind === 'markdown')).toBe(true);
  expect(splitA2uiMessage('```a2ui\n{}').every(part => part.kind === 'markdown')).toBe(true);
  expect(splitA2uiMessage('before\n```a2ui\n{}\n```\nafter').map(part => part.kind)).toEqual(['markdown', 'a2ui', 'markdown']);
  expect(() => readA2uiMessages(message([{ id: 'root', component: 'Text', text: { '@call': 'openUrl', args: { url: 'https://example.invalid' } } }]))).toThrow('executable');
});
