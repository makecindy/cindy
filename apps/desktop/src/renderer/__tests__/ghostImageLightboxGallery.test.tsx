// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
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

  // 测试价值：同一图片地址可能在多条消息重复出现，翻页起点必须是用户点的那一次。
  // 现有覆盖缺口：相邻用例只覆盖重复 src 的插件卡定位，未覆盖普通消息画廊。
  // 最小失败输入 = A、B、A，点击最后一张；旧实现落到 1 / 3 而非 3 / 3。
  it('opens the clicked occurrence of a repeated image', () => {
    const repeated = 'xdt-image://gallery/a.png';
    render(
      <ImageGalleryContext.Provider
        value={[
          { src: repeated, galleryId: 'message:m1:image:0' },
          { src: 'xdt-image://gallery/b.png', galleryId: 'message:m1:image:1' },
          { src: repeated, galleryId: 'message:m2:image:0' },
        ]}
      >
        <ImageLightbox
          src={repeated}
          galleryId="message:m2:image:0"
          enableGallery
          onClose={vi.fn()}
        />
      </ImageGalleryContext.Provider>,
    );

    expect(screen.getByText('3 / 3')).toBeTruthy();
  });

  // 测试价值：任务内翻页后，顶部标题必须跟随当前图片，而不是停在打开时那张。
  // 最小失败输入 = 画廊 A、B，打开 A 后翻到 B；旧实现标题仍显示打开时的文件名。
  it('updates the title when paging through the task gallery', () => {
    const first = 'xdt-image://gallery/first.png';
    const second = 'xdt-image://gallery/second.png';
    render(
      <ImageGalleryContext.Provider
        value={[
          { src: first, name: 'first.png' },
          { src: second, name: 'second.png' },
        ]}
      >
        <ImageLightbox src={first} filename="opened.png" enableGallery onClose={vi.fn()} />
      </ImageGalleryContext.Provider>,
    );

    expect(screen.getByText('opened.png')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.media.nextImage') }));
    expect(screen.getByText('second.png')).toBeTruthy();
  });

  // 测试价值：同一 URL 的多个画廊条目共用 <img>，浏览器不会再次 onLoad；
  // 翻页后尺寸必须保留，否则标注入口和原始尺寸会消失。
  // 最小失败输入 = 两个同 src 条目，首图加载后翻到第二个；旧实现会清掉尺寸。
  it('keeps measured size when paging between entries with the same URL', () => {
    const src = 'xdt-image://gallery/same.png';
    render(
      <ImageGalleryContext.Provider
        value={[
          { src, name: 'first.png' },
          { src, name: 'second.png' },
        ]}
      >
        <ImageLightbox src={src} enableGallery onClose={vi.fn()} />
      </ImageGalleryContext.Provider>,
    );

    const image = document.querySelector('img')!;
    Object.defineProperty(image, 'naturalWidth', { value: 800 });
    Object.defineProperty(image, 'naturalHeight', { value: 600 });
    fireEvent.load(image);
    expect(screen.getByText('800 × 600')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: i18n.t('chat.media.nextImage') }));
    expect(screen.getByText('800 × 600')).toBeTruthy();
  });

  // 测试价值：同一条消息还有 PDF/文件时，图片侧不能跳过同条附件直接走任务图集。
  // 最小失败输入 = 消息集合为图片 + PDF、任务图集 3 张；旧实现显示 1 / 3。
  it('keeps a mixed message collection instead of the task gallery', () => {
    const imageSrc = 'xdt-image://gallery/a.png';
    render(
      <ImageGalleryContext.Provider
        value={[
          { src: imageSrc },
          { src: 'xdt-image://gallery/b.png' },
          { src: 'xdt-image://gallery/c.png' },
        ]}
      >
        <AttachmentCollectionContext.Provider
          value={[
            { id: 'a', name: 'a.png', source: imageSrc, kind: 'image', media: true },
            { id: 'doc', name: 'spec.pdf', source: '/tmp/spec.pdf', kind: 'pdf' },
          ]}
        >
          <ImageLightbox src={imageSrc} enableGallery onClose={vi.fn()} />
        </AttachmentCollectionContext.Provider>
      </ImageGalleryContext.Provider>,
    );

    expect(screen.getByText('1 / 2')).toBeTruthy();
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
