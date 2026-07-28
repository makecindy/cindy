/**
 * 语音词典多设备同步核心(provider 无关、进程无关的纯逻辑)。
 *
 * 词典正本从「每台设备一份本地 JSON」变成「设备间对等收敛的 CRDT 状态」:桌面
 * 之间经 device-link 的 push 帧交换整份状态,relay 只转发不解析,词典内容不经过
 * 任何服务端存储。本包只负责状态与合并;落盘、传输、UI 接线在 desktop 侧。
 *
 * 入口按职责分四层:
 *  - `types` / `hlc` / `text`:状态模型、时间戳、主键归一化
 *  - `merge`:状态合并(幂等 / 可交换 / 可结合)
 *  - `mutate`:本地变更原语(计数增长的唯一入口)
 *  - `materialize`:确定性物化成词典设置三件套
 */

export * from './types';
export * from './hlc';
export * from './text';
export * from './merge';
export * from './mutate';
export * from './materialize';
export * from './reconcile';
