import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// 消息列表容器契约:LegendList(替代 FlatList —— 滚动 mount 卡顿的实测解,见 listperf profiling:
// windowSize=21 的大挂载树 p95≈167ms/jank46,换 LegendList 小预渲窗口后 p95≈20ms/jank4)。
// 关键 prop 不可回退:估高 + 小 drawDistance(挂载集小)+ 内置贴底/防跳(替代已删除的手搓 open-settle
// / follow rAF / prepend-settle 锚定机制)。
describe('mobile message list container', () => {
  it('uses LegendList with estimated-size virtualization and built-in chat anchoring', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/session/MessageRenderer.tsx'), 'utf8');

    // 已完全迁出 FlatList:不再出现 FlatList 容器,也不再有其虚拟化专有 prop。
    expect(source).not.toContain('<FlatList');
    expect(source).not.toContain('windowSize={');
    expect(source).not.toContain('getItemLayout={');

    const listStart = source.indexOf('<LegendList');
    expect(listStart).toBeGreaterThan(-1);
    const listSource = source.slice(listStart, source.indexOf('onViewableItemsChanged', listStart));

    // 估高 + 小预渲窗口:挂载集小、mount 帧压进一帧(不可退回大挂载树)。
    expect(listSource).toContain('estimatedItemSize={MOBILE_MESSAGE_ESTIMATED_ITEM_SIZE}');
    expect(listSource).toContain('drawDistance={MOBILE_MESSAGE_DRAW_DISTANCE}');
    // 内置贴底 + prepend 防跳(替代手搓 open-settle / follow rAF / prepend-settle,勿回潮)。
    expect(listSource).toContain('alignItemsAtEnd');
    expect(listSource).toContain('maintainScrollAtEnd');
    expect(listSource).toContain('maintainVisibleContentPosition={{ data: true, size: true }}');
    // cell 含内部 state(展开态 / 手势图 / mermaid·math WebView),关闭回收避免实例错误复用。
    expect(listSource).toContain('recycleItems={false}');
    // 上滑加载:LegendList 近顶阈值触发自动预取(替代手搓的滚动 metric 判定)。
    expect(listSource).toContain('onStartReached={handleStartReached}');
    // 自动预取必须是电平判定(shouldAutoLoadEarlier + 多时机重评估),不许退回只吃 onStartReached
    // 边沿——边沿被业务 guard 吞掉后条件再就绪也等不到下一个边沿(顶部停留永不加载的回归)。
    expect(source).toContain('shouldAutoLoadEarlier({');
    // 冷开允许有限补页,把短初窗上方历史自动补齐；预算耗尽或首项无进展即停止。
    expect(source).toContain('MAX_INITIAL_HISTORY_AUTOFILL_PAGES');
    expect(source).toContain('initialHistoryAutofillRemainingRef.current -= 1');
    // 所有 prepend 在请求期间抑制贴底，成功/空页/失败后延迟一帧释放；generation
    // 防止旧会话请求 settle 后误清新会话 / 新请求状态。
    expect(source).toContain('onLoadEarlier?: () => void | Promise<void>');
    expect(source).toContain('readingOlderRef.current = true');
    expect(source).toContain('Promise.resolve(result).then(releaseReadingOlder, releaseReadingOlder)');
    expect(source).toContain('readingOlderRequestGenerationRef.current === generation');
    // 深链 / 搜索定位本身就是明确的历史浏览意图,后续近顶自动补页无需再拖一下。
    const focusEffectStart = source.indexOf('// 深链/搜索:滚到指定消息');
    const focusEffectEnd = source.indexOf('// 新消息红点', focusEffectStart);
    const focusEffectSource = source.slice(focusEffectStart, focusEffectEnd);
    expect(focusEffectSource).toContain('userScrollForOlderRef.current = true');
    expect(focusEffectSource).toContain('lastAutoLoadEarlierKeyRef.current = null');
  });
});
