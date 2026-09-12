// @vitest-environment jsdom
/**
 * ChatVideoView.test.ts — 视频预览键盘交互契约。
 *
 * 与 chatImageView.test.ts 的图片键盘用例对位,但不 mock VideoLightbox:
 * 真实组件的 onClose 排在 200ms fade-out 的 setTimeout 之后(见
 * VideoLightbox.handleClose),同步调用 onClose 的 mock 覆盖不到这条时序。
 * 用例覆盖:键盘打开、焦点进入 lightbox(FocusScope)并圈禁 Tab、Esc 延迟
 * 关闭后焦点回到预览触发器——锁住整条无障碍路径,防止弹窗关闭时序或触发
 * 器挂载逻辑调整时静默退化。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

vi.mock('@/hooks/useRemoteMediaUrl', () => ({
  useRemoteMediaUrl: (url: string) => url,
}));

import { ChatVideoView } from '../components/chat/ChatVideoView';
import { __resetMediaBusForTests } from '@/lib/mediaPlaybackBus';

describe('ChatVideoView 键盘交互(真实 VideoLightbox)', () => {
  afterEach(() => {
    // VideoLightbox 的 effect cleanup 会自行注销媒体元素,这里兜底清空
    // 互斥总线,避免用例中途失败时把注册表泄漏给同 worker 的后续用例。
    __resetMediaBusForTests();
  });

  it.each(['Enter', ' '])('键盘 %s 打开视频预览:焦点进入 lightbox 并圈禁,Esc 延迟关闭后回到触发器', async (key) => {
    render(
      React.createElement(ChatVideoView, {
        src: 'xdt-video://control/clip.mp4',
        filename: 'clip.mp4',
        variant: 'tool-output',
      }),
    );
    const trigger = screen.getByRole('button', { name: 'clip.mp4' });
    trigger.focus();

    // 键盘路径:Enter/Space → currentTarget.click() → VideoLightbox。
    fireEvent.keyDown(trigger, { key });
    // 真实 VideoLightbox 经 portal 渲染到 document.body:backdrop 关闭按钮
    // 在场,且带 controls 的大图 <video> 挂的是同一个 src。
    const backdrop = screen.getByRole('button', { name: 'chat.lightbox.close' });
    const lightboxVideo = document.body.querySelector('video[controls]');
    expect(lightboxVideo).not.toBeNull();
    const videoEl = lightboxVideo as HTMLVideoElement;
    expect(videoEl.getAttribute('src')).toBe('xdt-video://control/clip.mp4');

    // 焦点进入 lightbox:打开后 FocusScope 把焦点给 <video>(Space 暂停 /
    // 方向键 seek 立即可用),不再留在被遮罩挡住的预览触发器上。
    expect(document.activeElement).toBe(videoEl);
    expect(document.activeElement).not.toBe(trigger);

    // Tab 圈禁:焦点在 lightbox 内首尾循环(overlay DOM 顺序 backdrop 在前、
    // video 在后),不漏到背后的聊天控件。
    fireEvent.keyDown(videoEl, { key: 'Tab' });
    expect(document.activeElement).toBe(backdrop);
    fireEvent.keyDown(backdrop, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(videoEl);

    // Esc 关闭(onClose 排在 200ms 渐隐后,此刻焦点仍在 lightbox 内——同步
    // onClose 的 mock 走不到这一步)。
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).not.toBe(trigger);

    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // 关闭完成后 lightbox 卸载,预览触发器仍在原位。
    expect(screen.queryByRole('button', { name: 'chat.lightbox.close' })).toBeNull();
    expect(screen.getByRole('button', { name: 'clip.mp4' })).toBeTruthy();
  });
});
