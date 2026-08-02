/**
 * main/im/telegram/contactsAutoRegister.ts
 * ---------------------------------------------------------------------------
 * Telegram 群多人对话的「记住每个人」①层(设计 v3 §2.2, D1 拍板): 群里说话的人自动
 * 登记进智能通讯录 — telegram 数字 id 为主身份, username 为副身份, 建档带
 * 来源群名。零 LLM 成本; ②层(agent 在 turn 里用 contacts 工具写深度信息)
 * 走既有 cindy_contacts MCP, 不在本文件。
 *
 * 边界:
 *  - 尊重通讯录总开关(关着 = 不写);
 *  - owner 不登记(主人不是"别人");
 *  - 已有身份命中(telegram:id)不重复建档, 不覆盖任何既有信息;
 *  - 全程尽力而为 — 任何失败只 debug 日志, 绝不影响消息链路。
 */

import { createLogger } from '../../logger.js';
import { emitLocalContactsChanged } from '../../maker-host/contacts-change-events.js';
import { getDesktopContactsManager } from '../../maker-host/maker-contacts-host.js';
import { readContactsSettingsState } from '../../maker-host/contacts-settings-store.js';

const log = createLogger('telegram-contacts-auto');

/** 进程内去重(同一人只探一次); 重启后重探是幂等的(resolve 命中即返)。 */
const seenTelegramIds = new Set<string>();

export interface TelegramSpeakerToRegister {
  id: string;
  name: string;
  username?: string;
  isOwner: boolean;
}

export function autoRegisterTelegramSpeaker(
  speaker: TelegramSpeakerToRegister,
  context: { chatName?: string | null },
): void {
  try {
    if (speaker.isOwner) return;
    if (seenTelegramIds.has(speaker.id)) return;
    if (!readContactsSettingsState().value.enabled) return;

    const store = getDesktopContactsManager().getStore();
    const hits = store.resolve(speaker.id, { platform: 'telegram', limit: 1 });
    if (hits.some((h) => h.matchType === 'identity')) {
      seenTelegramIds.add(speaker.id);
      return;
    }

    const displayName = speaker.name.trim() || speaker.id;
    const groupNote = context.chatName ? `Telegram 群「${context.chatName}」` : 'Telegram 群';
    store.createContact({
      kind: 'person',
      displayName,
      source: 'agent',
      summary: `${groupNote}成员(bot 自动登记)`,
      identities: [
        { platform: 'telegram', value: speaker.id },
        ...(speaker.username ? [{ platform: 'telegram', value: `@${speaker.username}` }] : []),
      ],
    });
    emitLocalContactsChanged();
    // 去重标记只在成功路径落下: resolve/create 瞬时失败(DB busy/管理器未
    // 就绪)不标记, 该发言人下次发言可重试 — 尽力而为但可恢复。
    seenTelegramIds.add(speaker.id);
    log.info(`auto-registered telegram speaker id=${speaker.id}`);
  } catch (err) {
    log.debug?.(
      `telegram contact auto-register skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 账号切换或官方绑定换人时清空进程内去重，不把旧 owner 状态带进新边界。 */
export function resetTelegramSpeakerRegistrationCache(): void {
  seenTelegramIds.clear();
}
