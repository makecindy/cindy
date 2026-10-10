// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const sortableMock = vi.hoisted(() => {
  class MockSortable {
    static active: MockSortable | null = null;
    static instances: MockSortable[] = [];

    readonly el: HTMLElement;
    readonly options: Record<string, unknown>;

    constructor(el: HTMLElement, options: Record<string, unknown>) {
      this.el = el;
      this.options = options;
    }

    static create(el: HTMLElement, options: Record<string, unknown>) {
      const instance = new MockSortable(el, options);
      MockSortable.instances.push(instance);
      return instance;
    }

    option(name: string, value: unknown) {
      this.options[name] = value;
    }

    destroy() {}
  }

  return { MockSortable };
});

vi.mock('sortablejs', () => ({ default: sortableMock.MockSortable }));

import { SortableList, type SortableListProps } from '../SortableList';

type SortableEvent = {
  item: HTMLElement;
  from: HTMLElement;
  to?: HTMLElement;
  oldIndex: number;
  newIndex: number;
};

function callback<T extends (...args: never[]) => unknown>(
  options: Record<string, unknown>,
  name: string,
) {
  return options[name] as T;
}

function rowIds(container: HTMLElement): string[] {
  return Array.from(container.children).map((row) => row.getAttribute('data-sortable-id') ?? '');
}

afterEach(() => {
  cleanup();
  sortableMock.MockSortable.instances.length = 0;
  sortableMock.MockSortable.active = null;
  vi.restoreAllMocks();
});

type ListOverrides = Partial<SortableListProps<string>>;

function renderPair(sourceOverrides: ListOverrides = {}, targetOverrides: ListOverrides = {}) {
  const sourceReorder = vi.fn();
  const targetReorder = vi.fn();
  const sourceTransfer = vi.fn();
  const targetTransfer = vi.fn();
  const pair = (source: ListOverrides, target: ListOverrides, showTarget = true) => (
    <>
      <SortableList
        items={['a', 'b', 'c']}
        getId={(id) => id}
        renderItem={(id) => <span>{id}</span>}
        onReorder={sourceReorder}
        crossListGroup="projects"
        listId="source"
        onTransfer={sourceTransfer}
        {...source}
      />
      {showTarget && (
        <SortableList
          items={['d', 'e']}
          getId={(id) => id}
          renderItem={(id) => <span>{id}</span>}
          onReorder={targetReorder}
          crossListGroup="projects"
          listId="target"
          onTransfer={targetTransfer}
          {...target}
        />
      )}
    </>
  );
  const view = render(pair(sourceOverrides, targetOverrides));
  const [source, target] = sortableMock.MockSortable.instances;
  const start = () => {
    sortableMock.MockSortable.active = source;
    callback<() => void>(source.options, 'onStart')();
  };
  const move = (oldIndex = 0, newIndex = 1) => {
    const item = source.el.children[oldIndex] as HTMLElement;
    target.el.insertBefore(item, target.el.children[newIndex] ?? null);
    return { item, from: source.el, to: target.el, oldIndex, newIndex };
  };
  const end = (event: SortableEvent) =>
    callback<(event: SortableEvent) => void>(source.options, 'onEnd')(event);
  return {
    source,
    target,
    sourceReorder,
    targetReorder,
    sourceTransfer,
    targetTransfer,
    start,
    move,
    end,
    rerender: (source: ListOverrides, target: ListOverrides = targetOverrides) =>
      view.rerender(pair(source, target)),
    unmountTarget: () => view.rerender(pair(sourceOverrides, targetOverrides, false)),
  };
}

