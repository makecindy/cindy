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

import { SortableList } from '../SortableList';

type SortableEvent = {
  item: HTMLElement;
  from: HTMLElement;
  oldIndex: number;
  newIndex: number;
};

function callback<T extends (...args: never[]) => unknown>(options: Record<string, unknown>, name: string) {
  return options[name] as T;
}

function rowIds(container: HTMLElement): string[] {
  return Array.from(container.children).map((row) => row.getAttribute('data-sortable-id') ?? '');
}

afterEach(() => {
  cleanup();
  sortableMock.MockSortable.instances.length = 0;
  sortableMock.MockSortable.active = null;
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
