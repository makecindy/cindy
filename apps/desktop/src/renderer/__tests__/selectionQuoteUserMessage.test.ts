import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { selectionIntersectsFloatingQuoteDisabledArea } from '../components/chat/SelectionQuoteButton';

// Windows checkout(core.autocrlf)下源码是 CRLF;统一归一成 LF,含 \n 的多行片段断言才跨平台成立。
const readTextLf = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

const userMessageSource = readTextLf(
  resolve(__dirname, '..', 'components', 'chat', 'UserMessage.tsx'),
);

describe('SelectionQuoteButton — user message floating action exclusion', () => {
  it('marks the whole user message as opted out of the floating action', () => {
    expect(userMessageSource).toContain('data-selection-floating-quote-disabled=""');
  });

  it('renders sent quotes with the same compact chip as the composer', () => {
    expect(userMessageSource).toContain('<QuoteChip quote={segment.quote} />');
    expect(userMessageSource).toContain(
      'mx-1 inline-flex max-w-[min(240px,55vw)] select-none align-middle',
    );
    expect(userMessageSource).not.toContain('min-w-0 rounded-lg border px-3 py-2');
  });

  it('keeps long-message collapse enabled for mixed quote and prose messages', () => {
    const collapseGuard = userMessageSource.slice(
      userMessageSource.indexOf('const collapseMeasureEnabled ='),
      userMessageSource.indexOf(
        'const { mirrorRef:',
        userMessageSource.indexOf('const collapseMeasureEnabled ='),
      ),
    );
    expect(collapseGuard).not.toContain('inlineQuoteCount === 0');
    expect(userMessageSource).toMatch(
      /longMessageCollapsed\s*&&\s*\(automationOrigin \? 'line-clamp-3' : 'line-clamp-10'\)/,
    );
    expect(userMessageSource).toMatch(/\{renderContent\(\n\s+segment\.text,/);
    expect(userMessageSource).toContain('!longMessageCollapsed,');
  });

  it('keeps right-click Add to chat enabled while suppressing the floating button', () => {
    const buttonSource = readTextLf(
      resolve(__dirname, '..', 'components', 'chat', 'SelectionQuoteButton.tsx'),
    );
    expect(buttonSource).toContain("container.dataset.selectionQuoteContext = '';");
    expect(buttonSource).toContain('readSelectionInStream(true)');
    expect(buttonSource).toContain(
      '!allowQuoteDisabled && selectionIntersectsFloatingQuoteDisabledArea',
    );
  });

  it('keeps the floating action at its intrinsic width near either viewport edge', () => {
    const buttonSource = readTextLf(
      resolve(__dirname, '..', 'components', 'chat', 'SelectionQuoteButton.tsx'),
    );

    expect(buttonSource).toContain('w-max');
    expect(buttonSource).toContain('whitespace-nowrap');
    expect(buttonSource).toContain('const BUTTON_MIN_X_PX = 100;');
    expect(buttonSource).toContain('const BUTTON_RIGHT_MARGIN_PX = 100;');
  });

  it('rejects a selection intersecting any copy-only region', () => {
    const allowed = {} as Element;
    const disabled = {} as Element;
    const range = {
      intersectsNode: vi.fn((node: Node) => node === disabled),
    };
    const container = {
      querySelectorAll: vi.fn(() => [allowed, disabled]),
    };

    expect(
      selectionIntersectsFloatingQuoteDisabledArea(
        range as Pick<Range, 'intersectsNode'>,
        container as unknown as Pick<HTMLElement, 'querySelectorAll'>,
      ),
    ).toBe(true);
    expect(range.intersectsNode).toHaveBeenCalledTimes(2);
  });

  it('keeps assistant/file selections eligible when no copy-only region intersects', () => {
    const range = { intersectsNode: vi.fn(() => false) };
    const container = { querySelectorAll: vi.fn(() => [{} as Element]) };

    expect(
      selectionIntersectsFloatingQuoteDisabledArea(
        range as Pick<Range, 'intersectsNode'>,
        container as unknown as Pick<HTMLElement, 'querySelectorAll'>,
      ),
    ).toBe(false);
  });
});
