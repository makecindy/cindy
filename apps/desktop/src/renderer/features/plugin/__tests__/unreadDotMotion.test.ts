/**
 * unreadDotMotion.test.ts — 未读呼吸点的常驻动画约束(DESIGN.md §14.4 红线)。
 * ---------------------------------------------------------------------------
 * 未读卡与会话卡不同:插件的未读可能**长期存在、多张同屏**(一页插件卡各亮一颗)。
 * 常驻循环动画因此只允许动 transform / opacity(compositor-only);退回 box-shadow /
 * width 这类会触发每帧重绘的属性,会持续吃 CPU 与电量(codex review)。
 *
 * 这条把「呼吸挂在哪个属性上」钉在样式表里,而不是靠 code review 记住。
 * node 环境(不加 jsdom docblock):要用 import.meta.url 直接读源文件。
 *
 * **读进来先归一化行尾**:仓库只对 .sh / .mjs / hooks / .sql 钉了 LF,.css 没钉,
 * Windows 检出成 CRLF。任何按 `\n` 定位的匹配在那边都会落空——本仓已经因为同一类
 * 问题红过(#1448 的 VoiceInputSection 源码正则)。这类「读源文件做断言」的用例
 * 一律不得对检出行尾敏感。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CSS = readFileSync(
  fileURLToPath(new URL('../../../styles/globals.css', import.meta.url)),
  'utf8',
).replace(/\r\n/g, '\n');

describe('未读呼吸点 · 常驻动画红线', () => {
  it('关键帧只动 transform / opacity,不含任何触发绘制或布局的属性', () => {
    // 用正则整块捕获,不靠 indexOf 数括号:嵌套的 `{}` 与行尾差异都不会把它切歪。
    const block = /@keyframes session-card-pulse\s*\{([\s\S]*?)\n\}/.exec(CSS)?.[1];
    expect(block, '找不到 session-card-pulse 关键帧').toBeTruthy();
    expect(block).toMatch(/transform:/);
    expect(block).toMatch(/opacity:/);
    expect(block).not.toMatch(/box-shadow|width|height|top:|left:|background|filter/);
  });

  it('动画挂在 ::after 光环上(点本体不参与动画)', () => {
    expect(CSS).toMatch(/\.session-card-dot::after\s*\{[^}]*animation:\s*session-card-pulse/);
  });

  it('两处闸门都跟着挂动画的那个元素走 —— 减动偏好停掉、页面隐藏时冻结', () => {
    // 清单按「真正挂动画的那个元素」收敛(见 globals.css 里那段说明),
    // 动画从点本体挪到 ::after 之后,两处选择器也必须跟着挪,否则闸门失效。
    expect(CSS).toMatch(/\.session-card-dot::after,/); // prefers-reduced-motion 清单
    expect(CSS).toMatch(/\[data-app-hidden='true'\] \.session-card-dot::after,/);
  });
});
