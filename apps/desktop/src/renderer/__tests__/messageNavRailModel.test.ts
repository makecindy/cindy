/**
 * messageNavRailModel 纯逻辑单测:条目派生过滤 / 当前提问判定 / 空间与截断规划。
 * 全部 node 环境,无 DOM(组件侧几何测量不在此覆盖,见 MessageNavRail.tsx 注释)。
 */
import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/hooks/useCCAgentChat';
import {
  NAV_RAIL_ACTIVE_FUDGE_PX,
  NAV_RAIL_BACKFILL_MAX_ROUNDS,
  NAV_RAIL_BACKFILL_TARGET_ENTRIES,
  NAV_RAIL_EXCERPT_MAX_CHARS,
  NAV_RAIL_JUMP_TOP_OFFSET_PX,
  NAV_RAIL_MIN_GUTTER_PX,
  NAV_RAIL_TICK_MIN_PITCH_PX,
  NAV_RAIL_TICK_PITCH_PX,
  deriveNavRailEntries,
  hasNavRailRoom,
  normalizeExcerpt,
  pickActiveNavId,
  pickVisibleNavRange,
  planNavRailTicks,
  planNavRailTickWidth,
  planNavRailTickProgress,
  promptPreviewLine,
  shouldBackfillForNavRail,
} from '@/components/chat/messageNavRailModel';
import { forwardNavRailWheel } from '@/components/chat/messageNavRailWheel';

function msg(
  partial: Partial<ChatMessage> & { clientId: string; role: ChatMessage['role'] },
): ChatMessage {
  return { content: '', ...partial } as ChatMessage;
}

