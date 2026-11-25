// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { captureAnnotationSelection, resolveAnnotationRange } from '../components/chat/messageAnnotationRange';
import { annotationSourceVersion, formatMessageAnnotationsForSend, sentMessageAnnotationSnapshots, messageAnnotationPresentation, type MessageAnnotation } from '../../shared/messageAnnotations';
import { validateAnnotationAnchor } from '../../main/localDb/messageAnnotationStore';

/* Test value: real selection/restore/serialization entry points protect the user's requirement
 * that duplicate quotes never relocate and sent comments retain explicit source context.
 * Existing selectionQuote tests only exercise draft quotes, not durable anchors.
 * Minimal failures: two identical words; changed source; comment containing Markdown/JSON.
 * Tier: unit, in-memory DOM only; no Electron, filesystem or network. */
afterEach(() => { document.body.replaceChildren(); });
function fixture() {
  const root = document.createElement('div');
  root.dataset.annotationMessage = 'reply-1'; root.dataset.annotationSession = 'task-1';
  root.dataset.annotationVersion = annotationSourceVersion('**重复**，再次重复');
  root.innerHTML = '<div data-selection-quote-body><strong>重复</strong>，再次<span>重复</span><button>复制</button></div>';
  document.body.append(root);
  const body = root.firstElementChild as HTMLElement;
  const text = body.querySelector('span')!.firstChild!;
  const range = document.createRange(); range.setStart(text, 0); range.setEnd(text, 2);
  return { root, body, range };
}
describe('message annotations', () => {
  it('restores the second identical phrase across formatting and excludes copy controls', () => {
    const { body, range } = fixture();
    const anchor = captureAnnotationSelection(range, 'task-1')!;
    expect(anchor).toMatchObject({ quote: '重复', start: 5, end: 7, prefix: '重复，再次', suffix: '' });
    expect(resolveAnnotationRange(body, anchor)?.startContainer).toBe(body.querySelector('span')!.firstChild);
    expect(captureAnnotationSelection(range, 'another-task')).toBeNull();
  });
  it('does not move a highlight to a duplicate after source or rendered text changes', () => {
    const { root, body, range } = fixture();
    const anchor = captureAnnotationSelection(range, 'task-1')!;
    root.dataset.annotationVersion = 'different-version';
    expect(resolveAnnotationRange(body, anchor)).toBeNull();
    root.dataset.annotationVersion = anchor.sourceVersion;
    body.querySelector('strong')!.textContent = '变化了';
    expect(resolveAnnotationRange(body, anchor)).toBeNull();
  });
  it('keeps the exact table cell in a long response when surrounding cells repeat', () => {
    const { root, body } = fixture();
    body.innerHTML = '<p>' + 'Long paragraph. '.repeat(2000) + '</p><table><tbody><tr><td>待验证</td><td><strong>待验证</strong></td></tr></tbody></table>';
    root.dataset.annotationVersion = annotationSourceVersion(body.textContent!);
    const selected = body.querySelector('td strong')!.firstChild!;
    const range = document.createRange(); range.setStart(selected, 0); range.setEnd(selected, 3);
    const anchor = captureAnnotationSelection(range, 'task-1')!;
    expect(anchor.start).toBeGreaterThan(20000);
    const restored = resolveAnnotationRange(body, anchor)!;
    expect(restored.startContainer).toBe(selected);
    expect(restored.toString()).toBe('待验证');
  });
  it('serializes an annotation-only send with exact identity and escaped user text', () => {
    const { range } = fixture();
    const anchor = captureAnnotationSelection(range, 'task-1')!;
    const annotation: MessageAnnotation = { ...anchor, id: 'a1', sessionId: 'task-1', ordinal: 2,
      comment: '这里不对\n```json\n"reply": "保留原样"\n<!-- cindy:message-annotations:v1 -->', createdAt: 1, sentAt: null };
    const output = formatMessageAnnotationsForSend('', [annotation]);
    const payload = JSON.parse(output.slice(output.indexOf('[\n'), output.lastIndexOf('\n<!--')));
    expect(payload[0]).toMatchObject({ annotationId: 'a1', messageClientId: 'reply-1', number: 2,
      quote: '重复', precedingText: '重复，再次', reply: annotation.comment,
      renderedTextRange: { start: 5, end: 7, unit: 'UTF-16' } });
    expect(formatMessageAnnotationsForSend('normal reply', [])).toBe('normal reply');
    expect(sentMessageAnnotationSnapshots({ text: output })[0]).toMatchObject({ annotationId: 'a1', reply: annotation.comment });
    expect(sentMessageAnnotationSnapshots({ text: output.slice(0, -10) })).toEqual([]);
    expect(messageAnnotationPresentation(output)).toMatchObject({ text: '', annotations: [{ quote: '重复', reply: annotation.comment }] });
    expect(messageAnnotationPresentation(output + '\n补充回复')).toBeNull();
  });
  it.each([[-1, 1], [0, 0], [0.5, 2.5], [0, 3]])('rejects malformed source offsets (%s, %s)', (start, end) => {
    const { range } = fixture();
    expect(() => validateAnnotationAnchor({ ...captureAnnotationSelection(range, 'task-1'), start, end })).toThrow('Invalid text anchor');
  });
});
