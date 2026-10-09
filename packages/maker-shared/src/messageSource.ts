/**
 * 消息来源：界面标签与发给模型的来源说明共用的一份描述。
 *
 * 两个互相独立的维度：
 *  - 谁发的（sender）：任务 / 伙伴 / 插件 / 共享任务成员。自动化、Orca、IM 已有各自的
 *    元数据与说明块，这里只补齐「界面有标签、模型却不知道」的几类。
 *  - 用户在哪台设备上（device）：手机或另一台电脑远程操作被控电脑时由被控端盖章。
 *    被控电脑本机输入不盖章，因此任何设备上都不显示设备标签。
 *
 * 规则（与 docs/dev-rules/maker-core-and-agent-behavior.md §3.1 / §4 一致）：
 *  - 说明只进发给模型的 wire 消息，不进系统提示词、不进落库或排队正文；
 *  - 只写事实，名字一律配 ID（`「名字」(xxx_id: …)`），怎么处理交给模型自己判断；
 *  - 名字来自用户或插件，属于不可信展示文本：去换行、限长，不让它冒充说明结构。
 *  - 这些字段只用于归属展示，**不是**任何权限判据。
 */

export type MessageSourceDevicePlatform = 'mobile' | 'desktop';

/** 被控端在 device-link 入口盖章的控制端设备（agentMeta.sourceDevice）。 */
export interface MessageSourceDevice {
  /** 服务端认证过的控制端设备 id。 */
  deviceId: string;
  /** 发送时的设备名快照；界面优先按 id 取实时名字。 */
  name?: string;
  /** 对端自报的平台，只用于选择「手机 / 电脑」措辞。 */
  platform: MessageSourceDevicePlatform;
}

/** 插件任务派发的消息（agentMeta.sourcePlugin）。 */
export interface MessageSourcePlugin {
  pluginId: string;
  name?: string;
}

/** Host-stamped group source of an explicitly sent private assistant message. */
export interface MessageSourceGroup {
  groupId: string;
  name?: string;
}

export function readMessageSourceGroup(meta: unknown): MessageSourceGroup | undefined {
  const raw = asRecord(asRecord(meta)?.sourceGroup);
  const groupId = raw && readString(raw, 'groupId');
  if (!groupId) return undefined;
  const name = sanitizeSourceName(raw?.name);
  return { groupId, ...(name ? { name } : {}) };
}

export type MessageSourceSender =
  | {
      kind: 'session';
      sessionId?: string;
      title?: string;
      botId?: string;
      botName?: string;
      group?: MessageSourceGroup;
    }
  | { kind: 'plugin'; pluginId: string; name?: string }
  | { kind: 'shared-member'; memberId: string; name?: string };

/** 被控电脑自身的身份，用在设备说明里指明「本机」。 */
export interface MessageSourceHostDevice {
  deviceId?: string;
  name?: string;
}

const MAX_SOURCE_NAME_LENGTH = 80;

/** 不可信名字 → 单行、限长、不含书名号，避免伪造说明结构。 */
export function sanitizeSourceName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = Array.from(value, (ch) => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : ch;
  })
    .join('')
    .replace(/[「」]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > MAX_SOURCE_NAME_LENGTH
    ? `${cleaned.slice(0, MAX_SOURCE_NAME_LENGTH - 1)}…`
    : cleaned;
}

/**
 * 写进**模型文本**的名字：在 sanitizeSourceName 基础上把 ASCII 方括号 / 圆括号换成全角，
 * 名字就无法闭合 `[User · …]`、伪造 `[Silent scheduled run]` 一类标记或冒充 `(xxx_id: …)`。
 * 只用于给模型的说明与交接摘要；界面显示仍用 sanitizeSourceName，保持原名。
 */
export function promptSafeSourceName(value: unknown): string | undefined {
  const safe = sanitizeSourceName(value);
  if (!safe) return undefined;
  return safe.replace(/[[\]()]/g, (ch) => ({ '[': '［', ']': '］', '(': '（', ')': '）' })[ch] ?? ch);
}

function sanitizeSourceId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\s()「」]+/g, '').slice(0, 128);
  return cleaned || undefined;
}

