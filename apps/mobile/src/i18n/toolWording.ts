/**
 * 手机端工具措辞的本地化实现:用 i18n.t 解析与桌面同源的 chat.agentActionRow key,
 * 注入共享包的 ToolRowWording 槽位。
 *
 * 做成 lazy t() 闭包而非预构建数据表:locale 运行时可切,每次取词现场解析即可
 * 自动跟随,无缓存失效问题。
 */
import type { ToolRowWording } from '@cindy/maker-shared/message-presentation';

import { i18n } from '@/i18n';
import {
  FILE_CHANGE_UPDATED_FILES_I18N_KEY,
  INTENT_ROW_VERB_KEY,
  TOOL_ROW_VERB_I18N_KEY,
} from '@/i18n/agentActionVerbKeys';

export function createMobileToolRowWording(): ToolRowWording {
  return {
    verb: (key) => i18n.t(TOOL_ROW_VERB_I18N_KEY[key]),
    intentVerb: (action) => i18n.t(INTENT_ROW_VERB_KEY[action]),
    // 整句 key:语序按语言走,不在这里拼动词与文件数(ja/ko 拼出来不成句)。
    updateFilesLabel: (count) => i18n.t(FILE_CHANGE_UPDATED_FILES_I18N_KEY, { count }),
  };
}

export const mobileToolRowWording: ToolRowWording = createMobileToolRowWording();
