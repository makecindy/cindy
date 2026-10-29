import { CINDY_MAKE_ENABLED } from '@cindy/maker-shared/cindy-make-feature';

export const SESSION_SOURCES = [
  'desktop',
  'feishu',
  'slack',
  'telegram',
  'x',
  'discord',
  'wechat',
  'dingtalk',
  'wecom',
  'scheduler',
  'learn',
  'review',
  'side-chat',
  'shared',
  'plugin',
  'bot',
  'cindy-make',
  'cindy-make-merge',
] as const;

export type SessionSource = (typeof SESSION_SOURCES)[number];

/**
 * Only sessions whose project directory was explicitly chosen by the user belong in the
 * durable recent-project registry. Keep historical migration 0090's SQL allowlist aligned.
 */
export const RETAINABLE_PROJECT_SESSION_SOURCES = [
  'desktop',
  'plugin',
] as const satisfies readonly SessionSource[];

export type RetainableProjectSessionSource = (typeof RETAINABLE_PROJECT_SESSION_SOURCES)[number];

/** Fail closed for legacy/malformed rows whose source is missing or unknown. */
export function isRetainableProjectSessionSource(
  source: unknown,
): source is RetainableProjectSessionSource {
  return source === 'desktop' || source === 'plugin';
}

/** Internal worker directories are execution inputs, not user project registrations. */
export function isRetainableProjectSession(session: {
  source?: unknown;
  orcaRole?: unknown;
}): boolean {
  return session.orcaRole !== 'worker' && isRetainableProjectSessionSource(session.source);
}

export function isReviewSessionSource(source: unknown): source is 'review' {
  return source === 'review';
}

// desktop sidebar 展示的会话 source 白名单。
// slack: IM 渠道自动建的会话——用户在 Slack 发消息后 desktop 同步可见。
// telegram: 共享 Cindy Telegram bot 派发并在本机执行的会话。
// x: 共享 Cindy X (Twitter) bot 派发并在本机执行的会话。
// discord: IM 渠道自动建的会话——用户在 Discord 发消息后 desktop 同步可见。
// dingtalk: 钉钉机器人私聊与群 lane 自动建的会话。
// feishu: IM 渠道自动建的会话——落侧边栏「对话」分组(workspaceKind='dialogue')。
// (2026-07-06 曾加入后按 Lizi 要求回退;2026-07-16 按 Lizi 要求重新加入,
//  这次带 dialogue 归组,不再以 im-working-dir 聚成假项目组。)
// scheduler / learn: 本机自动化会话,可见可点开看过程。
// review: /review 创建的本机只读独立审查任务。会话本身可读(用量、打开详情),但不进
//         普通任务列表,只能从来源任务的审查卡片打开,见 DESKTOP_TASK_LIST_SESSION_SOURCES。
// side-chat: 主任务附属追问，同样可读并计入用量；只从主任务追问入口打开。
// shared: .xdtshare 导入的分享会话,按 workingDir 归组。
// plugin: 插件经 workspace 槽创建的工作区会话入口(空 draft,用户确认后建;
//         projectGrouping 对零消息的 plugin 会话豁免草稿判定,直接落项目分组)。
// bot: 伙伴任务通过 bot_session_links 区分：routine/channel 进普通任务列表并标归属；
//      canonical/thread/group 保留伙伴入口。不能仅按 source 把所有伙伴任务放入列表。
// cindy-make: /cindy-make 弹窗选择制作个人版后创建的代码任务，工作目录是 Cindy 受管
//      源码。Main 据此注入 cindy_make 工具与任务说明；按 workingDir 归到源码项目分组。
export const DESKTOP_VISIBLE_SESSION_SOURCES: SessionSource[] = [
  'side-chat',
  'desktop',
  'feishu',
  'slack',
  'telegram',
  'x',
  'discord',
  'wechat',
  'dingtalk',
  'wecom',
  'scheduler',
  'learn',
  'review',
  'shared',
  'plugin',
  ...(CINDY_MAKE_ENABLED ? (['cindy-make', 'cindy-make-merge'] as const) : []),
];

/**
 * 普通任务列表(侧栏、手机任务列表、搜索、最近任务、未结束提示)展示的来源。
 * 审查任务和侧边追问从来源任务进入，不进入 IM 选择器或键盘任务目录等普通列表；
 * 用量统计等全量读取口径仍用 DESKTOP_VISIBLE_SESSION_SOURCES。
 */
export const DESKTOP_TASK_LIST_SESSION_SOURCES: SessionSource[] =
  DESKTOP_VISIBLE_SESSION_SOURCES.filter((source) => !isReviewSessionSource(source) && source !== 'side-chat');

export function normalizeSessionSource(source: unknown): SessionSource {
  return source === 'feishu' ||
    source === 'side-chat' ||
    source === 'slack' ||
    source === 'telegram' ||
    source === 'x' ||
    source === 'discord' ||
    source === 'wechat' ||
    source === 'dingtalk' ||
    source === 'wecom' ||
    source === 'scheduler' ||
    source === 'learn' ||
    source === 'review' ||
    source === 'shared' ||
    source === 'plugin' ||
    source === 'bot' ||
    source === 'cindy-make' ||
    source === 'cindy-make-merge'
    ? source
    : 'desktop';
}

/** Standalone teammate work requested in the task list; main chats and private/group threads keep their own entries. */
export function isTeammateTaskSession(session: { source?: unknown; companion?: { role?: unknown } | null }): boolean {
  return session.source === 'bot' && (session.companion?.role === 'routine' || session.companion?.role === 'channel');
}

export function isOrdinaryTaskListSession(session: { source?: unknown; companion?: { role?: unknown } | null }): boolean {
  return session.source !== 'side-chat' && session.source !== 'review'
    && (session.source !== 'bot' || isTeammateTaskSession(session));
}
