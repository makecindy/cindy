/**
 * feishu/messages.ts
 * ---------------------------------------------------------------------------
 * Centralised user-facing strings for transport-layer errors and lifecycle
 * announcements. Business-domain strings (agent errors, "API key required"
 * etc.) belong in the host orchestrator, not here.
 *
 * Every leaf is a getter / function resolved through `tt` at send time so the
 * copy follows the host's current interface language (Chinese fallback when no
 * host resolver is installed).
 */

import { tt } from '../transportText.js';

const K = 'imBot.text.transport.feishu';

export const messages = {
  lifecycle: {
    get online(): string {
      return tt(`${K}.lifecycle.online`, '🟢 已上线，可以开聊啦~');
    },
    get offline(): string {
      return tt(`${K}.lifecycle.offline`, '🔴 Cindy 已离线，暂时无法通过当前 IM 继续聊天。');
    },
    get offlineNotice(): string {
      return tt(`${K}.lifecycle.offlineNotice`, '🔔 我之前离线过一段时间，期间的消息可能没有收到哦~');
    },
  },
  ownerBinding: {
    get welcome(): string {
      return tt(
        `${K}.ownerBinding.welcome`,
        '🎉 已绑定为本 bot 的 owner~\n之后只有你能跟我聊天。如需更换 owner，请到 desktop 的 Settings 页清除 bot 凭证后重新保存。',
      );
    },
  },
  group: {
    /**
     * 非 owner 在群里 @bot 的礼貌回应(per-user 冷却防刷屏, 与 telegram 同语义)。
     * 刻意保持中英双语、不随界面语言切换:读者是不认识主人的陌生人。
     */
    strangerNotice:
      '👋 我是一位主人的个人 Cindy 助理，只响应主人本人的指令~\nI am a personal Cindy assistant and only respond to my owner.',
    /**
     * 开场白卡已发出但话题 id 无法恢复、撤回也失败时的兜底提示 — 回复落在
     * 开场白所在话题内, 本轮不起 turn(降级群 lane 会一边留着「思考中」的
     * 开场白卡一边把回答刷进群主流)。per-opener 冷却防重投事件重复提示。
     */
    get threadOrphanNotice(): string {
      return tt(`${K}.group.threadOrphanNotice`, '开话题出了点小问题, 这条没能处理, 麻烦再 @ 我一次~');
    },
  },
  // (inbound.skipped removed — orchestrator owns the wording for "pure
  // unsupported" / "mixed unsupported" replies; @cindy/im just emits the raw
  // entries via IMMessageEvent.unsupported.)
  /** Throttled streaming card placeholder texts. */
  streaming: {
    /**
     * Initial card placeholder shown before the first text-delta arrives.
     * Picks one variant at random per turn so back-to-back replies don't all
     * read identically — the IM card is the user's primary feedback channel
     * during the silent "agent is thinking" window, and a single static line
     * gets old fast in active sessions.
     *
     * Variants are kept short (≤ 14 visible chars including emoji) so they
     * fit on one line in the feishu card header without wrapping.
     */
    randomThinking(): string {
      const [name, fallback] = THINKING_VARIANTS[Math.floor(Math.random() * THINKING_VARIANTS.length)];
      return tt(`${K}.streaming.thinking.${name}`, fallback);
    },
    /** Intermediate frame: buffer contains only xdt-image refs (no real text). */
    get preparingImage(): string {
      return tt(`${K}.streaming.preparingImage`, '🎨 图片冲洗中,稍等一下 ~');
    },
    /** Intermediate frame: buffer contains only xdt-file refs (no real text). */
    get preparingFile(): string {
      return tt(`${K}.streaming.preparingFile`, '📦 文件打包中,马上送达 ~');
    },
    /** Finalize: card text empty after stripping xdt-file (model only sent files). */
    fileSentDone(count: number): string {
      return count === 1
        ? tt(`${K}.streaming.fileSentOne`, '🎉 文件已送达,请查收!')
        : tt(`${K}.streaming.filesSent`, '🎉 {{count}} 个文件已全部送达 ~', { count });
    },
    /** Finalize: card text empty AND no files (rare — agent emitted nothing useful). */
    get emptyReply(): string {
      return tt(`${K}.streaming.emptyReply`, '_(空回复)_');
    },
    /**
     * Intermediate frame only: the answer so far no longer fits one card. The
     * final answer is delivered in full across several cards (see `partNote`).
     */
    get replyContinues(): string {
      return tt(`${K}.streaming.replyContinues`, '\n\n---\n⏳ 内容较长，写完后会分成多条完整发送。');
    },
    /**
     * Footnote on each card of a multi-card final answer. The non-final form must
     * stay the longer one: card splitting reserves room with `partNote(98, 99)`.
     */
    partNote(index: number, total: number): string {
      return index < total
        ? tt(`${K}.streaming.partNoteMore`, '{{index}}/{{total}} · 未完，接下一条', { index, total })
        : tt(`${K}.streaming.partNoteLast`, '{{index}}/{{total}} · 完', { index, total });
    },
    /** A later card of a multi-card final answer could not be sent. */
    get continuationFailed(): string {
      return tt(`${K}.streaming.continuationFailed`, '⚠️ 后面的内容没能发出，完整回复可在 Cindy 桌面端查看。');
    },
    get deliveryFailed(): string {
      return tt(
        `${K}.streaming.deliveryFailed`,
        '⚠️ 这条回复过长或包含飞书暂不支持的内容，请在 Cindy 桌面端查看完整回复。',
      );
    },
  },
  card: {
    /** Inline marker where a Markdown image could not be uploaded to Feishu. */
    imageLoadFailed(target: string): string {
      return tt(`${K}.card.imageLoadFailed`, '_[图片加载失败:{{target}}]_', { target });
    },
    /** Toast bubble shown right after a card button is clicked. */
    get choiceReceived(): string {
      return tt(`${K}.card.choiceReceived`, '已收到您的选择');
    },
  },
  connection: {
    /** Status reason: the App is held by another device. Keep `exceed_conn_limit` in every locale. */
    get conflict(): string {
      return tt(`${K}.connection.conflict`, '该 App 已被另一台设备占用 (exceed_conn_limit)');
    },
    /** Status reason: the IM service cannot be reached. */
    get unreachable(): string {
      return tt(`${K}.connection.unreachable`, '连接失败：IM 服务无法访问，请检查网络');
    },
    /** Status reason: wrong credentials (verdict detail). Keep `auth_failed` in every locale. */
    get authFailedDetail(): string {
      return tt(`${K}.connection.authFailedDetail`, 'App ID / App Secret 不正确（auth_failed）');
    },
    /** Status reason: wrong credentials (live status). */
    get authFailed(): string {
      return tt(`${K}.connection.authFailed`, 'App ID 或 App Secret 不正确');
    },
  },
};

/** [key leaf, Chinese fallback] — resolved per pick so the language is current. */
const THINKING_VARIANTS: ReadonlyArray<readonly [string, string]> = [
  ['brain', '🧠 脑子转转中...'],
  ['letMeThink', '🤔 让我想想哦~'],
  ['inspiration', '✨ 灵感正在路上...'],
  ['tea', '🍵 泡杯茶,马上来~'],
  ['cat', '🐱 猫挠键盘思考中...'],
  ['engine', '🚀 引擎预热中...'],
  ['thoughts', '🌀 思绪整理中...'],
  ['spell', '🪄 念个咒语...'],
  ['draft', '📝 草稿打中...'],
  ['puzzle', '🧩 拼图组装中...'],
  ['coffee', '☕ 续杯,马上回~'],
  ['target', '🎯 瞄准答案中...'],
];
