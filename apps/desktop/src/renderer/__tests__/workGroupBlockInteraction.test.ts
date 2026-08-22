/**
 * workGroupBlockInteraction.test.ts
 * ---------------------------------------------------------------------------
 * WorkGroupBlock「外层时间线 → 内层动作组 → 直接详情」交互的回归锁定。
 *
 * 旧行为(PR #56):点开「已工作」组时 `expandBlocks(childBlockIds)` 把所有子卡
 * 批量 seed 为展开,内部 thinking / 工具调用一次点击全部摊开。
 * 完成态外组展开后只展开 assistant 文字时间线,动作仍是内层「已工作」;
 * 内层或运行态动作组展开后直接显示 thinking /工具行,不再套第三层摘要卡。
 *
 * 测试环境维持仓库约定的 'node'(vitest.config.ts):不引 jsdom / testing-library,
 * 用静态源码扫描锁定「onToggle 只翻自身状态、不再 seed 子卡」的接线不被回退。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('WorkGroupBlock — 嵌套工作组接线静态扫描', () => {
  const source = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'WorkGroupBlock.tsx'),
    'utf8',
  );
  const chrome = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'activityRowChrome.ts'),
    'utf8',
  );
  const actionRow = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'AgentActionRow.tsx'),
    'utf8',
  );
  const systemCard = readFileSync(
    resolve(__dirname, '..', 'components', 'chat', 'SystemCard.tsx'),
    'utf8',
  );

  it('onToggle 不再批量 seed 后代工作组展开态', () => {
    // 外层 click 只能翻外层自身;内层「已工作」仍由用户单独展开。
    expect(source).not.toMatch(/expandBlocks/);
  });

  it('onToggle 仍翻转组自身的展开态', () => {
    const onToggle = source.slice(source.indexOf('const onToggle'));
    expect(onToggle).toMatch(/setExpanded\(\(v\) => !v\)/);
  });

  it('动作组展开后直接渲染工具行和 thinking 内容', () => {
    expect(source).toMatch(/child\.kind === 'tools'[\s\S]*?<ToolActivityRow/);
    expect(source).toMatch(/child\.kind === 'thinking'[\s\S]*?<ExpandedThinkingRow/);
    expect(source).not.toMatch(/AgentActionsBlock/);
  });

  it('exposes thinking rows as viewport child anchors', () => {
    expect(source).toMatch(
      /function ThinkingActivityRow[\s\S]*data-message-client-id=\{activity\.key\}/,
    );
    expect(source).toMatch(
      /function ExpandedThinkingRow[\s\S]*data-message-client-id=\{message\.clientId\}/,
    );
  });

  it('thinking 行右侧三角与工具行共用同一套槽和 hover 浮起', () => {
    expect(chrome).toMatch(/group-hover:bg-\[var\(--cmd-palette-item-hover\)\]/);
    expect(chrome).toMatch(/hover:bg-\[var\(--msg-code-inline-bg\)\]/);
    expect(chrome).toMatch(/h-\[18px\] w-\[18px\]/);
    expect(chrome).toMatch(/ACTIVITY_ROW_RADIUS_CLASS = 'rounded-\[8px\]'/);
    expect(chrome).toMatch(/rounded-\[8px\]/);
    expect(chrome).toMatch(/duration-\[var\(--motion-fast,150ms\)\]/);
    expect(chrome).toMatch(/ease-\[var\(--motion-ease-out\)\]/);
    expect(chrome).not.toMatch(/rounded-lg/);
    expect(chrome).not.toMatch(/var\(--radius\)/);
    expect(chrome).not.toMatch(/rounded-\[4px\]/);
    expect(source).toMatch(/from '\.\/activityRowChrome'/);
    expect(source).toMatch(/ACTIVITY_ROW_CHEVRON_SLOT_CLASS/);
    expect(source).toMatch(/ACTIVITY_ROW_HOVER_SURFACE_CLASS/);
    expect(source).toMatch(/ACTIVITY_ROW_RADIUS_CLASS/);
    expect(source).toMatch(/ACTIVITY_ROW_COLOR_TRANSITION_CLASS/);
    expect(source).not.toMatch(/function ThinkingActivityRow[\s\S]*rounded-\[6px\]/);
    expect(actionRow).toMatch(/from '\.\/activityRowChrome'/);
    expect(actionRow).toMatch(/ACTIVITY_ROW_CHEVRON_SLOT_CLASS/);
    expect(actionRow).toMatch(/ACTIVITY_ROW_RADIUS_CLASS/);
    expect(actionRow).toMatch(/ACTIVITY_ROW_COLOR_TRANSITION_CLASS/);
    expect(systemCard).toMatch(/ACTIVITY_ROW_CHEVRON_SLOT_CLASS/);
    // 槽位始终占位;只有可展开时才画三角。旧写法把整个 span 按 canExpand 卸掉,
    // 短思考行 / 仅有 outcome 的中断行会比工具行更靠右。
    expect(source).not.toMatch(
      /\{canExpand && \(\s*<span aria-hidden="true" className="inline-flex h-\[18px\]/,
    );
    expect(systemCard).not.toMatch(
      /\{canExpand && \(\s*<span aria-hidden="true" className=\{ACTIVITY_ROW_CHEVRON_SLOT_CLASS\}/,
    );
  });

  it('完成态内层工作组递归复用 WorkGroupBlock', () => {
    expect(source).toMatch(/child\.kind === 'group'[\s\S]*?<WorkGroupBlock/);
  });
});
