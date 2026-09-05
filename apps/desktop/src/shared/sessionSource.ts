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
  'shared',
  'plugin',
  'bot',
] as const;

export type SessionSource = (typeof SESSION_SOURCES)[number];

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
// review: /review 创建的本机只读独立审查任务,可从来源卡片或侧边栏打开。
// shared: .xdtshare 导入的分享会话,按 workingDir 归组。
// plugin: 插件经 workspace 槽创建的工作区会话入口(空 draft,用户确认后建;
//         projectGrouping 对零消息的 plugin 会话豁免草稿判定,直接落项目分组)。
// bot: 伙伴的任务(主对话 / 渠道 / 历史)。由 Bots 面板投影，不散进普通任务列表；
//      任务本身仍是 Cindy 的真实 Session，隐藏的是普通列表投影，不是运行时能力。
export const DESKTOP_VISIBLE_SESSION_SOURCES: SessionSource[] = [
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
];

export function normalizeSessionSource(source: unknown): SessionSource {
  return source === 'feishu' ||
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
    source === 'bot'
    ? source
    : 'desktop';
}