describe('deriveNavRailEntries', () => {
  it('只收真实用户提问,跳过 assistant / tool / 合成行 / 系统卡', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'a1', role: 'assistant', content: '回答' }),
      msg({ clientId: 't1', role: 'tool_use', content: '' }),
      msg({ clientId: 'u2', role: 'user', content: '第二问', isSyntheticTrigger: true }),
      msg({ clientId: 'u3', role: 'user', content: '', systemCardType: 'compact' }),
      msg({ clientId: 'u4', role: 'user', content: '第三问\n补充' }),
    ];
    const entries = deriveNavRailEntries(messages);
    expect(entries.map((e) => e.id)).toEqual(['u1', 'u4']);
    expect(entries[1].preview).toBe('第三问');
  });

  it('空输入返回空数组', () => {
    expect(deriveNavRailEntries([])).toEqual([]);
  });

  it('保留自动化来源标记,供导航条用短刻度区分', () => {
    const entries = deriveNavRailEntries([
      msg({ clientId: 'u1', role: 'user', content: '手动提问' }),
      msg({
        clientId: 'u2',
        role: 'user',
        content: '自动提问',
        automationOrigin: { kind: 'scheduler', scheduleId: 'schedule-1' },
      }),
      msg({ clientId: 'u3', role: 'user', content: '普通提问', automationOrigin: undefined }),
    ]);
    expect(entries.map((entry) => entry.isAutomation)).toEqual([false, true, false]);
  });

  it('运行中插话(delivery=steer)不算新一轮,不产生刻度', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 's1', role: 'user', content: '插话:别用这个库', delivery: 'steer' }),
      msg({ clientId: 'a1', role: 'assistant', content: '继续回答第一问' }),
    ];
    const entries = deriveNavRailEntries(messages);
    expect(entries.map((e) => e.id)).toEqual(['u1']);
    // 回答摘要仍归属真实提问,不被插话截走。
    expect(entries[0].answerExcerpt).toBe('继续回答第一问');
  });

  it('无文本也无附件的 user 消息(预览为空)不产生刻度', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '' }),
      msg({ clientId: 'u2', role: 'user', content: '   \n  ' }),
      msg({ clientId: 'u3', role: 'user', content: '真提问' }),
    ];
    expect(deriveNavRailEntries(messages).map((e) => e.id)).toEqual(['u3']);
  });

  it('纯附件提问:预览用顶层 images/files 字段的名字,不丢刻度', () => {
    const messages = [
      msg({
        clientId: 'u1',
        role: 'user',
        content: '',
        files: [{ name: '需求文档.pdf', path: '/tmp/需求文档.pdf' }],
      }),
    ];
    const entries = deriveNavRailEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0].preview).toBe('需求文档.pdf');
  });

  it('纯附件且取不到文件名(粘贴截图):保留刻度,记 attachmentsOnly 数量', () => {
    const messages = [
      msg({
        clientId: 'u1',
        role: 'user',
        content: '',
        images: [{ base64: 'xxxx', mimeType: 'image/png' }],
      }),
    ];
    const entries = deriveNavRailEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0].preview).toBe('');
    expect(entries[0].attachmentsOnly).toBe(1);
  });

  it('回答摘要取该轮最后一条非空 assistant 正文,跳过 thinking / tool 行', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'th1', role: 'thinking', content: '推理过程' }),
      msg({ clientId: 't1', role: 'tool_use', content: '{"cmd":"ls"}' }),
      msg({ clientId: 'a1', role: 'assistant', content: '  我先看下\n项目结构  ' }),
      msg({ clientId: 'a2', role: 'assistant', content: '结论:入口在右键,不在 0 尺寸节点。' }),
      msg({ clientId: 'u2', role: 'user', content: '第二问(流式中,尚无回答)' }),
    ];
    const entries = deriveNavRailEntries(messages);
    expect(entries[0].answerExcerpt).toBe('结论:入口在右键,不在 0 尺寸节点。');
    expect(entries[1].answerExcerpt).toBeUndefined();
  });

  it('开工叙述会被同轮最终回答覆盖', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '这个点不到吧' }),
      msg({
        clientId: 'a1',
        role: 'assistant',
        content: '对，那个 0 尺寸节点不是给人点的，只是拿来锚菜单。我先核对它会不会一打开就被 Radix 关掉。',
      }),
      msg({
        clientId: 'a2',
        role: 'assistant',
        content: '对，那个 0 尺寸节点本身点不到。\n\n它不是入口。入口是定时器按钮的右键。',
      }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe(
      '对，那个 0 尺寸节点本身点不到。 它不是入口。入口是定时器按钮的右键。',
    );
  });

  it('已收尾的最终回答不会被后续开工叙述盖回去', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '这个点不到吧' }),
      msg({
        clientId: 'a1',
        role: 'assistant',
        content: '对，那个 0 尺寸节点本身点不到。入口是定时器按钮的右键。',
        turnCompleted: true,
      }),
      msg({
        clientId: 'a2',
        role: 'assistant',
        content: '我先核对展开态菜单会不会一打开就被关掉。',
      }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe(
      '对，那个 0 尺寸节点本身点不到。入口是定时器按钮的右键。',
    );
  });

  it('同轮后一条收尾正文覆盖前一条收尾正文', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '继续' }),
      msg({ clientId: 'a1', role: 'assistant', content: '先交了 PR。', turnCompleted: true }),
      msg({ clientId: 'a2', role: 'assistant', content: '菜单已经改到组头右键。', turnCompleted: true }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('菜单已经改到组头右键。');
  });

  it('系统卡不占用回答摘要', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'a1', role: 'assistant', content: '真正的回答', turnCompleted: true }),
      msg({
        clientId: 'a2',
        role: 'assistant',
        content: '本轮费用 $0.12',
        systemCardType: 'cost',
      }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('真正的回答');
  });

  it('合成续跑之后的回答不再盖到上一根可见刻度', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '这个点不到吧' }),
      msg({
        clientId: 'a1',
        role: 'assistant',
        content: '对，那个 0 尺寸节点本身点不到。入口是定时器按钮的右键。',
        turnCompleted: true,
      }),
      msg({ clientId: 'syn', role: 'user', content: '继续', isSyntheticTrigger: true }),
      msg({
        clientId: 'a2',
        role: 'assistant',
        content: '续跑后的另一轮结论,不该出现在上一问预览里。',
        turnCompleted: true,
      }),
    ];
    const entries = deriveNavRailEntries(messages);
    expect(entries.map((e) => e.id)).toEqual(['u1']);
    expect(entries[0].answerExcerpt).toBe(
      '对，那个 0 尺寸节点本身点不到。入口是定时器按钮的右键。',
    );
  });

  it('提问之前的 assistant 消息不会挂到任何条目上', () => {
    const messages = [
      msg({ clientId: 'a0', role: 'assistant', content: '开场白' }),
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBeUndefined();
  });

  it('全空白的 assistant 正文不占用摘要名额,等真正非空正文', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'a1', role: 'assistant', content: '   \n  ' }),
      msg({ clientId: 'a2', role: 'assistant', content: '真正的回答' }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('真正的回答');
  });

  it('规范化后为空的尾条不冲掉已有有效摘要', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'a1', role: 'assistant', content: '真正的回答' }),
      msg({ clientId: 'a2', role: 'assistant', content: '<!-- hidden -->\n`**`' }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('真正的回答');
  });

  it('收尾正文规范化为空仍封轮,未收尾进度不能盖掉已有摘要', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({
        clientId: 'a1',
        role: 'assistant',
        content: '真正的回答',
        turnCompleted: true,
      }),
      msg({
        clientId: 'a2',
        role: 'assistant',
        content: '<!-- hidden -->',
        turnCompleted: true,
      }),
      msg({ clientId: 'a3', role: 'assistant', content: '我先核对下一处入口。' }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('真正的回答');
  });

  it('空正文收尾标记仍封轮,未收尾进度不能盖掉已有摘要', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'a1', role: 'assistant', content: '真正的回答' }),
      msg({ clientId: 'a2', role: 'assistant', content: '', turnCompleted: true }),
      msg({ clientId: 'a3', role: 'assistant', content: '我先核对下一处入口。' }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('真正的回答');
  });

  it('封轮后的下一 SDK turn 在再次封轮时提交新摘要', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'a1', role: 'assistant', content: '第一轮结论。', turnCompleted: true }),
      msg({ clientId: 'a2', role: 'assistant', content: '第二轮真正的结论。' }),
      msg({ clientId: 'a3', role: 'assistant', content: '', turnCompleted: true }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('第二轮真正的结论。');
  });

  it('显式失败收尾不能靠费用把进度提交成最终摘要', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '第一问' }),
      msg({ clientId: 'a1', role: 'assistant', content: '成功结论。', turnCompleted: true }),
      msg({
        clientId: 'a2',
        role: 'assistant',
        content: '失败前的进度。',
        turnCompleted: false,
        turnCostUsd: 0.12,
      }),
    ];
    expect(deriveNavRailEntries(messages)[0].answerExcerpt).toBe('成功结论。');
  });

  it('hook 消息(带 userText):预览取干净原文,不取 content 里的 agent prompt', () => {
    const messages = [
      msg({
        clientId: 'u1',
        role: 'user',
        content: '<thread_context>群里的历史消息</thread_context>请根据以上上下文回复用户',
        hookSource: { im: 'feishu', userText: '帮我看下这个报错' },
      }),
    ];
    const entries = deriveNavRailEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0].preview).toBe('帮我看下这个报错');
  });

  it('hook 消息(过渡期,无 userText):预览剥掉 <thread_context> 块', () => {
    const messages = [
      msg({
        clientId: 'u1',
        role: 'user',
        content: '<thread_context>A: 早\nB: 早</thread_context>\n这个 bug 谁修一下',
        hookSource: { im: 'feishu' },
      }),
    ];
    expect(deriveNavRailEntries(messages)[0].preview).toBe('这个 bug 谁修一下');
  });

  it('Orca 通信行:预览取封装内的 content,不裸奔 JSON 原文', () => {
    const messages = [
      msg({
        clientId: 'u1',
        role: 'user',
        content: JSON.stringify({ orcaSource: 'lead', content: '任务:补齐单测覆盖' }),
      }),
    ];
    expect(deriveNavRailEntries(messages)[0].preview).toBe('任务:补齐单测覆盖');
  });

  it('正文恰好是 JSON 字面量的普通提问不受 Orca 解包影响', () => {
    const messages = [
      msg({ clientId: 'u1', role: 'user', content: '{"cmd":"build"}' }),
    ];
    expect(deriveNavRailEntries(messages)[0].preview).toBe('{"cmd":"build"}');
  });

  it('JSON 数组字面量提问不被二次解析,保留刻度与原文预览', () => {
    // store 入库已把 content 归一成可见正文;这里再 parseUserContent 会把
    // 数组当 SDK content blocks 解空、丢刻度(PR #830 review)。
    const messages = [msg({ clientId: 'u1', role: 'user', content: '[1,2,3]' })];
    const entries = deriveNavRailEntries(messages);
    expect(entries).toHaveLength(1);
    expect(entries[0].preview).toBe('[1,2,3]');
  });

  it('带 text 字段的 JSON 对象字面量提问显示原文,不被解成内层字段', () => {
    const content = '{"text":"内层不该被提出来"}';
    const messages = [msg({ clientId: 'u1', role: 'user', content })];
    expect(deriveNavRailEntries(messages)[0].preview).toBe(content);
  });

  it('hook 消息正文中间以 <thread_context> 开头的行不被误剥(^ 只锚串首)', () => {
    const messages = [
      msg({
        clientId: 'u1',
        role: 'user',
        content: '看看这段配置\n<thread_context>foo</thread_context>\n有什么问题',
        hookSource: { im: 'feishu' },
      }),
    ];
    expect(deriveNavRailEntries(messages)[0].preview).toBe('看看这段配置');
  });
});

