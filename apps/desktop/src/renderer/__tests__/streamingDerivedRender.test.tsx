// @vitest-environment jsdom
import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { memo, useContext, useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectSessionImageSrcs } from '@/components/chat/MessageStream';
import { ImageGalleryContext } from '@/components/chat/ImageGalleryContext';
import { createRenderItemMetadataProjection } from '@/components/chat/streamingMessageProjection';
import { usePrevUserMessageInView } from '@/components/chat/usePrevUserMessageInView';
import type { RenderItem } from '@/components/chat/messageWorkGroups';
import type { GhostCardSnapshot } from '@/cindy-brain/ghostCardStore';
import type { RemoteMediaOrigin } from '../../shared/remoteMediaUrl';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function fixture(): RenderItem[] {
  return [
    {
      type: 'message',
      key: 'u',
      message: {
        clientId: 'u',
        role: 'user',
        content: 'Question',
        images: [{ url: `cindy-media://blobs/${'1'.repeat(64)}.png`, mimeType: 'image/png', originalName: '' }],
      },
    },
    {
      type: 'message',
      key: 'a',
      message: { clientId: 'a', role: 'assistant', content: 'Answer', isStreaming: true },
    },
  ];
}
function update(rows: RenderItem[]): RenderItem[] {
  const tail = rows.at(-1)!;
  if (tail.type !== 'message') throw new Error('Expected message');
  return [
    ...rows.slice(0, -1),
    { ...tail, message: { ...tail.message, content: tail.message.content + ' next' } },
  ];
}

describe('derived consumers during a text stream', () => {
  it.each([false, true])(
    'gallery context broadcasts only membership changes (reuse=%s)',
    (reuse) => {
      const collect = vi.fn(collectSessionImageSrcs);
      const consume = vi.fn();
      const Consumer = memo(function Consumer() {
        const images = useContext(ImageGalleryContext);
        consume(images);
        return <div data-testid="images">{images?.map((image) => image.src).join('|')}</div>;
      });
      function View({
        items,
        origin,
        cards,
        streaming = true,
      }: {
        items: RenderItem[];
        origin?: RemoteMediaOrigin;
        cards?: GhostCardSnapshot;
        streaming?: boolean;
      }) {
        const project = useMemo(createRenderItemMetadataProjection, []);
        const metadata = reuse ? project(items) : items;
        const images = useMemo(
          () => collect(metadata, origin, cards, streaming),
          [metadata, origin, cards, streaming],
        );
        return (
          <ImageGalleryContext.Provider value={images}>
            <Consumer />
          </ImageGalleryContext.Provider>
        );
      }
      let items = fixture();
      const view = render(<View items={items} />);
      for (let frame = 0; frame < 40; frame++) {
        items = update(items);
        view.rerender(<View items={items} />);
      }
      expect(collect).toHaveBeenCalledTimes(reuse ? 1 : 41);
      expect(consume).toHaveBeenCalledTimes(reuse ? 1 : 41);
      const origin: RemoteMediaOrigin = { kind: 'device', deviceId: 'other-device' };
      view.rerender(<View items={items} origin={origin} />);
      expect(screen.getByTestId('images').textContent).toContain('cindy-remote-media://');
      const cards: GhostCardSnapshot = {
        version: 1,
        liveCards: [],
        byCallId: new Map([
          [
            'a',
            {
              status: 'ready',
              ghostId: 'art',
              height: 100,
              html: `<img src="cindy-media://blobs/${'2'.repeat(64)}.png">`,
            },
          ],
        ]),
      };
      view.rerender(<View items={items} origin={origin} cards={cards} />);
      expect(screen.getByTestId('images').textContent?.split('|')).toHaveLength(2);
      expect(consume.mock.calls.at(-1)?.[0]?.[1].galleryId).toBe('ghost-card:a:0');
      const count = collect.mock.calls.length;
      view.rerender(<View items={items} origin={origin} cards={cards} streaming={false} />);
      expect(collect).toHaveBeenCalledTimes(count + 1);
      view.rerender(<View items={[]} />);
      expect(screen.getByTestId('images').textContent).toBe('');
    },
  );

  it.each([false, true])(
    'previous-question hook avoids redundant geometry requests (reuse=%s)',
    (reuse) => {
      const frames = new Map<number, FrameRequestCallback>();
      let nextId = 0;
      const raf = vi.fn((callback: FrameRequestCallback) => {
        frames.set(++nextId, callback);
        return nextId;
      });
      vi.stubGlobal('requestAnimationFrame', raf);
      vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          disconnect() {}
        },
      );
      vi.stubGlobal('CSS', { escape: (id: string) => id });
      const flush = () =>
        act(() => {
          const pending = [...frames.values()];
          frames.clear();
          pending.forEach((callback) => callback(0));
        });
      const scrollRef = { current: document.createElement('div') };
      let items = fixture();
      const hook = renderHook(
        ({ rows }: { rows: RenderItem[] }) => {
          const project = useMemo(createRenderItemMetadataProjection, []);
          const metadata = reuse ? project(rows) : rows;
          const userMessageIds = useMemo(
            () =>
              metadata.flatMap((item) =>
                item.type === 'message' &&
                item.message.role === 'user' &&
                !item.message.isSyntheticTrigger
                  ? [item.message.clientId]
                  : [],
              ),
            [metadata],
          );
          return usePrevUserMessageInView({ scrollRef, userMessageIds });
        },
        { initialProps: { rows: items } },
      );
      flush();
      raf.mockClear();
      for (let frame = 0; frame < 40; frame++) {
        items = update(items);
        hook.rerender({ rows: items });
        flush();
      }
      expect(raf).toHaveBeenCalledTimes(reuse ? 0 : 40);
      hook.rerender({ rows: items.slice(1) });
      expect(raf).toHaveBeenCalledTimes(reuse ? 1 : 41);
      flush();
    },
  );
});
