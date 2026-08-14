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

    destroy() {}
  }

  return { MockSortable };
});

vi.mock('sortablejs', () => ({ default: sortableMock.MockSortable }));

import { DraggableCardColumns } from '../DraggableCardColumns';

type SortableEvent = {
  item: HTMLElement;
  from: HTMLElement;
  to: HTMLElement;
  oldIndex: number;
  newIndex: number;
  newDraggableIndex: number;
};

function callback<T extends (...args: never[]) => unknown>(options: Record<string, unknown>, name: string) {
  return options[name] as T;
}

function columnIds(column: HTMLElement): string[] {
  return Array.from(column.children).map((card) => card.getAttribute('data-card-id') ?? '');
}

afterEach(() => {
  cleanup();
  sortableMock.MockSortable.instances.length = 0;
  sortableMock.MockSortable.active = null;
});

describe('DraggableCardColumns native drop disposition', () => {
  it('restores all columns and skips reorder when dropped outside', () => {
    const onReorder = vi.fn();
    const { container } = render(
      <DraggableCardColumns
        items={['a', 'b', 'c', 'd']}
        columns={2}
        getId={(id) => id}
        onReorder={onReorder}
        renderItem={(id) => <span>{id}</span>}
        reducedMotion
        forceFallback={false}
      />,
    );
    const columns = Array.from(container.firstElementChild?.children ?? []) as HTMLElement[];
    const [firstColumn, secondColumn] = columns;
    const instance = sortableMock.MockSortable.instances[0];
    const onStart = callback<() => void>(instance.options, 'onStart');
    const onEnd = callback<(event: SortableEvent) => void>(instance.options, 'onEnd');
    const moved = firstColumn.children[0] as HTMLElement;

    sortableMock.MockSortable.active = instance;
    onStart();
    secondColumn.append(moved);

    const external = document.createElement('div');
    document.body.append(external);
    external.dispatchEvent(new Event('drop', { bubbles: true }));

    onEnd({
      item: moved,
      from: firstColumn,
      to: secondColumn,
      oldIndex: 0,
      newIndex: secondColumn.children.length - 1,
      newDraggableIndex: secondColumn.children.length - 1,
    });

    expect(columnIds(firstColumn)).toEqual(['a', 'c']);
    expect(columnIds(secondColumn)).toEqual(['b', 'd']);
    expect(onReorder).not.toHaveBeenCalled();
    external.remove();
  });

  it('persists a cross-column reorder when dropped inside a column', () => {
    const onReorder = vi.fn();
    const { container } = render(
      <DraggableCardColumns
        items={['a', 'b', 'c', 'd']}
        columns={2}
        getId={(id) => id}
        onReorder={onReorder}
        renderItem={(id) => <span>{id}</span>}
        reducedMotion
        forceFallback={false}
      />,
    );
    const columns = Array.from(container.firstElementChild?.children ?? []) as HTMLElement[];
    const [firstColumn, secondColumn] = columns;
    const instance = sortableMock.MockSortable.instances[0];
    const onStart = callback<() => void>(instance.options, 'onStart');
    const onEnd = callback<(event: SortableEvent) => void>(instance.options, 'onEnd');
    const moved = firstColumn.children[0] as HTMLElement;

    sortableMock.MockSortable.active = instance;
    onStart();
    secondColumn.append(moved);
    (secondColumn.children[secondColumn.children.length - 1] as HTMLElement).dispatchEvent(
      new Event('drop', { bubbles: true }),
    );

    onEnd({
      item: moved,
      from: firstColumn,
      to: secondColumn,
      oldIndex: 0,
      newIndex: secondColumn.children.length - 1,
      newDraggableIndex: secondColumn.children.length - 1,
    });

    expect(columnIds(firstColumn)).toEqual(['a', 'c']);
    expect(columnIds(secondColumn)).toEqual(['b', 'd']);
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'd', 'a']);
  });
});