describe('SortableList cross-list transfer', () => {
  it.each([true, false])(
    'cancels a pending transfer before React applies an external move of the same item (fallback=%s)',
    (forceFallback) => {
      const onDragActiveChange = vi.fn();
      const pair = renderPair({ forceFallback, onDragActiveChange }, { forceFallback });
      pair.start();
      const event = pair.move();
      expect(rowIds(pair.source.el)).toEqual(['b', 'c']);
      expect(rowIds(pair.target.el)).toEqual(['d', 'a', 'e']);
      expect(() =>
        pair.rerender(
          { items: ['b', 'c'], forceFallback, onDragActiveChange },
          { items: ['a', 'd', 'e'], forceFallback },
        ),
      ).not.toThrow();
      expect(rowIds(pair.source.el)).toEqual(['b', 'c']);
      expect(rowIds(pair.target.el)).toEqual(['a', 'd', 'e']);
      pair.end(event);
      expect(rowIds(pair.source.el)).toEqual(['b', 'c']);
      expect(rowIds(pair.target.el)).toEqual(['a', 'd', 'e']);
      expect(pair.sourceTransfer).not.toHaveBeenCalled();
      expect(pair.sourceReorder).not.toHaveBeenCalled();
      expect(pair.targetTransfer).not.toHaveBeenCalled();
      expect(onDragActiveChange.mock.calls).toEqual([[true], [false]]);
      expect(document.body.classList.contains('xdt-sorting')).toBe(false);
    },
  );

  it.each([
    ['source removal', ['b', 'c'], ['d', 'e']],
    ['target reorder', ['a', 'b', 'c'], ['e', 'd']],
  ])('cancels before applying an external %s', (_label, sourceItems, targetItems) => {
    const pair = renderPair();
    pair.start();
    const event = pair.move();
    expect(() => pair.rerender({ items: sourceItems }, { items: targetItems })).not.toThrow();
    pair.end(event);
    expect(rowIds(pair.source.el)).toEqual(sourceItems);
    expect(rowIds(pair.target.el)).toEqual(targetItems);
    expect(pair.sourceTransfer).not.toHaveBeenCalled();
    expect(pair.sourceReorder).not.toHaveBeenCalled();
  });

  it('restores the source before React unmounts the current target', () => {
    const pair = renderPair();
    pair.start();
    const event = pair.move();
    expect(() => pair.unmountTarget()).not.toThrow();
    pair.end(event);
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
    expect(pair.target.el.isConnected).toBe(false);
    expect(pair.sourceTransfer).not.toHaveBeenCalled();
  });

  it('keeps a pending transfer through a rerender with unchanged item ids', () => {
    const pair = renderPair();
    pair.start();
    const event = pair.move();
    pair.rerender({ items: ['a', 'b', 'c'] }, { items: ['d', 'e'] });
    expect(rowIds(pair.target.el)).toEqual(['d', 'a', 'e']);
    pair.end(event);
    expect(pair.sourceTransfer).toHaveBeenCalledExactlyOnceWith({
      itemId: 'a',
      fromListId: 'source',
      toListId: 'target',
      newIndex: 1,
      targetOrderIds: ['d', 'a', 'e'],
    });
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
    expect(rowIds(pair.target.el)).toEqual(['d', 'e']);
  });

  it('restores both lists before notifying drag end and the source transfer callback', () => {
    const events: string[] = [];
    const onDragActiveChange = vi.fn((active: boolean) => {
      if (active) return;
      expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
      expect(rowIds(pair.target.el)).toEqual(['d', 'e']);
      events.push('inactive');
    });
    const pair = renderPair({ onDragActiveChange });
    pair.sourceTransfer.mockImplementation(() => {
      expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
      expect(rowIds(pair.target.el)).toEqual(['d', 'e']);
      events.push('transfer');
    });
    pair.start();
    pair.end(pair.move());
    expect(events).toEqual(['inactive', 'transfer']);
    expect(pair.sourceTransfer).toHaveBeenCalledExactlyOnceWith({
      itemId: 'a',
      fromListId: 'source',
      toListId: 'target',
      newIndex: 1,
      targetOrderIds: ['d', 'a', 'e'],
    });
    expect(pair.targetTransfer).not.toHaveBeenCalled();
    expect(pair.sourceReorder).not.toHaveBeenCalled();
    expect(pair.targetReorder).not.toHaveBeenCalled();
    expect(document.body.classList.contains('xdt-sorting')).toBe(false);
    onDragActiveChange.mockReset();
  });

  it('treats identical indexes in different lists as a transfer', () => {
    const pair = renderPair();
    pair.start();
    pair.end(pair.move(1, 1));
    expect(pair.sourceTransfer).toHaveBeenCalledExactlyOnceWith({
      itemId: 'b',
      fromListId: 'source',
      toListId: 'target',
      newIndex: 1,
      targetOrderIds: ['d', 'b', 'e'],
    });
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
    expect(pair.sourceReorder).not.toHaveBeenCalled();
  });

  it('accepts an empty target without adding layout styles', () => {
    const pair = renderPair({}, { items: [], onTransfer: undefined });
    pair.start();
    pair.end(pair.move(2, 0));
    expect(pair.sourceTransfer).toHaveBeenCalledExactlyOnceWith({
      itemId: 'c',
      fromListId: 'source',
      toListId: 'target',
      newIndex: 0,
      targetOrderIds: ['c'],
    });
    expect(rowIds(pair.target.el)).toEqual([]);
    expect(pair.target.options.emptyInsertThreshold).toBe(20);
    expect(pair.target.el.getAttribute('style')).toBeNull();
    expect(pair.target.el.getAttribute('class')).toBeNull();
    expect(pair.target.el.dataset.sortableListId).toBe('target');
  });

  it.each(['blur', 'visibilitychange', 'pointercancel', 'touchcancel'])(
    'cancels transfer on %s after restoring DOM',
    (kind) => {
      const pair = renderPair();
      pair.start();
      const event = pair.move();
      if (kind === 'blur') window.dispatchEvent(new Event(kind));
      else {
        if (kind === 'visibilitychange')
          vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event(kind));
      }
      pair.end(event);
      expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
      expect(rowIds(pair.target.el)).toEqual(['d', 'e']);
      expect(pair.sourceTransfer).not.toHaveBeenCalled();
      expect(pair.sourceReorder).not.toHaveBeenCalled();
      expect(document.body.classList.contains('xdt-sorting')).toBe(false);
      pair.start();
      pair.end(pair.move());
      expect(pair.sourceTransfer).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['different group', {}, { crossListGroup: 'other' }],
    ['missing target group', {}, { crossListGroup: undefined }],
    ['missing source group', { crossListGroup: undefined }, {}],
    ['missing target id', {}, { listId: undefined }],
    ['missing source id', { listId: undefined }, {}],
    ['duplicate list id', {}, { listId: 'source' }],
    ['missing source callback', { onTransfer: undefined }, {}],
    ['disabled target', {}, { disabled: true }],
    ['disabled source', { disabled: true }, {}],
  ] satisfies [string, ListOverrides, ListOverrides][])('rejects %s', (_label, source, target) => {
    const pair = renderPair(source, target);
    pair.start();
    pair.end(pair.move());
    expect(pair.sourceTransfer).not.toHaveBeenCalled();
    expect(pair.targetTransfer).not.toHaveBeenCalled();
    expect(pair.sourceReorder).not.toHaveBeenCalled();
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
    expect(rowIds(pair.target.el)).toEqual(['d', 'e']);
  });

  it('restricts Sortable group admission and updates it without remounting', () => {
    const pair = renderPair();
    const group = pair.target.options.group as {
      name: string;
      pull: boolean;
      put: (to: typeof pair.target, from: typeof pair.source) => boolean;
    };
    expect(group.name).toBe('projects');
    expect(group.pull).toBe(true);
    expect(group.put(pair.target, pair.source)).toBe(true);
    pair.rerender({ crossListGroup: 'other' });
    expect(group.put(pair.target, pair.source)).toBe(false);
    pair.rerender({}, { disabled: true });
    expect(group.put(pair.target, pair.source)).toBe(false);
    pair.rerender({}, { listId: undefined });
    expect(group.put(pair.target, pair.source)).toBe(false);
    pair.rerender({ crossListGroup: undefined }, { crossListGroup: undefined });
    expect(pair.source.options.group).toBe('');
    expect(pair.target.options.group).toBe('');
    expect(sortableMock.MockSortable.instances).toHaveLength(2);
  });

  it('uses the latest source callback and target items', () => {
    const pair = renderPair();
    const onTransfer = vi.fn();
    pair.rerender({ onTransfer }, { items: ['f', 'g'] });
    pair.start();
    pair.end(pair.move());
    expect(onTransfer).toHaveBeenCalledExactlyOnceWith({
      itemId: 'a',
      fromListId: 'source',
      toListId: 'target',
      newIndex: 1,
      targetOrderIds: ['f', 'a', 'g'],
    });
    expect(pair.sourceTransfer).not.toHaveBeenCalled();
  });

  it('lets React apply a transfer after both DOM trees have been restored', () => {
    const pair = renderPair();
    pair.sourceTransfer.mockImplementation(() => {
      pair.rerender({ items: ['b', 'c'] }, { items: ['d', 'a', 'e'] });
    });
    pair.start();
    expect(() => pair.end(pair.move())).not.toThrow();
    expect(rowIds(pair.source.el)).toEqual(['b', 'c']);
    expect(rowIds(pair.target.el)).toEqual(['d', 'a', 'e']);
  });

  it('restores the dragged item when its target is no longer connected', () => {
    const pair = renderPair();
    pair.start();
    const event = pair.move();
    const parent = pair.target.el.parentElement;
    pair.target.el.remove();
    pair.end(event);
    parent?.append(pair.target.el);
    expect(pair.sourceTransfer).not.toHaveBeenCalled();
    expect(pair.sourceReorder).not.toHaveBeenCalled();
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
    expect(rowIds(pair.target.el)).toEqual(['d', 'e']);
  });

  it('rejects an unregistered target even if it advertises a list id', () => {
    const pair = renderPair();
    const target = document.createElement('div');
    target.dataset.sortableListId = 'target';
    document.body.append(target);
    pair.start();
    const event = pair.move();
    target.append(event.item);
    pair.end({ ...event, to: target, newIndex: 0 });
    expect(pair.sourceTransfer).not.toHaveBeenCalled();
    expect(pair.sourceReorder).not.toHaveBeenCalled();
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
    expect(rowIds(target)).toEqual([]);
    target.remove();
  });

  it('continues to reorder within a cross-list-enabled source', () => {
    const pair = renderPair();
    pair.start();
    const item = pair.source.el.children[0] as HTMLElement;
    pair.source.el.append(item);
    pair.end({ item, from: pair.source.el, to: pair.source.el, oldIndex: 0, newIndex: 2 });
    expect(pair.sourceReorder).toHaveBeenCalledExactlyOnceWith(['b', 'c', 'a']);
    expect(pair.sourceTransfer).not.toHaveBeenCalled();
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
  });

  it.each(['target', 'external', 'none'])('checks the final native drop on %s', (destination) => {
    const pair = renderPair({ forceFallback: false }, { forceFallback: false });
    pair.start();
    const event = pair.move();
    if (destination !== 'none') {
      (destination === 'target' ? event.item : document.body).dispatchEvent(
        new Event('drop', { bubbles: true }),
      );
    }
    pair.end(event);
    expect(pair.sourceTransfer).toHaveBeenCalledTimes(destination === 'target' ? 1 : 0);
    expect(pair.sourceReorder).not.toHaveBeenCalled();
    expect(rowIds(pair.source.el)).toEqual(['a', 'b', 'c']);
    expect(rowIds(pair.target.el)).toEqual(['d', 'e']);
  });

  it('keeps legacy fallback reorder and reduced motion when new props are omitted', () => {
    const onReorder = vi.fn();
    render(
      <SortableList
        items={['a', 'b']}
        getId={(id) => id}
        renderItem={(id) => id}
        onReorder={onReorder}
        reducedMotion
      />,
    );
    const instance = sortableMock.MockSortable.instances[0];
    expect(instance.options.forceFallback).toBe(true);
    expect(instance.options.animation).toBe(0);
    expect(instance.options.group).toBe('');
    expect(instance.options.emptyInsertThreshold).toBe(5);
    expect(instance.el.hasAttribute('data-sortable-list-id')).toBe(false);
    const item = instance.el.children[0] as HTMLElement;
    callback<() => void>(instance.options, 'onStart')();
    instance.el.append(item);
    callback<(event: SortableEvent) => void>(
      instance.options,
      'onEnd',
    )({
      item,
      from: instance.el,
      to: instance.el,
      oldIndex: 0,
      newIndex: 1,
    });
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(['b', 'a']);
    expect(rowIds(instance.el)).toEqual(['a', 'b']);
  });
});

