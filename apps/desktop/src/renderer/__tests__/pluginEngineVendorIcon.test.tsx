// @vitest-environment jsdom
/**
 * 插件引擎任务的身份图标：运行闪烁时保留插件自身配色，仅非运行时显示灰色
 * (2026-11-19 用户反馈：空闲时不能保留蓝色鲸鱼；后续补充：运行闪烁时应保留插件自身颜色)。
 *
 * 测试价值
 * - 生产入口与可观察结果：VendorIcon(vendor 'acp')——侧栏 SessionStatusIcon 与中断任务对话框共用；
 *   看空闲时是剪影(currentColor 填充)/灰度图，运行时是带呼吸动画的原色图标(无插件图标则回落
 *   Thinking Orange 拼图)。
 * - 规则依据：VendorIcon 头注的插件引擎状态色规则(2026-11-19 用户裁决)与 DESIGN.md 的灰阶规则。
 * - 现有覆盖缺口：PluginEnginesSection.test 只看图标地址，不看运行/空闲状态色切换。
 * - 最小失败输入：空闲透明底图标仍按原图渲染；空闲不透明图标做成实心剪影；运行中的插件图标被染成
 *   橙色剪影或灰度图，丢失自身颜色。
 * - tier：unit(jsdom 不能解码图片，测量结果用测试入口登记；判定函数用合成像素)。
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { VendorIcon } from '@/components/sidebar/VendorIcon';
import { isSilhouetteIcon, rememberPluginIconSilhouetteForTests } from '@/components/icons/pluginIconSilhouette';

afterEach(cleanup);

/** 4×4 RGBA pixels from an alpha map (row by row). */
const pixels = (alpha: number[]) => alpha.flatMap((value) => [77, 107, 254, value]);

describe('plugin engine identity icon', () => {
  it('uses a shape on a clear background as a silhouette, never an opaque or rounded-square icon', () => {
    // The DeepSeek whale measures 68 % clear / 31 % solid.
    expect(isSilhouetteIcon(pixels([0, 0, 0, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 0, 0]))).toBe(true);
    expect(isSilhouetteIcon(pixels(Array(16).fill(255)))).toBe(false);
    // Clear only in the four corners: an app tile, which would become a grey block.
    expect(isSilhouetteIcon(pixels([0, 255, 255, 0, 255, 255, 255, 255, 255, 255, 255, 255, 0, 255, 255, 0]))).toBe(false);
    expect(isSilhouetteIcon(pixels(Array(16).fill(0)))).toBe(false);
  });

  it('renders a grey silhouette when idle and keeps its own colours while running and breathing', () => {
    const whale = 'data:image/png;base64,whale';
    rememberPluginIconSilhouetteForTests(whale, true);
    const idle = render(<VendorIcon vendor="acp" iconDataUrl={whale} />).container;
    const mark = idle.querySelector<HTMLElement>('[data-plugin-icon="silhouette"]')!;
    expect(mark.style.backgroundColor).toBe('currentcolor');
    expect(mark.style.maskImage).toContain(whale);
    expect(idle.querySelector('img')).toBeNull();
    expect(idle.firstElementChild!.className).toContain('text-[hsl(var(--sidebar-muted))]');

    const running = render(<VendorIcon vendor="acp" iconDataUrl={whale} running />).container;
    const runningImg = running.querySelector<HTMLImageElement>('img[data-plugin-icon="original"]')!;
    expect(runningImg.getAttribute('src')).toBe(whale);
    expect(runningImg.className).not.toContain('grayscale');
    expect(running.querySelector('[data-plugin-icon="silhouette"]')).toBeNull();
    expect(running.firstElementChild!.className).toContain('session-status-breathing');
  });

  it('shows an opaque or unmeasured icon in greyscale when idle, and in its own colours while running', () => {
    const tile = 'data:image/png;base64,tile';
    rememberPluginIconSilhouetteForTests(tile, false);
    for (const url of [tile, 'data:image/png;base64,unmeasured']) {
      const idleImage = render(<VendorIcon vendor="acp" iconDataUrl={url} />).container.querySelector('img')!;
      expect(idleImage.getAttribute('data-plugin-icon')).toBe('greyscale');
      expect(idleImage.className).toContain('grayscale');
      cleanup();

      const running = render(<VendorIcon vendor="acp" iconDataUrl={url} running />).container;
      const runningImage = running.querySelector<HTMLImageElement>('img[data-plugin-icon="original"]')!;
      expect(runningImage.getAttribute('src')).toBe(url);
      expect(runningImage.className).not.toContain('grayscale');
      expect(running.firstElementChild!.className).toContain('session-status-breathing');
      cleanup();
    }
  });

  it('keeps Thinking Orange on the generic fallback puzzle while running without a plugin icon', () => {
    const running = render(<VendorIcon vendor="acp" running />).container;
    expect(running.querySelector('svg')).not.toBeNull();
    expect(running.firstElementChild!.className).toContain('text-[var(--warning-accent)]');
    expect(running.firstElementChild!.className).toContain('session-status-breathing');
  });
});
