/**
 * contacts/_shared.ts — cindy_contacts 工具共享 helpers。
 *
 *  - buildJsonResult: 拼单 text ContactsToolResult (跟 memory/_shared 同形)
 *  - withContacts:    拿全局 MakerContactsStore, 自动 try/catch + 错误翻译。
 *                     与 memory 的差异: 通讯录是全局单库, 不需要 workdir 解析;
 *                     开关判定走 deps.isEnabled?.()(host 设置层注入), 关着时返
 *                     CONTACTS_NOT_READY。
 *  - CONTACTS_COLLECTION_RULES: 采集边界规则(产品化自用户人物档案维护规范),
 *                     挂在 write/manage 工具的 rules 字段, agent 首次 list_tools
 *                     时读一遍 — 零 system prompt 改动的规则注入通道。
 */

import type { MakerContactsStore } from '@cindy/maker-core';

import type { ContactsToolResult } from '../cindy_contactsToolRegistry.js';
import type { ContactsMcpDeps } from '../types.js';
import { classifyContactsError } from './errors.js';

export function buildJsonResult(payload: unknown, isError = false): ContactsToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * 拿全局通讯录 store. 功能关闭 / manager 不可用时返 CONTACTS_NOT_READY。
 * opts.mutates: write/manage 类工具传 true — 成功后触发 deps.onMutated
 * (MCP 直写同进程 store 不经 IPC 层, 不广播的话设置页列表/角标/统计全部不刷新)。
 */
export async function withContacts(
  deps: ContactsMcpDeps,
  fn: (store: MakerContactsStore) => Promise<unknown> | unknown,
  opts?: { mutates?: boolean },
): Promise<ContactsToolResult> {
  let store: MakerContactsStore;
  try {
    if (deps.isEnabled && !deps.isEnabled()) {
      return buildJsonResult(
        {
          ok: false,
          code: 'CONTACTS_NOT_READY',
          message:
            'Smart Contacts is disabled — the user can turn it on in ' +
            'Settings → Personalization → Smart Contacts (设置 → 个性化 → 智能通讯录)',
        },
        true,
      );
    }
    store = deps.getManager().getStore();
  } catch (err) {
    // manager 未注入 / db 打开或迁移失败, 一律 NOT_READY — 这一段抛错都属于
    // "通讯录不可用", 不能落 INTERNAL 让 agent 收到错误的处置引导
    const { message } = classifyContactsError(err);
    return buildJsonResult({ ok: false, code: 'CONTACTS_NOT_READY', message }, true);
  }
  try {
    const data = await fn(store);
    if (opts?.mutates) {
      try {
        deps.onMutated?.();
      } catch {
        /* 广播回调异常不拖垮工具结果 */
      }
    }
    return buildJsonResult({ ok: true, data });
  } catch (err) {
    const { code, message, conflictContactId, candidates } = classifyContactsError(err);
    return buildJsonResult(
      {
        ok: false,
        code,
        message,
        ...(conflictContactId ? { conflictContactId } : {}),
        ...(candidates ? { candidates } : {}),
      },
      true,
    );
  }
}

/**
 * 采集边界规则 — write 类工具的 rules 字段共享文本。
 * 内容产品化自用户 obsidian 人物档案的维护规范(写入边界 / 待确认缓冲 / 时效标注)。
 */
export const CONTACTS_COLLECTION_RULES = [
  '建档边界: 只为"身份明确、和用户有持续业务/协作/私人关系"的人或组织建档。一次性发件人、营销/招聘邮件、GitHub 通知机器人、客服账号不建档。',
  '先查再写: 建档前先 contacts_resolve(邮箱/id/姓名), 已有档案走 contacts_update / contacts_append_event, 不要重复建档。收到 IDENTITY_CONFLICT 说明此人已存在 — 拿 conflictContactId 去更新那份档案。',
  '低置信进待确认: 身份不确定、同名可能混淆、只出现一次但看似重要的人, 用 status:"pending" 建档(会进设置里的待确认队列由用户裁决), 不要写成 confirmed。',
  '易过期信息带日期: 职位/公司/联系方式等易变信息, 用 contacts_append_event 追加带日期的事件(注明来源), 不要静默改写 narrative 里的旧记录。',
  '破坏性与组织性操作(manage 类: 删除/合并/分组管理)只在用户明确指示时执行, 不要自主决定删档或重组分组。',
].join('\n');
