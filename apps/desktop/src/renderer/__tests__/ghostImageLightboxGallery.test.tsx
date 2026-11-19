// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { AttachmentCollectionContext } from '@/components/chat/AttachmentCollection';
import { ImageGalleryContext } from '@/components/chat/ImageGalleryContext';
import { ImageLightbox } from '@/components/chat/ImageLightbox';

afterEach(() => {
  cleanup();
});

describe('Ghost card ImageLightbox gallery positioning', () => {
  // 测试价值：用户在任务里逐条发送的图片各只有一张，单条消息的附件集合
  // 不能把翻页锁在该消息内；打开任一张都应能按任务内全部图片切换。
  // Bug/规则依据：附件预览合同要求图片可在集合内直接切换，避免开一张关一张。
  // 现有覆盖缺口：相邻用例只验证重复 src 的定位，未覆盖集合与任务画廊同时存在时
  // 的优先级；最小失败输入 = 集合 2 张、任务画廊 3 张，旧实现显示 1 / 2。
  // tier：unit（组件入口 + 可观察计数）。
  it('pages through the task image gallery instead of the message collection', () => {
    const first = 'xdt-image://gallery/a.png';
    const second = 'xdt-image://gallery/b.png';
    const third = 'xdt-image://gallery/c.png';
    render(
      <ImageGalleryContext.Provider
        value={[{ src: first }, { src: second }, { src: third }]}
      >
        <AttachmentCollectionContext.Provider
          value={[
            { id: 'a', name: 'a.png', source: first, kind: 'image', media: true },
            { id: 'b', name: 'b.png', source: second, kind: 'image', media: true },
          ]}
        >
          <ImageLightbox src={first} enableGallery onClose={vi.fn()} />
        </AttachmentCollectionContext.Provider>
      </ImageGalleryContext.Provider>,
    );

    expect(screen.getByText('1 / 3')).toBeTruthy();
  });

  it('opens the exact duplicate image selected inside a plugin card iframe', () => {
    const repeated = `cindy-media://blobs/${'a'.repeat(64)}.png`;
    render(
      <ImageGalleryContext.Provider
        value={[
          { src: repeated, galleryId: 'ghost-card:first:0' },
          { src: repeated, galleryId: 'ghost-card:second:0' },
        ]}
      >
        <ImageLightbox
          src={repeated}
          galleryId="ghost-card:second:0"
          enableGallery
          onClose={vi.fn()}
        />
      </ImageGalleryContext.Provider>,
    );

    expect(screen.getByText('2 / 2')).toBeTruthy();
  });
});
