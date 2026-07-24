/**
 * 灵动岛工具措辞的本地化实现:用 main 侧 t() 解析与面板同源的 i18n key 表
 * (src/shared/agentActionVerbKeys.ts),注入共享包的 ToolRowWording 槽位。
 *
 * 做成 lazy t() 闭包而非预构建数据表:locale 运行时可切(setMainLocale),
 * 每次取词现场解析即可自动跟随,无缓存失效问题。依赖 electron(经 i18n.ts),
 * 因此独立于纯模块 state.ts / toolDetail.ts,由 service 注入。
 */
import type { ToolRowWording } from '@cindy/maker-shared/message-presentation';

import { t } from '../i18n.js';
import {
  FILE_CHANGE_FILES_I18N_KEY,
  INTENT_ROW_VERB_KEY,
  TOOL_ROW_VERB_I18N_KEY,
  UPDATED_VERB_I18N_KEY,
} from '../../shared/agentActionVerbKeys.js';

export function createLocalizedToolRowWording(): ToolRowWording {
  return {
    verb: (key) => t(TOOL_ROW_VERB_I18N_KEY[key]),
    intentVerb: (action) => t(INTENT_ROW_VERB_KEY[action]),
    // main 的迷你 i18n 只支持 {{appName}} 插值,{{count}} 在调用点手动替换。
    updateFilesLabel: (count) =>
      `${t(UPDATED_VERB_I18N_KEY)} ${t(FILE_CHANGE_FILES_I18N_KEY).replace('{{count}}', String(count))}`,
  };
}