/**
 * 模型文本里的 `「名字」(id_key: id)`（名字经 promptSafeSourceName）；缺名字时为 ` (id_key: id)`（带前导空格，便于直接接在「任务」后），
 * 两者都缺时为空串。
 */
export function formatSourceRef(name: unknown, idKey: string, id: unknown): string {
  const safeName = promptSafeSourceName(name);
  const safeId = sanitizeSourceId(id);
  const idPart = safeId ? `(${idKey}: ${safeId})` : '';
  if (safeName) return `「${safeName}」${idPart}`;
  return idPart ? ` ${idPart}` : '';
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export const HOOK_SCHEDULE_ID_PREFIX = 'hook:';

/**
 * Hook 渠道（Slack / X / 官方 Telegram）消息复用 scheduler 形态的 origin（scheduleId 为
 * `hook:<连接>`），它们是真人从渠道发来的，不是自动化：界面不显示自动化标签。
 */
export function isHookSchedulerOrigin(origin: unknown): boolean {
  const record = asRecord(origin);
  return (
    record?.kind === 'scheduler' &&
    typeof record.scheduleId === 'string' &&
    record.scheduleId.startsWith(HOOK_SCHEDULE_ID_PREFIX)
  );
}

/** 宽容读取持久化的 sourceDevice；平台缺失或未知时不出标签。 */
export function readMessageSourceDevice(meta: unknown): MessageSourceDevice | undefined {
  const raw = asRecord(asRecord(meta)?.sourceDevice);
  if (!raw) return undefined;
  const deviceId = readString(raw, 'deviceId');
  const platform = raw.platform === 'mobile' || raw.platform === 'desktop' ? raw.platform : undefined;
  if (!deviceId || !platform) return undefined;
  const name = sanitizeSourceName(raw.name);
  return { deviceId, platform, ...(name ? { name } : {}) };
}

/** 宽容读取持久化的 sourcePlugin。 */
export function readMessageSourcePlugin(meta: unknown): MessageSourcePlugin | undefined {
  const raw = asRecord(asRecord(meta)?.sourcePlugin);
  if (!raw) return undefined;
  const pluginId = readString(raw, 'pluginId');
  if (!pluginId) return undefined;
  const name = sanitizeSourceName(raw.name);
  return { pluginId, ...(name ? { name } : {}) };
}

/**
 * 设备标签只标「别的设备」发来的消息：查看者就是发送设备时不显示。
 * 被控电脑本机输入本来就没有 sourceDevice，任何设备上都不显示。
 */
export function shouldShowSourceDevice(
  device: MessageSourceDevice | undefined,
  viewerDeviceId: string | null | undefined,
): device is MessageSourceDevice {
  if (!device) return false;
  return !viewerDeviceId || device.deviceId !== viewerDeviceId;
}

/**
 * 从落库 agentMeta / 排队项的既有字段推出「谁发的」。
 * 只认 host 写入的字段；session 来源被共享任务脱敏后（无 senderSessionId）仍返回，
 * 说明里写「其他任务」。
 */
export function messageSourceSenderFromMeta(meta: unknown): MessageSourceSender | undefined {
  const record = asRecord(meta);
  if (!record) return undefined;
  // 插件优先：插件在某个任务里派发（agent.run 新建 / 继续 / 分叉）时同时带来源任务 origin，
  // 真正的发送方是插件，任务只是它运行的地方。
  const plugin = readMessageSourcePlugin(record);
  if (plugin) return { kind: 'plugin', ...plugin };
  const origin = asRecord(record.origin);
  if (origin?.kind === 'session') {
    const sessionId = readString(origin, 'senderSessionId');
    const title = readString(origin, 'senderSessionTitle');
    const botId = readString(origin, 'senderBotId');
    const botName = readString(origin, 'senderBotName');
    const group = readMessageSourceGroup(record);
    return {
      kind: 'session',
      ...(group ? { group } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(title ? { title } : {}),
      ...(botId ? { botId, ...(botName ? { botName } : {}) } : {}),
    };
  }
  const author = asRecord(record.sharedTaskAuthor);
  if (author) {
    const memberId = readString(author, 'memberId');
    const name = readString(author, 'displayName');
    if (memberId) return { kind: 'shared-member', memberId, ...(name ? { name } : {}) };
  }
  return undefined;
}

export type MessageSourceIdKind = 'plugin' | 'teammate' | 'session' | 'automation' | 'member';

export interface MessageSourceIdEntry {
  kind: MessageSourceIdKind;
  id: string;
}

/**
 * 可见「谁发的」标签对应的 ID 列表——桌面悬停、手机长按、排队行共用，与标签同一优先级：
 * 插件 → 伙伴（伙伴 id + 来源任务 id）→ 任务 → Orca 发送方任务 → 自动化（Hook 不算）→ 共享成员。
 * 脱敏后没有 id 的来源返回空数组（标签保持静态）。设备 id 属另一维度，不在此列。
 */
export function messageSourceIdEntries(meta: unknown): MessageSourceIdEntry[] {
  const sender = messageSourceSenderFromMeta(meta);
  if (sender?.kind === 'plugin') return [{ kind: 'plugin', id: sender.pluginId }];
  if (sender?.kind === 'shared-member') return [{ kind: 'member', id: sender.memberId }];
  if (sender?.kind === 'session') {
    return [
      ...(sender.botId ? [{ kind: 'teammate' as const, id: sender.botId }] : []),
      ...(sender.sessionId ? [{ kind: 'session' as const, id: sender.sessionId }] : []),
    ];
  }
  const origin = asRecord(asRecord(meta)?.origin);
  if (origin?.kind === 'orca') {
    const sessionId = readString(origin, 'senderSessionId');
    return sessionId ? [{ kind: 'session', id: sessionId }] : [];
  }
  if (origin?.kind === 'scheduler' && !isHookSchedulerOrigin(origin)) {
    const scheduleId = readString(origin, 'scheduleId');
    return scheduleId ? [{ kind: 'automation', id: scheduleId }] : [];
  }
  return [];
}

/**
 * 「谁发的」的一句话描述（不带前缀与结尾）：`[消息来源]` 说明与交接摘要共用，
 * 两处措辞与 ID 永远一致。例：`由任务「X」(session_id: s) 发送`。
 */
export function describeMessageSourceSender(sender: MessageSourceSender): string {
  switch (sender.kind) {
    case 'session': {
      if (sender.botId) {
        const bot = formatSourceRef(sender.botName, 'bot_id', sender.botId);
        const sessionId = sanitizeSourceId(sender.sessionId);
        const via = sessionId ? ` 通过任务 (session_id: ${sessionId})` : '';
        const group = sender.group ? ` 从群聊${formatSourceRef(sender.group.name, 'group_id', sender.group.groupId)}` : '';
        return `由伙伴${bot}${group}${via} 发送`;
      }
      const ref = formatSourceRef(sender.title, 'session_id', sender.sessionId);
      return ref ? `由任务${ref} 发送` : '由其他任务发送';
    }
    case 'plugin':
      return `由插件${formatSourceRef(sender.name, 'plugin_id', sender.pluginId)} 发送`;
    case 'shared-member':
      return `由共享任务成员${formatSourceRef(sender.name, 'member_id', sender.memberId)} 发送`;
  }
}

/** `[消息来源]` 说明；本机用户亲手输入返回 null。 */
export function buildMessageSourceNote(sender: MessageSourceSender | undefined): string | null {
  if (!sender) return null;
  const notOwner = sender.kind === 'shared-member' ? '不是任务所有者本人' : '不是用户本人输入';
  return `[消息来源] 本条${describeMessageSourceSender(sender)}，${notOwner}。`;
}

const CLIENT_NOTE_PREAMBLE = '[客户端说明] 系统追加的环境说明，不是用户消息，不要回应或复述。';

/**
 * 远程设备说明。只陈述「用户在哪台设备、操作的是哪台电脑」，怎么做交给模型判断。
 * 设备名与 id 对同一台设备固定不变，不破坏 prompt cache 的逐字节稳定要求。
 */
export function buildClientDeviceNote(
  device: MessageSourceDevice,
  host: MessageSourceHostDevice = {},
): string {
  const where = device.platform === 'mobile' ? '手机' : '另一台电脑';
  const deviceRef = formatSourceRef(device.name, 'device_id', device.deviceId);
  const hostRef = formatSourceRef(host.name, 'device_id', host.deviceId);
  return `${CLIENT_NOTE_PREAMBLE}本轮用户在${where}${deviceRef} 上远程操作本机${hostRef}。`;
}
