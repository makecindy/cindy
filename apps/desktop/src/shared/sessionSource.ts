export const SESSION_SOURCES = [
  'desktop',
  'feishu',
  'slack',
  'telegram',
  'discord',
  'wechat',
  'scheduler',
  'learn',
  'shared',
  'plugin',
] as const;

export type SessionSource = (typeof SESSION_SOURCES)[number];

// desktop sidebar 展示的会话 source 白名单。
// slack: IM 渠道自动建的会话——用户在 Slack 发消息后 desktop 同步可见。
// telegram: 共享 Cindy Telegram bot 派发并在本机执行的会话。
// discord: IM 渠道自动建的会话——用户在 Discord 发消息后 desktop 同步可见。
// feishu: IM 渠道自动建的会话——落侧边栏「对话」分组(workspaceKind='dialogue')。
// (2026-07-06 曾加入后按 Lizi 要求回退;2026-07-16 按 Lizi 要求重新加入,
//  这次带 dialogue 归组,不再以 im-working-dir 聚成假项目组。)
// scheduler / learn: 本机自动化会话,可见可点开看过程。
// shared: .xdtshare 导入的分享会话,按 workingDir 归组。
// plugin: 插件经 workspace 槽创建的工作区会话入口(空 draft,用户确认后建;
//         projectGrouping 对零消息的 plugin 会话豁免草稿判定,直接落项目分组)。
export const DESKTOP_VISIBLE_SESSION_SOURCES: SessionSource[] = [
  'desktop',
  'feishu',
  'slack',
  'telegram',
  'discord',
  'wechat',
  'scheduler',
  'learn',
  'shared',
  'plugin',
];

export function normalizeSessionSource(source: unknown): SessionSource {
  return source === 'feishu' ||
    source === 'slack' ||
    source === 'telegram' ||
    source === 'discord' ||
    source === 'wechat' ||
    source === 'scheduler' ||
    source === 'learn' ||
    source === 'shared' ||
    source === 'plugin'
    ? source
    : 'desktop';
}
