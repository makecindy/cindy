import { z } from 'zod';
import { registerRuntimeSettingsSection } from '../app-settings/runtime.js';
import type { AppSettingsSection } from '../app-settings/service.js';
import { additionalSettingsSchema, additionalSettingsMetadata, type AdditionalSettingsDomain } from '../../shared/settingsEditableCatalog.js';
import type { HostSettingsDomain } from '../../shared/hostSettings.js';
import { getHostSettings, updateHostSettings, HostSettingsError, type HostSettingsCaller } from './index.js';

/**
 * Cloud instances expose the Host settings that have no app settings section through the
 * settings tools. Sections the app already has (appearance, git-safety, agent-resources, memory,
 * subagent/auxiliary models, vision bridge, preferences, model tools) are not registered again.
 * Workspace-scoped tools, personal instructions and new-task defaults stay out of this surface.
 */
interface Entry { title: string; description: string }
const IM = (brand: string, group = false) => ({ title: `IM 新任务（${brand}）`, description: `${brand} 新任务的默认 Agent、${group ? '私聊与群聊权限' : '权限'}及各 Agent 的模型与推理强度。` });
const SECTIONS: Partial<Record<HostSettingsDomain, Entry>> = {
  databaseWarning: { title: '数据库体积提醒', description: '数据库体积提醒阈值（GiB）以及是否关闭提醒。' },
  collaboration: { title: '协同', description: '协同模式 Worker 软上限、硬上限与空闲释放分钟数。' },
  claudeCompaction: { title: '上下文压缩（Claude Code）', description: 'Claude Code 自动压缩上下文的触发阈值。' },
  piCompaction: { title: '上下文压缩（Pi）', description: 'Pi 自动压缩上下文的触发阈值。' },
  silentEncryptedRetry: { title: '静默丢弃协议加密内容并重试', description: '遇到协议加密内容时静默丢弃并重试。' },
  chatEmbedding: { title: '对话记录语义索引', description: '是否为对话记录建立语义索引。' },
  terminal: { title: '默认终端 shell', description: '以后的终端连接使用的默认 shell。' },
  lsp: { title: '代码智能（LSP）', description: '代码智能（LSP）开关。' },
  linuxWindow: { title: '应用行为', description: '关闭主窗口时的行为。' },
  shortcuts: { title: '键盘快捷键', description: '这台 Cindy 桌面上的键盘快捷键绑定。' },
  builtinTools: { title: '内置工具', description: '内置工具开关：飞书机器人、微信、Slack、SSH、文档工坊、协同模式等。' },
  browserTools: { title: '自动操作浏览器', description: '是否允许 Agent 自动操作浏览器。' },
  browserBackend: { title: '浏览器自动化目标', description: '浏览器自动化使用的目标。' },
  computerTools: { title: '自动操作电脑', description: '是否允许 Agent 自动操作电脑。' },
  androidTools: { title: 'Android 自动化', description: '是否允许 Agent 操作 Android 设备。' },
  pluginErrand: { title: '插件 Agent 任务', description: '插件发起的 Agent 任务使用的模型、权限与工作目录。' },
  pluginCindy: { title: '插件 AI 能力', description: '插件调用图片、视频、文本与向量能力时的模型与并发数。' },
  pluginSidebar: { title: '隐藏的插件', description: '在侧栏隐藏的插件。' },
  modelEngines: { title: '模型偏好 Agent', description: '各模型优先使用的 Agent。' },
  modelFavorites: { title: '收藏模型', description: '收藏的模型及其推理强度与 Fast 设置。' },
  imGlobal: { title: 'IM 新任务（全局默认）', description: '所有 IM 渠道新任务共用的默认 Agent、权限及各 Agent 的模型与推理强度。' },
  imFeishu: IM('Feishu / Lark', true),
  imSlack: IM('Slack'),
  imDiscord: IM('Discord'),
  imWechat: IM('WeChat'),
  imTelegram: IM('Telegram'),
  imDingtalk: IM('DingTalk'),
  imWecom: IM('WeCom'),
  imWorkspaces: { title: 'IM 工作目录偏好', description: '现有 IM 工作目录的模型、推理强度与权限偏好；不能新增、改名、改路径或删除目录。' },
  imWorkspaceProviders: { title: 'IM 工作目录模型来源', description: '现有 IM 工作目录使用的模型来源；不能新增或删除目录。' },
  officialHooks: { title: 'Cindy IM 机器人', description: 'Cindy 官方 IM 机器人：Slack 上下线通知，Telegram 与 X 的默认工作目录。' },
  telegramBehavior: { title: 'Telegram 回应与引用', description: 'Telegram 表情回应，以及群聊、私聊回复时是否引用消息。' },
  telegramGroups: { title: 'Telegram 群聊', description: '无需 @ 即可参与的 Telegram 群聊。' },
  telegramPersona: { title: 'Telegram 人格', description: 'Telegram 机器人的名字与基础人格；读取时不返回人格正文。' },
  wecomNotifications: { title: '企业微信通知', description: '是否发送企业微信群通知。' },
  privacy: { title: '隐私', description: '是否发送使用统计。' },
  diagnostics: { title: '诊断', description: '崩溃时是否自动上传日志。' },
};
const EFFECTIVE = { next_task: 'next-task', next_agent_start: 'next-agent-start', immediate: 'immediate', host_desktop_only: 'immediate', next_connection: 'next-connection' } as const;
const databaseWarningSchema = z.strictObject({ thresholdGiB: z.number().min(1).max(1024), disabled: z.boolean() });
const caller: HostSettingsCaller = { id: 'app-settings', assertCurrent() {} };

