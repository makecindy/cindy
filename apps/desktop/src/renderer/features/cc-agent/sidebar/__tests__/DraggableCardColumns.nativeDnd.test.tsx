// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const sortableMock = vi.hoisted(() => {
  class MockSortable {
    static active: MockSortable | null = null;
    static dragged: HTMLElement | null = null;
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
import { cancelActiveSortable } from '@/components/sidebar/SortableList';

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
  sortableMock.MockSortable.dragged = null;
});

describe('DraggableCardColumns native drop disposition', () => {
  // #11289 review: cancel a live native cross-column drag before React applies
  // the new order. Completed-drop tests do not cover a mode change mid-drag.
  it('restores the card before a sort-mode change moves it to another column', () => {
    const onReorder = vi.fn();
    const renderColumns = (items: string[], disabled = false) => (
      <div data-sortable-scope="pinned">
        <DraggableCardColumns
          items={items}
          columns={2}
          getId={(id) => id}
          renderItem={(id) => <span>{id}</span>}
          onReorder={onReorder}
          reducedMotion
          forceFallback={false}
          disabled={disabled}
        />
      </div>
    );
    const page = render(renderColumns(['a', 'b', 'c', 'd']));
    const [first, second] = Array.from(page.container.querySelectorAll<HTMLElement>('[data-col]'));
    const instance = sortableMock.MockSortable.instances[0];
    const moved = first.children[0] as HTMLElement;
    sortableMock.MockSortable.active = instance;
    sortableMock.MockSortable.dragged = moved;
    callback<() => void>(instance.options, 'onStart')();
    second.append(moved);
    // Sortable's native path handles dragend on the dragged card.
    moved.addEventListener('dragend', () => {
      callback<(event: SortableEvent) => void>(instance.options, 'onEnd')({
        item: moved, from: first, to: second, oldIndex: 0, newIndex: 2, newDraggableIndex: 2,
      });
      sortableMock.MockSortable.active = null;
      sortableMock.MockSortable.dragged = null;
    }, { once: true });
    // An internal hover/drop target must not turn programmatic cancellation into a save.
    moved.dispatchEvent(new Event('drop', { bubbles: true }));
    cancelActiveSortable('[data-sortable-scope="pinned"]');

    expect(columnIds(first)).toEqual(['a', 'c']);
    expect(columnIds(second)).toEqual(['b', 'd']);
    expect(onReorder).not.toHaveBeenCalled();
    page.rerender(renderColumns(['b', 'a', 'd', 'c'], true));
    expect(columnIds(first)).toEqual(['b', 'd']);
    expect(columnIds(second)).toEqual(['a', 'c']);
  });

  // 用户回归：卡片多列不能在自动排序时提交拖拽。旧测试只区分内外部落点；
  // 最小输入为两列卡片，在 disabled 状态收到内部 drop，再恢复手动拖拽；unit。
  it('rejects reordering while disabled and permits it after re-enabling', () => {
    const onReorder = vi.fn();
    const props = {
      items: ['a', 'b', 'c', 'd'], columns: 2, getId: (id: string) => id,
      onReorder, renderItem: (id: string) => <span>{id}</span>, reducedMotion: true,
      forceFallback: false,
    };
    const page = render(<DraggableCardColumns {...props} disabled />);
    const drop = () => {
      const [first, second] = Array.from(page.container.firstElementChild!.children) as HTMLElement[];
      const instance = sortableMock.MockSortable.instances.at(-2)!;
      sortableMock.MockSortable.active = instance;
      callback<() => void>(instance.options, 'onStart')();
      const moved = first.children[0] as HTMLElement;
      second.append(moved);
      moved.dispatchEvent(new Event('drop', { bubbles: true }));
      callback<(event: SortableEvent) => void>(instance.options, 'onEnd')({
        item: moved, from: first, to: second, oldIndex: 0, newIndex: 2, newDraggableIndex: 2,
      });
      expect(columnIds(first)).toEqual(['a', 'c']);
      expect(columnIds(second)).toEqual(['b', 'd']);
    };
    drop();
    expect(onReorder).not.toHaveBeenCalled();
    page.rerender(<DraggableCardColumns {...props} disabled={false} />);
    drop();
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'd', 'a']);
  });

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