describe('promptPreviewLine', () => {
  it('composer 引用消息:剥标记行,优先取引用块之外用户自己的话', () => {
    const content = [
      '> <!-- cindy-composer-quote -->',
      '> 被引用的一段回答文字',
      '',
      '这个没必要吧,没必要就不要提了',
    ].join('\n');
    expect(promptPreviewLine(content)).toBe('这个没必要吧,没必要就不要提了');
  });

  it('全引用消息(没有自己的话):退回引用文字本身,去掉引用前缀', () => {
    const content = ['> <!-- cindy-composer-quote -->', '> 被引用的一段回答文字'].join('\n');
    expect(promptPreviewLine(content)).toBe('被引用的一段回答文字');
  });

  it('普通多行提问:取首个非空行', () => {
    expect(promptPreviewLine('\n第一行\n第二行')).toBe('第一行');
  });
});

describe('normalizeExcerpt', () => {
  it('压平换行与连续空白成单行', () => {
    expect(normalizeExcerpt('第一行\n\n  第二行\t结尾 ')).toBe('第一行 第二行 结尾');
  });

  it('剥常见 Markdown 标记:粗体 / 行内代码 / 标题 / 引用 / 列表符 / 链接', () => {
    expect(
      normalizeExcerpt(
        '## 结论\n**触发条件(现状)**:≥ **4 条**提问\n- 用 `onLoadMore` 补页\n> 引用行\n详见 [设计文档](https://example.com/spec)。',
      ),
    ).toBe('结论 触发条件(现状):≥ 4 条提问 用 onLoadMore 补页 引用行 详见 设计文档。');
  });

  it('行首负号数字不是列表符,不剥', () => {
    expect(normalizeExcerpt('-5度 是正文')).toBe('-5度 是正文');
  });

  it('截断到摘要上限', () => {
    expect(normalizeExcerpt('长'.repeat(500))).toHaveLength(NAV_RAIL_EXCERPT_MAX_CHARS);
  });
});