describe('SortableList native drop disposition', () => {
  it('restores the DOM and skips reorder when the final drop is external', () => {
    const onReorder = vi.fn();
    const { container } = render(
      <SortableList
        items={['a', 'b']}
        getId={(id) => id}
        onReorder={onReorder}
        renderItem={(id) => <span>{id}</span>}
        forceFallback={false}
      />,
    );
    const list = container.firstElementChild as HTMLElement;
    const instance = sortableMock.MockSortable.instances[0];
    const onStart = callback<() => void>(instance.options, 'onStart');
    const onEnd = callback<(event: SortableEvent) => void>(instance.options, 'onEnd');
    const moved = list.children[0] as HTMLElement;

    sortableMock.MockSortable.active = instance;
    onStart();
    list.append(moved);

    const external = document.createElement('div');
    document.body.append(external);
    external.dispatchEvent(new Event('drop', { bubbles: true }));

    onEnd({ item: moved, from: list, oldIndex: 0, newIndex: 1 });

    expect(rowIds(list)).toEqual(['a', 'b']);
    expect(onReorder).not.toHaveBeenCalled();
    external.remove();
  });

  it('restores an upward transient move when the final drop is external', () => {
    const onReorder = vi.fn();
    const { container } = render(
      <SortableList
        items={['a', 'b', 'c']}
        getId={(id) => id}
        onReorder={onReorder}
        renderItem={(id) => <span>{id}</span>}
        forceFallback={false}
      />,
    );
    const list = container.firstElementChild as HTMLElement;
    const instance = sortableMock.MockSortable.instances[0];
    const onStart = callback<() => void>(instance.options, 'onStart');
    const onEnd = callback<(event: SortableEvent) => void>(instance.options, 'onEnd');
    const moved = list.children[2] as HTMLElement;

    sortableMock.MockSortable.active = instance;
    onStart();
    list.insertBefore(moved, list.children[0] ?? null);

    const external = document.createElement('div');
    document.body.append(external);
    external.dispatchEvent(new Event('drop', { bubbles: true }));

    onEnd({ item: moved, from: list, oldIndex: 2, newIndex: 0 });

    expect(rowIds(list)).toEqual(['a', 'b', 'c']);
    expect(onReorder).not.toHaveBeenCalled();
    external.remove();
  });

  it('persists reorder when the final drop is inside the sortable container', () => {
    const onReorder = vi.fn();
    const { container } = render(
      <SortableList
        items={['a', 'b']}
        getId={(id) => id}
        onReorder={onReorder}
        renderItem={(id) => <span>{id}</span>}
        forceFallback={false}
      />,
    );
    const list = container.firstElementChild as HTMLElement;
    const instance = sortableMock.MockSortable.instances[0];
    const onStart = callback<() => void>(instance.options, 'onStart');
    const onEnd = callback<(event: SortableEvent) => void>(instance.options, 'onEnd');
    const moved = list.children[0] as HTMLElement;

    sortableMock.MockSortable.active = instance;
    onStart();
    list.append(moved);
    (list.children[0] as HTMLElement).dispatchEvent(new Event('drop', { bubbles: true }));

    onEnd({ item: moved, from: list, oldIndex: 0, newIndex: 1 });

    expect(rowIds(list)).toEqual(['a', 'b']);
    expect(onReorder).toHaveBeenCalledWith(['b', 'a']);
  });
});
