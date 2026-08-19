/**
 * Regression coverage for the Cindy-assisted Plugin creation draft.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const zhCommon = JSON.parse(
  readFileSync(
    resolve(__dirname, '..', '..', '..', 'i18n', 'locales', 'zh-CN', 'common.json'),
    'utf8',
  ),
) as {
  settings: { ghosts: { page: { createPrompt: string } } };
};

describe('Ghost Plugin creation prompt', () => {
  it('reads the forge guide before designing, packing, and installing', () => {
    const prompt = zhCommon.settings.ghosts.page.createPrompt;

    expect(prompt).toContain('先从提问开始');
    expect(prompt.indexOf('ghost_forge_guide')).toBeGreaterThanOrEqual(0);
    expect(prompt.indexOf('ghost_forge_guide')).toBeLessThan(prompt.indexOf('ghost_forge_pack'));
    expect(prompt).toContain('卡槽总览、沙箱红线与打包流程三章');
    expect(prompt).toContain('打包并安装插件');
  });

  it('asks with option cards and surfaces hidden design choices (guide §0)', () => {
    const prompt = zhCommon.settings.ghosts.page.createPrompt;

    // 与 FORGE_GUIDE §0「设计对齐」呼应:先读该章,再用带选项的提问卡片把
    // 用户想不到的设计选项(面板形态等)摆出来选,而不是开放式追问。
    expect(prompt).toContain('设计对齐');
    expect(prompt).toContain('提问卡片');
    expect(prompt).toContain('推荐项');
    expect(prompt).toContain('停靠面板');
    // 面板收束(2026-08-02):tab 形态住在插件页内,不再是右侧栏页签。
    expect(prompt).toContain('插件页内面板');
    expect(prompt).not.toContain('右侧栏页签');
    // 与 §0 七类"隐藏"设计选项保持同步:后台能力 / 运行形态(node 槽)/ 媒体
    // 能力三类曾长期缺席,导致提问阶段就把这些能力漏掉(2026-08-19 补齐)。
    expect(prompt).toContain('后台能力');
    expect(prompt).toContain('未读角标');
    expect(prompt).toContain('随包 Node 进程');
    expect(prompt).toContain('媒体能力');
    // 必读章节含 §2 卡槽总览:18 个槽的全局视野是"按需读相关章节"的前提。
    expect(prompt).toContain('卡槽总览');
  });
});
