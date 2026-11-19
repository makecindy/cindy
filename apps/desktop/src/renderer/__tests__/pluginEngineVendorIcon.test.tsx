// @vitest-environment jsdom
/**
 * 插件引擎任务的身份图标用侧栏的状态色(2026-11-19 用户反馈：没在运行时仍是插件声明的蓝色鲸鱼)。
 *
 * 测试价值
 * - 生产入口与可观察结果：VendorIcon(vendor 'acp')——侧栏 SessionStatusIcon 与中断任务对话框共用；
 *   看画出来的是剪影(currentColor 填充)还是灰度图，以及外层的空闲 / 运行色。
 * - 规则依据：VendorIcon 头注的状态色(空闲 Stone 灰、运行 Thinking Orange)与 DESIGN.md 的灰阶规则；
 *   插件品牌色不进任务身份图标。
 * - 现有覆盖缺口：PluginEnginesSection.test 只看图标地址，不看颜色；没有测试覆盖插件图标的状态色。
 * - 最小失败输入：透明底图标仍按原图(品牌色)渲染；整块不透明图标被做成实心剪影；运行时不是橙色。
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

  it('fills a silhouette with the row colour: grey when idle, Thinking Orange while running', () => {
    const whale = 'data:image/png;base64,whale';
    rememberPluginIconSilhouetteForTests(whale, true);
    const idle = render(<VendorIcon vendor="acp" iconDataUrl={whale} />).container;
    const mark = idle.querySelector<HTMLElement>('[data-plugin-icon="silhouette"]')!;
    expect(mark.style.backgroundColor).toBe('currentcolor');
    expect(mark.style.maskImage).toContain(whale);
    expect(idle.querySelector('img')).toBeNull();
    expect(idle.firstElementChild!.className).toContain('text-[hsl(var(--sidebar-muted))]');

    const running = render(<VendorIcon vendor="acp" iconDataUrl={whale} running />).container;
    expect(running.firstElementChild!.className).toContain('text-[var(--warning-accent)]');
    expect(running.querySelector('[data-plugin-icon="silhouette"]')).not.toBeNull();
  });

  it('shows an opaque icon, or one not measured yet, in greyscale instead of its brand colours', () => {
    const tile = 'data:image/png;base64,tile';
    rememberPluginIconSilhouetteForTests(tile, false);
    for (const url of [tile, 'data:image/png;base64,unmeasured']) {
      const image = render(<VendorIcon vendor="acp" iconDataUrl={url} />).container.querySelector('img')!;
      expect(image.getAttribute('data-plugin-icon')).toBe('greyscale');
      expect(image.className).toContain('grayscale');
      cleanup();
    }
  });
});
