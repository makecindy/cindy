/**
 * 历史窗口空洞的判定阈值 —— 单一来源。
 *
 * 唯一消费方:`components/chat/MessageStream` —— tool_segment 按它切段、工作组按它切组。
 *
 * 为什么单独放在 lib 而不是埋在 MessageStream 里:它是一条产品级阈值(多久算"历史不
 * 连续"),独立成文件便于查找与调整,也留出被 main / 其它 renderer 模块复用的位置而不必
 * 反向依赖 component(见 docs/dev-rules/architecture-invariants.md 的依赖方向)。
 * makerChatStore 一度按它模拟切段来估算跳转补齐预算,现已改为按行数取保守上界
 * (见 JUMP_BACKFILL_MAX_ITEMS),不再依赖本常量。
 *
 * 为什么是 30 分钟:跳转到历史消息时,目标附近的窗口与已加载的尾部窗口之间可能隔着
 * 大段没加载的历史(补齐失败时)。渲染层看到的是两段"相邻"item,中间的 user 行(唯一的
 * turn 边界)全部缺席,于是跨越空洞的所有动作被折成同一个「已工作 Xs」:实测出现过一条
 * 组吞掉 47 小时、40 条 user 消息的会话,组时长也跟着谎报成 2820m。
 *
 * 单个 turn 内相邻动作(工具调用 / thinking)正常在秒级到分钟级,等长任务最多几十分钟;
 * 真被误切也只是多出一个折叠条,代价远小于把不相干的两段并成一条并谎报时长。
 */
export const HISTORY_GAP_SPLIT_MS = 30 * 60 * 1000;
