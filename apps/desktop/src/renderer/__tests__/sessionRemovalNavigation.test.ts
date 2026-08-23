// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  getVisibleSidebarSessionIds,
  pickSessionIdAfterRemoval,
} from '@/features/cc-agent/lib/sessionRemovalNavigation';

describe('pickSessionIdAfterRemoval', () => {
  it('moves to the next session after the removed anchor', () => {
    expect(pickSessionIdAfterRemoval(['a', 'b', 'c'], new Set(['b']), 'b')).toBe('c');
  });

  it('moves to the next session when removing the first visible one', () => {
    expect(pickSessionIdAfterRemoval(['a', 'b', 'c'], new Set(['a']), 'a')).toBe('b');
  });

  it('falls back to the previous session when removing the last visible one', () => {
    expect(pickSessionIdAfterRemoval(['a', 'b', 'c'], new Set(['c']), 'c')).toBe('b');
  });

  it('skips other removed sessions for bulk deletes', () => {
    expect(pickSessionIdAfterRemoval(['a', 'b', 'c', 'd'], new Set(['b', 'c']), 'b')).toBe('d');
  });

  it('returns null when no visible session remains', () => {
    expect(pickSessionIdAfterRemoval(['a'], new Set(['a']), 'a')).toBeNull();
  });

  it('returns null when the anchor is not in the ordered list', () => {
    expect(pickSessionIdAfterRemoval(['a', 'b'], new Set(['x']), 'x')).toBeNull();
  });
});

describe('getVisibleSidebarSessionIds', () => {
  it('reads sidebar row ids in DOM order and de-duplicates repeated rows', () => {
    const root = {
      querySelectorAll: () => [
        { dataset: { sessionId: 'a' } },
        { dataset: { sessionId: 'b' } },
        { dataset: { sessionId: 'a' } },
        { dataset: {} },
      ],
    } as unknown as Element;

    expect(getVisibleSidebarSessionIds(root)).toEqual(['a', 'b']);
  });

  it('uses explicit row order for multi-column pinned cards before de-duping', () => {
    const root = document.createElement('div');
    const col0 = document.createElement('div');
    const col1 = document.createElement('div');
    root.append(col0, col1);

    const appendRow = (col: HTMLElement, sessionId: string, order: string) => {
      const wrapper = document.createElement('div');
      wrapper.dataset.sidebarRowOrder = order;
      const row = document.createElement('div');
      row.dataset.sidebarSessionRow = 'true';
      row.dataset.sessionId = sessionId;
      wrapper.append(row);
      col.append(wrapper);
    };

    appendRow(col0, 'a', '0');
    appendRow(col0, 'c', '2');
    appendRow(col0, 'e', '4');
    appendRow(col1, 'b', '1');
    appendRow(col1, 'd', '3');
    appendRow(col1, 'f', '5');

    expect(getVisibleSidebarSessionIds(root)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('ignores rows hidden by their own or ancestor render style', () => {
    type FakeElement = {
      dataset?: { sessionId?: string };
      parentElement: FakeElement | null;
      ownerDocument: {
        defaultView: {
          getComputedStyle: (node: FakeElement) => {
            display: string;
            visibility: string;
            opacity: string;
            pointerEvents: string;
          };
        };
      };
      style: Partial<{
        display: string;
        visibility: string;
        opacity: string;
        pointerEvents: string;
      }>;
      hidden?: boolean;
      ariaHidden?: boolean;
      hasAttribute: (name: string) => boolean;
      getAttribute: (name: string) => string | null;
    };
    const defaultStyle = {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      pointerEvents: 'auto',
    };
    const doc = {
      defaultView: {
        getComputedStyle: (node: FakeElement) => ({ ...defaultStyle, ...node.style }),
      },
    };
    const makeElement = (
      sessionId: string | null,
      style: FakeElement['style'] = {},
      parentElement: FakeElement | null = null,
      options: Pick<FakeElement, 'hidden' | 'ariaHidden'> = {},
    ): FakeElement => ({
      dataset: sessionId ? { sessionId } : {},
      parentElement,
      ownerDocument: doc,
      style,
      ...options,
      hasAttribute: (name) => name === 'hidden' && Boolean(options.hidden),
      getAttribute: (name) => (name === 'aria-hidden' && options.ariaHidden ? 'true' : null),
    });

    const hiddenAncestor = makeElement(null, { opacity: '0', pointerEvents: 'none' });
    const ariaHiddenAncestor = makeElement(null, {}, null, { ariaHidden: true });
    const pointerSuppressedAncestor = makeElement(null, { pointerEvents: 'none' });
    const visible = makeElement('visible');
    const visibleUnderAriaHidden = makeElement('visible-under-aria-hidden', {}, ariaHiddenAncestor);
    const visibleUnderPointerSuppression = makeElement(
      'visible-under-pointer-suppression',
      {},
      pointerSuppressedAncestor,
    );
    const hiddenByAncestor = makeElement('hidden-by-ancestor', {}, hiddenAncestor);
    const hiddenBySelf = makeElement('hidden-by-self', { display: 'none' });
    const hiddenAttribute = makeElement('hidden-attribute', {}, null, { hidden: true });
    const root = {
      querySelectorAll: () => [
        visible,
        visibleUnderAriaHidden,
        visibleUnderPointerSuppression,
        hiddenByAncestor,
        hiddenBySelf,
        hiddenAttribute,
      ],
    } as unknown as Element;

    expect(getVisibleSidebarSessionIds(root)).toEqual([
      'visible',
      'visible-under-aria-hidden',
      'visible-under-pointer-suppression',
    ]);
  });

  it('reads search hits and ignores the list underneath a search overlay', () => {
    const aside = document.createElement('aside');
    const list = document.createElement('div');
    const covered = document.createElement('div');
    covered.dataset.sidebarSessionRow = 'true';
    covered.dataset.sessionId = 'old';
    list.append(covered);

    const overlay = document.createElement('div');
    overlay.dataset.conversationSearchSurface = '';
    overlay.dataset.conversationSearchOverlay = '';
    const hit = document.createElement('div');
    hit.dataset.sidebarSessionRow = 'true';
    hit.dataset.sessionId = 'hit';
    overlay.append(hit);

    aside.append(list, overlay);
    document.body.append(aside);
    try {
      expect(getVisibleSidebarSessionIds()).toEqual(['hit']);
    } finally {
      aside.remove();
    }
  });

  it('keeps the real sidebar list when only the resident search input is marked', () => {
    const aside = document.createElement('aside');
    const search = document.createElement('div');
    search.dataset.conversationSearchSurface = '';
    const row = document.createElement('div');
    row.dataset.sidebarSessionRow = 'true';
    row.dataset.sessionId = 'visible';
    aside.append(search, row);
    document.body.append(aside);
    try {
      expect(getVisibleSidebarSessionIds()).toEqual(['visible']);
    } finally {
      aside.remove();
    }
  });
});
