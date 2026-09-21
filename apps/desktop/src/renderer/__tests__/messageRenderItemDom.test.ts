// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { findRenderItemElement } from '../components/chat/messageViewportCompensation';
import { pickIntersectingChildAnchor, readViewportChildAnchorClientId } from '../components/chat/MessageStream';

describe('render item identity across asynchronous cards', () => {
  it('keeps the same message when an earlier card mounts or disappears', () => {
    const container = document.createElement('div');
    const message = document.createElement('div');
    message.setAttribute('data-render-item-key', 'msg-target');
    container.append(message);
    expect(findRenderItemElement(container, 'genfiles-earlier')).toBeUndefined();
    expect(findRenderItemElement(container, 'msg-target')).toBe(message);

    const card = document.createElement('div');
    card.setAttribute('data-render-item-key', 'genfiles-earlier');
    container.prepend(card);
    expect(findRenderItemElement(container, 'msg-target')).toBe(message);
    expect(findRenderItemElement(container, 'genfiles-earlier')).toBe(card);
    card.remove();
    expect(findRenderItemElement(container, 'msg-target')).toBe(message);
    expect(findRenderItemElement(container, 'missing')).toBeUndefined();
  });
});

// Exercise the actual capture callback, including absent/zero-height rows and gaps.
it('captures a visible row after empty rows and retains its signed viewport gap', () => {
  const source = readFileSync(resolve(__dirname, '../components/chat/MessageStream.tsx'), 'utf8');
  const start = source.indexOf('  const measureViewportTop = useCallback');
  const end = source.indexOf('  const refreshViewportAnchor = useCallback', start);
  const code = ts.transpileModule(source.slice(start, end) + '\nreturn measureViewportTop();', {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const container = document.createElement('div');
  container.getBoundingClientRect = () => ({ top: 40 }) as DOMRect;
  const items = document.createElement('div');
  for (const [key, top, height] of [['empty', 42, 0], ['visible', 54, 80]] as const) {
    const row = items.appendChild(document.createElement('div'));
    row.dataset.renderItemKey = key;
    row.getBoundingClientRect = () => ({ top, bottom: top + height, height }) as DOMRect;
  }
  const result = new Function('useCallback', 'scrollRef', 'itemsRef', 'pickIntersectingChildAnchor', 'readViewportChildAnchorClientId', code)(
    (callback: unknown) => callback, { current: container }, { current: items }, pickIntersectingChildAnchor, readViewportChildAnchorClientId,
  );
  expect(result).toEqual({ viewportTopKey: 'visible', offset: -14 });
});
