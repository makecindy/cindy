/**
 * 历史窗口空洞的判定阈值 —— 桌面侧入口,正本在 `@cindy/maker-shared/history-gap`。
 *
 * 桌面消费方:`components/chat/MessageStream` —— tool_segment 按它切段、工作组按它切组。
 * makerChatStore 用同一把尺子识别裁剪后窗口里「孤岛 + 最新连续尾段」的缺口,好把
 * 向上翻页的游标留在尾段下沿(见 oldestMessageOfNewestContiguousRun);跳转补齐预算
 * 本身仍按行数取保守上界(JUMP_BACKFILL_MAX_ITEMS),不按本常量估算。
 *
 * 为什么保留这层 re-export 而不让 MessageStream 直接引 shared:阈值原本是桌面常量,
 * 手机端接入后成为两端共用的产品级阈值(见正本文件头的完整理由)。留住这个路径让桌面侧
 * 既有引用与文档指向不必跟着改,同时保证两端逐字节同一把尺子。
 */
export { HISTORY_GAP_SPLIT_MS } from '@cindy/maker-shared/history-gap';