describe('shouldBackfillForNavRail', () => {
  const base = {
    entryCount: 2,
    hasMoreMessages: true,
    isLoadingMore: false,
    rounds: 0,
  };

  it('提问不足且还有历史、不在加载中、预算未用完 → 补页', () => {
    expect(shouldBackfillForNavRail(base)).toBe(true);
  });

  it('提问已达标 → 不补', () => {
    expect(
      shouldBackfillForNavRail({ ...base, entryCount: NAV_RAIL_BACKFILL_TARGET_ENTRIES }),
    ).toBe(false);
  });

  it('历史已翻到头 → 不补', () => {
    expect(shouldBackfillForNavRail({ ...base, hasMoreMessages: false })).toBe(false);
  });

  it('正在加载中 → 等这轮落地再说', () => {
    expect(shouldBackfillForNavRail({ ...base, isLoadingMore: true })).toBe(false);
  });

  it('轮数预算用完 → 到此为止,剩下的随用户上滚补齐', () => {
    expect(shouldBackfillForNavRail({ ...base, rounds: NAV_RAIL_BACKFILL_MAX_ROUNDS })).toBe(false);
  });
});

describe('跳转落点与当前项阈值的约束关系', () => {
  it('阈值必须大于落点偏移 — 跳转落定后目标自身即成为当前项', () => {
    expect(NAV_RAIL_ACTIVE_FUDGE_PX).toBeGreaterThan(NAV_RAIL_JUMP_TOP_OFFSET_PX);
  });
});