async function write(domain: HostSettingsDomain, change: { set?: Record<string, unknown>; clear?: string[] }) {
  try {
    const state = await getHostSettings(caller, domain);
    if (state.status !== 'ready') return { ok: false, code: state.status === 'unavailable' ? 'UNAVAILABLE' : 'UNREADABLE' };
    const receipt = await updateHostSettings(caller, { domain, operationId: state.operationId, expectedRevision: state.revision, ...change });
    return receipt.saved ? { ok: true, application: receipt.application } : { ok: false, code: receipt.code ?? 'NOT_SAVED' };
  } catch (error) {
    if (error instanceof HostSettingsError) return { ok: false, code: error.code };
    throw error;
  }
}

function section(domain: HostSettingsDomain, entry: Entry): AppSettingsSection {
  const schema = (domain === 'databaseWarning' ? databaseWarningSchema : additionalSettingsSchema(domain as AdditionalSettingsDomain)).partial();
  return {
    id: domain,
    title: entry.title,
    description: entry.description,
    effective: domain === 'databaseWarning' ? 'immediate' : EFFECTIVE[additionalSettingsMetadata[domain as AdditionalSettingsDomain].applies],
    schema: schema as unknown as AppSettingsSection['schema'],
    read: async () => {
      const state = await getHostSettings(caller, domain);
      if (state.status !== 'ready') return { status: state.status };
      return { value: state.value, defaults: state.defaults, customizedKeys: state.customizedKeys,
        ...('choices' in state && state.choices ? { choices: state.choices } : {}) };
    },
    update: patch => write(domain, { set: patch }),
    reset: async () => {
      const state = await getHostSettings(caller, domain);
      if (state.status !== 'ready') return { ok: false, code: state.status === 'unavailable' ? 'UNAVAILABLE' : 'UNREADABLE' };
      return state.customizedKeys.length ? write(domain, { clear: state.customizedKeys }) : undefined;
    },
  };
}

/** Cloud instances only; ordinary desktops keep the ordinary section list. */
export function registerHostAppSettingsSections(): void {
  for (const [domain, entry] of Object.entries(SECTIONS) as Array<[HostSettingsDomain, Entry]>) registerRuntimeSettingsSection(section(domain, entry));
}
export const HOST_APP_SETTINGS_SECTION_IDS = Object.keys(SECTIONS) as HostSettingsDomain[];
