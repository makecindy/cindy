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

  it('完成态内层工作组递归复用 WorkGroupBlock', () => {
    expect(source).toMatch(/child\.kind === 'group'[\s\S]*?<WorkGroupBlock/);
  });
});