describe('pickActiveNavId', () => {
  const ids = ['u1', 'u2', 'u3', 'u4'];

  it('取最后一条顶边已越过阈值线的提问', () => {
    // 阈值 100:u1/u2 已滚出(顶边在阈值上方),u3/u4 还在下方。
    const tops = [-500, 40, 300, 900];
    expect(pickActiveNavId(ids, 100, (i) => tops[i])).toBe('u2');
  });

  it('未挂载(渲染窗口外)视作已越过阈值', () => {
    // u3 未挂载 → 它必然在视口上方,当前项就是 u3(u4 还在视口下方)。
    const tops: Array<number | null> = [null, null, null, 900];
    expect(pickActiveNavId(ids, 100, (i) => tops[i])).toBe('u3');
  });

  it('全部都在阈值线之下(视口在对话最顶端)时当前项为第一条', () => {
    const tops = [150, 400, 800, 1200];
    expect(pickActiveNavId(ids, 100, (i) => tops[i])).toBe('u1');
  });

  it('恰好压线(等于阈值)算已越过 — 跳转落定后目标自身即当前项', () => {
    const tops = [-200, 100, 500, 900];
    expect(pickActiveNavId(ids, 100, (i) => tops[i])).toBe('u2');
  });

  it('空列表返回 null', () => {
    expect(pickActiveNavId([], 100, () => null)).toBeNull();
  });

  it('二分查找:千级条目单次判定只测 O(log n) 个锚点', () => {
    // 每次 topAt = querySelector + getBoundingClientRect(强制布局读),
    // 且在 rAF 里逐帧调用 — 访问次数必须是对数级(PR #830 review)。
    const n = 1024;
    const bigIds = Array.from({ length: n }, (_, i) => `u${i}`);
    let touched = 0;
    const active = pickActiveNavId(bigIds, 100, (i) => {
      touched += 1;
      return i * 100;
    });
    expect(active).toBe('u1'); // 顶边 100 恰好压线
    expect(touched).toBeLessThanOrEqual(Math.ceil(Math.log2(n)) + 2);
  });
});

describe('pickVisibleNavRange', () => {
  const ids = ['u1', 'u2', 'u3', 'u4'];
  const rangeOf = (tops: Array<number | null>, viewTop: number, viewBottom: number) =>
    pickVisibleNavRange(ids, viewTop, viewBottom, (i) => tops[i]);

  it('视口横跨两轮:两轮都在范围里', () => {
    // 轮次区间:u1=[-500,-100) u2=[-100,200) u3=[200,900) u4=[900,∞)
    expect(rangeOf([-500, -100, 200, 900], 0, 700)).toEqual({ startIndex: 1, endIndex: 2 });
  });

  it('视口整体落在单轮内部:范围收敛为这一轮', () => {
    expect(rangeOf([-500, -100, 900, 1500], 0, 700)).toEqual({ startIndex: 1, endIndex: 1 });
  });

  it('贴底阅读最后一轮:范围 = 最后一条', () => {
    expect(rangeOf([-900, -600, -300, -50], 0, 700)).toEqual({ startIndex: 3, endIndex: 3 });
  });

  it('未挂载(渲染窗口外)的轮次内容在视口上方,其自身可跨进视口', () => {
    // u1/u2 未挂载;u3 顶边 400 → u2 的轮次 [-∞,400) 与视口相交。
    expect(rangeOf([null, null, 400, 900], 0, 700)).toEqual({ startIndex: 1, endIndex: 2 });
  });

  it('视口在第一条提问之前:返回 null(还没有任何轮次开始)', () => {
    expect(rangeOf([500, 900, 1300, 1700], 0, 400)).toBeNull();
  });

  it('回归:视口顶只剩上一轮的空白余量(调用方已按容差抬高顶边)→ 上一轮不亮', () => {
    // 实拍缺陷(2026-07-28):当前轮顶边在视口顶下方 ~30px,那 30px 全是
    // 消息间距/落点偏移的空白,上一轮却被点亮。调用方把顶边抬高
    // NAV_RAIL_ACTIVE_FUDGE_PX(40) 后,30 < 40 → 上一轮出局。
    const tops = [-800, -300, 30, 900];
    expect(rangeOf(tops, 0 + NAV_RAIL_ACTIVE_FUDGE_PX, 700)).toEqual({
      startIndex: 2,
      endIndex: 2,
    });
    // 反例:当前轮顶边压过阈值线(60 > 40),上一轮的正文确实还在屏上 → 亮。
    const tops2 = [-800, -300, 60, 900];
    expect(rangeOf(tops2, 0 + NAV_RAIL_ACTIVE_FUDGE_PX, 700)).toEqual({
      startIndex: 1,
      endIndex: 2,
    });
  });

  it('空列表返回 null', () => {
    expect(pickVisibleNavRange([], 0, 700, () => null)).toBeNull();
  });
});

