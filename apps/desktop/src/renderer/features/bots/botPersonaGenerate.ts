/**
 * 「角色生成助手」的 renderer 判定层。
 *
 * UI 在 `BotRosterView` 里,模型调用在 main(`maker-ipc/botPersonaGeneration.ts`),
 * 中间这几步判定单独放这儿,方便直接单测:
 *   - 失败码 → 一句人话的 i18n key(每一类都有,不许静默);
 *   - 草稿里那两个「建议头像」字段 → 这版真的画得出来的立绘 / 色相;
 *   - 草稿 → 创建 payload + 初始记忆分片。
 *
 * 草稿始终是**预填**:用户在预览卡上改完才创建,所以这里的函数都接受已经被用户
 * 编辑过的草稿,不去回头看模型原话。
 */

import {
  BOT_AVATAR_HUES,
  CINDY_PRESET_AVATAR_PREFIX,
  botAvatarAssignment,
  parsePresetAvatarId,
  presetAvatarValue,
  type BotAvatarHue,
} from './BotAvatar';
import { ASSISTANT_BASELINE_CAPABILITIES } from './botTemplates';
import { compilePersonaIntoIdentitySource } from './botPersona';
import type { PendingBotWelcome } from './botWelcome';
import type { BotCapabilities } from './botStore';
import type { BotMemorySeedEntry } from '../../../shared/botMemorySeed';
import type {
  BotPersonaDraft,
  BotPersonaGenerateErrorCode,
} from '../../../shared/botPersonaDraft';

/**
 * 每个失败码都有自己的一句话。
 *
 * 特别是 `provider-not-ready`:它说的是「能力在,账号不在」——与委派链路那条
 * `ACCOUNT_PROVIDER_NOT_READY` 是同一类现实,所以也按同样的方式处理:告诉用户
 * 去登录/连一个模型来源,而不是让按钮看起来像坏了。
 */
export function botPersonaGenerateErrorKey(code: BotPersonaGenerateErrorCode): string {
  switch (code) {
    case 'empty-input':
      return 'bots.roster.generate.errors.emptyInput';
    case 'provider-not-ready':
      return 'bots.roster.generate.errors.providerNotReady';
    case 'invalid-output':
      return 'bots.roster.generate.errors.invalidOutput';
    case 'generation-failed':
    default:
      return 'bots.roster.generate.errors.failed';
  }
}

/**
 * 模型给的头像建议 → 这版真的有的立绘 + 色相。
 *
 * 认不出来就退回按名字哈希分配的那一套(和空白卡的默认头像同一条路径):新客户端
 * 的立绘 id、瞎编的色名都不会让预览卡上出现一个空头像或一个原始字符串。
 */
export function resolveDraftAvatar(draft: BotPersonaDraft): { avatar: string; hue: BotAvatarHue } {
  const fallback = botAvatarAssignment(draft.name || 'bot');
  const preset = parsePresetAvatarId(
    draft.avatarPreset ? `${CINDY_PRESET_AVATAR_PREFIX}${draft.avatarPreset}` : null,
  );
  const hue = (BOT_AVATAR_HUES as readonly string[]).includes(draft.avatarHue)
    ? (draft.avatarHue as BotAvatarHue)
    : fallback.hue;
  return { avatar: preset ? presetAvatarValue(preset) : fallback.emoji, hue };
}

/** 创建一个生成出来的伙伴时交给 `addBotProfileAndWait` 的那份载荷。 */
export interface BotPersonaCreateInput {
  name: string;
  description: string;
  identitySource: string;
  avatar: string;
  avatarColor: BotAvatarHue;
  capabilities: Partial<BotCapabilities>;
}

/**
 * 草稿 → 创建载荷。
 *
 * `identitySource` 走 `compilePersonaIntoIdentitySource`,而不是把三档口气直接
 * 拼进正文:这样生成出来的伙伴一进设置页,「调整性格」向导就能读回自己的那段,
 * 「背景设定」子块显示的也正好是背景正文 —— 与从模板建出来的伙伴完全同构。
 *
 * 能力配置用普通助理的基线(`ASSISTANT_BASELINE_CAPABILITIES`),不另起一套。
 */
export function botPersonaCreateInput(draft: BotPersonaDraft): BotPersonaCreateInput {
  const { avatar, hue } = resolveDraftAvatar(draft);
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    identitySource: compilePersonaIntoIdentitySource(draft.identity.trim(), {
      style: draft.style,
      proactivity: draft.proactivity,
      call: draft.call,
    }),
    avatar,
    avatarColor: hue,
    capabilities: ASSISTANT_BASELINE_CAPABILITIES,
  };
}

/**
 * 手捏 / 生成出来的伙伴的通用开场句。模板伙伴有自己的 welcome 文案,不走这里。
 */
export const GENERIC_BOT_WELCOME_KEY = 'bots.welcome.generic';
/** 带一句话定位的开场句(生成路径在拿不到 `greeting` 时的回落)。 */
export const ROLE_BOT_WELCOME_KEY = 'bots.welcome.withRole';

/**
 * 手捏路径的开场白:通用一句,带上用户刚起的名字。
 *
 * 阵容页脚注「加入后 TA 会先跟你打个招呼」是对**所有**创建路径的承诺 —— 空白卡
 * 建出来的伙伴之前一句话不说,那条脚注对它就是句空话。
 */
export function botManualWelcome(name: string): PendingBotWelcome {
  return { key: GENERIC_BOT_WELCOME_KEY, params: { name: name.trim() } };
}

/**
 * 生成路径的开场白。
 *
 * 优先用模型现造的那句(它跟这个角色的口气对得上)。但有一个前提:**用户没在预览
 * 卡上改过名字**。改过就说明那句话里念的是一个已经不存在的名字,宁可回落到模板句
 * 也不要让 TA 一进门就自我介绍错。
 */
export function botPersonaWelcome(draft: BotPersonaDraft, pristineName: string): PendingBotWelcome {
  const name = draft.name.trim();
  const greeting = draft.greeting.trim();
  if (greeting && name === pristineName.trim()) {
    return { key: ROLE_BOT_WELCOME_KEY, text: greeting };
  }
  const description = draft.description.trim();
  return description
    ? { key: ROLE_BOT_WELCOME_KEY, params: { name, description } }
    : { key: GENERIC_BOT_WELCOME_KEY, params: { name } };
}

/**
 * 草稿里的初始记忆 → 可落库的分片。
 *
 * slug 由本地按序号派生(`start-1` …),不让模型起文件名:它给的中文标题当不了
 * 文件名,而 slug 同时是幂等键,必须稳定且合法(`[a-z0-9_-]`)。
 * 类型统一用 `reference`,和模板自带的开场笔记同一档 —— 它们都是「TA 的做法」,
 * 不是「关于主人的事实」。
 */
export function botPersonaSeedEntries(draft: BotPersonaDraft): BotMemorySeedEntry[] {
  return draft.memories.map((memory, index) => ({
    slug: `start-${index + 1}`,
    type: 'reference' as const,
    title: memory.title,
    description: memory.description,
    body: memory.body || memory.description,
  }));
}
