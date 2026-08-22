/**
 * botPersonaGeneration —— 「一句话角色 → 一份伙伴草稿」的一次性模型调用。
 *
 * ## 通道选型(2026-08 盘点)
 *
 * 本仓已有的「一次性 LLM 调用」只有一条真实基建:`maker-host/title-one-shot.ts`。
 * 它按会话所属 provider 取目录里最经济的 `titleModel`,用该 provider 自家凭证发
 * **一次** HTTP,三家 wire(anthropic-messages / codex-responses / gateway-chat)
 * 各一个 fetcher。自动起名、Magic 重命名、输入框推荐提示词(`promptPrediction.ts`)
 * 全部复用它 —— 后者已经把「同一条通路 + 覆盖 token 数与输出校验」的用法趟过一遍。
 *
 * 所以本模块**不新开**供应商解析、端点、凭证或超时策略,只是第四个调用方:
 *   - `maxOutputChars: 0` / `maxVisualChars: 0` 关掉标题专用的单行校验与 40 字截断
 *     (那两条是给标题定的:JSON 天然多行,会被判非法);
 *   - `maxTokens` 放到 900(标题 32、推荐 96;一份草稿含背景设定与 2-3 条记忆);
 *   - `systemPrompt` 承载 schema 说明,user 段只放用户那一句角色描述。
 *
 * 校验回到我们自己手里:`parseBotPersonaDraft`(shared)判形状,判不出来就报
 * `invalid-output`,绝不把半截 JSON 当成一个伙伴。
 *
 * ## 没有会话怎么办
 *
 * 这条调用发生在**伙伴还不存在**的时候,自然没有 sessionId。one-shot 的 provider
 * 解析对空 sessionId 有定义好的语义:跳过 DB 显式来源,直接取「该 agent 已连接来源
 * 里的原生默认」(= 模型选择器里高亮的那个),与用户看到的默认完全一致。会话归属
 * 复查(`beforeDispatch`)本就是可选项,没有会话可查就不传。
 *
 * ## 用哪个 agent 的来源
 *
 * 新伙伴默认 harness 是 claude,所以先看 `claude-code` 的已连接来源;一个都没有时
 * 依次退到 codex / pi —— 只连了 ChatGPT 的用户点「帮我生成」也该能用,而不是被告知
 * 「没有可用模型」。三条都空才是真的没登录,报 `provider-not-ready`。
 */

import type { AgentKind } from '@cindy/maker-core';
import { connectedProvidersForAgent, type ProviderView } from '@cindy/model-providers';

import {
  buildBotPersonaPrompt,
  parseBotPersonaDraft,
  BOT_PERSONA_ROLE_MAX_CHARS,
  type BotPersonaGenerateResult,
} from '../../shared/botPersonaDraft.js';
import { getResolvedMainLocale } from '../i18n.js';
import { getDesktopProviderService } from '../maker-host/createDesktopProviderService.js';
import {
  generateTitleViaProviderResult,
  type TitleOneShotResult,
} from '../maker-host/title-one-shot.js';
import { createLogger } from '../logger.js';

const log = createLogger('maker-ipc/bot-persona-generation');

/** 一份草稿的输出预算。标题 32 / 推荐 96;这里要装下背景设定 + 2-3 条记忆。 */
const PERSONA_MAX_TOKENS = 900;

/** 先 claude,再 codex,最后 pi —— 与新伙伴的默认 harness 顺序一致。 */
const PERSONA_AGENT_PREFERENCE: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/** 注入面:单测用假实现替换 provider 枚举与模型调用,不碰 electron / 网络。 */
export interface BotPersonaGenerationDeps {
  /** 某 agent 下已连接的供应商列表(实时连接态)。 */
  listConnectedProviders: (agentKind: AgentKind) => Promise<ProviderView[]>;
  /** 走一次性通道发请求。 */
  runOneShot: (args: {
    agentKind: AgentKind;
    prompt: string;
    systemPrompt: string;
  }) => Promise<TitleOneShotResult>;
  /** 界面语言 —— 决定草稿用哪种语言写。 */
  readLocale: () => string;
}

async function listConnectedProvidersForAgent(agentKind: AgentKind): Promise<ProviderView[]> {
  try {
    const all = await getDesktopProviderService().listProviders({ allowSideEffects: true });
    return connectedProvidersForAgent(all, agentKind);
  } catch {
    return [];
  }
}

export function defaultBotPersonaGenerationDeps(): BotPersonaGenerationDeps {
  return {
    listConnectedProviders: listConnectedProvidersForAgent,
    runOneShot: ({ agentKind, prompt, systemPrompt }) =>
      generateTitleViaProviderResult(
        // sessionId 为空 = 没有会话可归属,走「已连接来源的原生默认」。
        { sessionId: '', agentKind, prompt },
        { listConnectedProviders: listConnectedProvidersForAgent },
        {
          maxTokens: PERSONA_MAX_TOKENS,
          codexInstructions:
            'Output only the JSON object described by the system instructions — no prose, no markdown fence.',
          systemPrompt,
          // 标题专用的单行校验与 40 字截断对 JSON 一律误杀,关掉。
          maxOutputChars: 0,
          maxVisualChars: 0,
        },
      ),
    readLocale: () => getResolvedMainLocale(),
  };
}

/**
 * 一句话角色 → 草稿。任何一步走不通都返回**分类过的**失败码,由 renderer 翻成
 * 一句人话 + 保留「自己写」出路;这条链路不允许静默失败。
 */
export async function generateBotPersonaDraft(
  role: unknown,
  deps: BotPersonaGenerationDeps,
): Promise<BotPersonaGenerateResult> {
  const trimmed = typeof role === 'string' ? role.trim() : '';
  if (!trimmed) return { ok: false, code: 'empty-input' };

  let agentKind: AgentKind | null = null;
  for (const candidate of PERSONA_AGENT_PREFERENCE) {
    const rail = await deps.listConnectedProviders(candidate);
    if (rail.length > 0) {
      agentKind = candidate;
      break;
    }
  }
  if (!agentKind) {
    log.info('bot persona generation skipped: no connected provider on any agent');
    return { ok: false, code: 'provider-not-ready' };
  }

  const { system, user } = buildBotPersonaPrompt(
    trimmed.slice(0, BOT_PERSONA_ROLE_MAX_CHARS),
    deps.readLocale(),
  );
  const result = await deps.runOneShot({ agentKind, prompt: user, systemPrompt: system });
  if (result.status !== 'ok') {
    log.info('bot persona generation failed', { agentKind, status: result.status });
    return { ok: false, code: 'generation-failed' };
  }

  const draft = parseBotPersonaDraft(result.title);
  if (!draft) {
    // 只记长度,不记内容:那是用户描述的角色,没有理由进日志。
    log.info('bot persona generation returned an unusable shape', {
      agentKind,
      outputChars: result.title.length,
    });
    return { ok: false, code: 'invalid-output' };
  }
  return { ok: true, draft };
}
