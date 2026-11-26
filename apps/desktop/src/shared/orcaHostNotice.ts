/**
 * 宿主自己发给 Lead 的通知（不是某个 Worker 的报告）。
 *
 * 正文是写给模型读的协议指令，保持英文；卡片另挂一行本地化摘要，
 * 让用户不必读英文也知道宿主为什么插话，同时不再把宿主冒充成 Worker。
 */
export type OrcaHostNoticeKind = 'dispatch-claim';
