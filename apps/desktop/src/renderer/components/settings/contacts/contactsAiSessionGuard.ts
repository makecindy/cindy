import type { NewMakerEntryIntent } from '@/state/newMakerDraft';

export interface ContactsAiSessionReadiness {
  enabled: boolean;
  pluginEnabled: boolean;
  codexMcpReady: boolean;
}

export type ContactsAiSessionBlockReason = 'unavailable' | 'codex-deferred';

export function contactsAiSessionBlockMessageKey(
  reason: ContactsAiSessionBlockReason,
): 'settings.contacts.toast.aiUnavailable' | 'settings.contacts.toast.codexRefreshDeferred' {
  return reason === 'codex-deferred'
    ? 'settings.contacts.toast.codexRefreshDeferred'
    : 'settings.contacts.toast.aiUnavailable';
}

/**
 * 在真正创建任务前按最终 vendor / workingDir 重读通讯录工具面。
 * 普通新任务不触发；Claude / Pi 不受 Codex 长活 runtime 的 applied 快照影响。
 */
export async function checkContactsAiSessionBeforeSend(input: {
  entryIntent: NewMakerEntryIntent | null;
  vendor: 'cc' | 'codex' | 'pi';
  workingDir?: string;
  isLocalTarget: boolean;
  readReadiness: (workingDir?: string) => Promise<ContactsAiSessionReadiness>;
}): Promise<ContactsAiSessionBlockReason | null> {
  if (input.entryIntent !== 'contacts-ai-management') return null;
  // 预填入口管理的是本机通讯录；用户随后切到远端时不能拿本机状态替远端放行。
  if (!input.isLocalTarget) return 'unavailable';

  const readiness = await input.readReadiness(input.workingDir);
  if (!readiness.enabled || !readiness.pluginEnabled) return 'unavailable';
  if (input.vendor === 'codex' && !readiness.codexMcpReady) return 'codex-deferred';
  return null;
}