describe('planNavRailTicks', () => {
  it('空间充裕:标准纵距,全量展示', () => {
    const plan = planNavRailTicks(10, 10 * NAV_RAIL_TICK_PITCH_PX);
    expect(plan).toEqual({ startIndex: 0, pitchPx: NAV_RAIL_TICK_PITCH_PX, hiddenCount: 0 });
  });

  it('略挤:压缩纵距但不截断', () => {
    const plan = planNavRailTicks(20, 20 * 7);
    expect(plan.startIndex).toBe(0);
    expect(plan.hiddenCount).toBe(0);
    expect(plan.pitchPx).toBe(7);
    expect(plan.pitchPx).toBeGreaterThanOrEqual(NAV_RAIL_TICK_MIN_PITCH_PX);
  });

  it('最小纵距也放不下:截掉最早的一段,预留占位刻度', () => {
    const availableHeight = 100; // 最小纵距 5px → 20 格,留 1 格占位 → 展示 19 条
    const plan = planNavRailTicks(50, availableHeight);
    expect(plan.pitchPx).toBe(NAV_RAIL_TICK_MIN_PITCH_PX);
    expect(plan.hiddenCount).toBe(50 - 19);
    expect(plan.startIndex).toBe(plan.hiddenCount);
    // 展示条数 + 占位 1 格不超过可用空间
    expect((50 - plan.startIndex + 1) * plan.pitchPx).toBeLessThanOrEqual(availableHeight);
  });

  it('零条目 / 零空间不炸', () => {
    expect(planNavRailTicks(0, 500).hiddenCount).toBe(0);
    expect(planNavRailTicks(10, 0).hiddenCount).toBe(0);
  });
});

describe('planNavRailTickWidth', () => {
  it('以 hover/scrub 目标为中心逐级伸缩三根刻度', () => {
    expect(planNavRailTickWidth({ distance: 0, isActive: false, inView: false })).toBe('w-[26px]');
    expect(planNavRailTickWidth({ distance: 1, isActive: false, inView: false })).toBe('w-[26px]');
    expect(planNavRailTickWidth({ distance: 2, isActive: false, inView: false })).toBe('w-[26px]');
    expect(planNavRailTickWidth({ distance: null, isActive: true, inView: true })).toBe('w-[26px]');
  });

  it('自动化刻度保持更短的层级', () => {
    expect(planNavRailTickWidth({ distance: null, isActive: false, inView: false, isAutomation: true })).toBe('w-[26px]');
  });

  it('交互进度按目标及邻居距离衰减', () => {
    expect([null, 0, 1, 2, 3, 4].map(planNavRailTickProgress)).toEqual([0, 1, 0.7, 0.4, 0.2, 0]);
  });
});

describe('hasNavRailRoom', () => {
  it('内容列两侧留白足够才有空间', () => {
    // 容器 880 + 两侧各 44 = 968 恰好够
    expect(hasNavRailRoom(880 + NAV_RAIL_MIN_GUTTER_PX * 2, 880)).toBe(true);
    expect(hasNavRailRoom(880 + NAV_RAIL_MIN_GUTTER_PX * 2 - 1, 880)).toBe(false);
  });

  it('容器比内容列 maxWidth 还窄(嵌入面板)时没有空间', () => {
    expect(hasNavRailRoom(600, 880)).toBe(false);
    expect(hasNavRailRoom(0, 880)).toBe(false);
  });
});

describe('forwardNavRailWheel', () => {
  it('把 wheel 增量原样转发给滚动容器(横竖两轴)', () => {
    const calls: ScrollToOptions[] = [];
    forwardNavRailWheel({ scrollBy: (options) => calls.push(options) }, { deltaX: 3, deltaY: -120 });
    expect(calls).toEqual([{ left: 3, top: -120 }]);
  });

  it('滚动容器缺席(卸载竞态)时静默不抛', () => {
    expect(() => forwardNavRailWheel(null, { deltaX: 0, deltaY: 10 })).not.toThrow();
  });
});
