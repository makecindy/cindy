/**
 * 历史窗口空洞的判定阈值 —— 桌面与手机共用的单一来源。
 *
 * 消费方:
 *  - 桌面 `apps/desktop/src/renderer/lib/historyGap.ts`(re-export)→ `MessageStream`
 *    按它切 tool_segment、切工作组;
 *  - 手机 `apps/mobile/src/session/historyWindowGap.ts` 按它找窗口空洞并触发补齐;
 *  - 共享渲染 `messageRender.ts` 按它切 tool_group 与工作组(手机侧的分组实现)。
 *
 * 为什么是 30 分钟:分页窗口之间可能隔着大段没加载的历史(缓存旧页 + 最新页拼接、
 * 断连期间漏收 push、补齐失败退回的孤岛窗口)。渲染层看到的是两段"相邻"item,中间的
 * user 行(唯一的 turn 边界)全部缺席,于是跨越空洞的所有动作被折成同一个「已工作 Xs」:
 * 桌面实测出现过一条组吞掉 47 小时、40 条 user 消息;手机端 2026-07-31 实测一条
 * 「已工作 142m 32s」吞掉整场会话的 6 轮对话(会话首段 + 尾段拼接,中间 400 余行未加载)。
 *
 * 单个 turn 内相邻动作(工具调用 / thinking)正常在秒级到分钟级,等长任务最多几十分钟;
 * 真被误切也只是多出一个折叠条,代价远小于把不相干的两段并成一条并谎报时长。
 *
 * 为什么放在 maker-shared:它是一条产品级阈值(多久算"历史不连续"),两端的渲染分组与
 * 手机端的窗口补齐都要按同一把尺子判断,分成两份复制迟早漂移。包内零 React/Electron/Expo
 * 依赖,符合 `docs/dev-rules/architecture-invariants.md` 的依赖方向。
 */
export const HISTORY_GAP_SPLIT_MS = 30 * 60 * 1000;
