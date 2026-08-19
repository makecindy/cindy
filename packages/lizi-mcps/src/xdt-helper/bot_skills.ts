import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

/**
 * 伙伴自己沉淀技能的工具面(批次 ζ「学会的本事」)。
 *
 * 与 `bot_durable_notes` 同构:host 注入回调才注册,归属一律由 host 从
 * callerSessionId 反查,工具层不接受 botId 参数 —— 模型报不出「我是谁」,也就
 * 无法写到别的伙伴名下。
 *
 * 与记忆的分工:`memory_write` 记的是「我知道什么」,这里存的是「这类事我怎么
 * 做」,并且会在下一次会话被 harness 真正挂载成技能。
 */

export interface BotSkillSummaryWire {
  slug: string;
  name: string;
  description: string;
  updatedAt: string;
}

export interface BotSkillCallbacks {
  save(params: {
    callerSessionId: string;
    name: string;
    description: string;
    body: string;
    slug?: string;
  }): Promise<
    ControlResult<
      { skill: BotSkillSummaryWire; created: boolean; effective: 'next-session' },
      string
    >
  >;
  list(params: {
    callerSessionId: string;
  }): Promise<ControlResult<{ skills: BotSkillSummaryWire[] }, string>>;
}

export interface BotSkillToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotSkillCallbacks;
}

function callerSessionId(deps: BotSkillToolDeps): string | null {
  return deps.getSessionContext().sessionId ?? null;
}

function missingSession() {
  return errorPayload('NOT_A_BOT_SESSION', '当前 MCP 调用未绑定 Cindy Bot 任务。');
}

export function registerBotSkillTools(
  registry: XdtHelperToolRegistry,
  deps: BotSkillToolDeps,
): void {
  registry.register({
    name: 'save_bot_skill',
    category: 'bots',
    description:
      '把刚做完的一类任务的可复用做法,存成当前 Bot 自己的一个技能(真技能文件,不是记忆分片)。'
      + '同名技能会被原地更新 —— 发现更好的做法就用同一个 name 再存一次。'
      + 'body 写成可照做的步骤,不要写这一次的具体结论。'
      + '技能在**下一次任务**才会被挂载,本次任务里不要指望能立刻调用它。',
    inputShape: {
      name: z
        .string()
        .min(1)
        .max(64)
        .describe('技能名(ASCII 字母数字与连字符最稳妥);同名 = 更新已有技能'),
      description: z
        .string()
        .min(1)
        .max(280)
        .describe('一行说明:什么情况下该用这个技能'),
      body: z.string().min(1).describe('可照做的步骤正文(Markdown)'),
      slug: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('可选;name 里没有 ASCII 可用字符时(如纯中文名)用它指定目录名'),
    },
    handler: async ({ name, description, body, slug }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.save({
        callerSessionId: sessionId,
        name,
        description,
        body,
        ...(slug ? { slug } : {}),
      });
      return result.ok
        ? okPayload({ skill: result.skill, created: result.created, effective: result.effective })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'list_bot_skills',
    category: 'bots',
    description:
      '列出当前 Bot 已经学会的技能(名称 / 说明 / 更新时间,不含正文)。'
      + '打算沉淀新技能前先看一眼:已经有的就用同名更新,不要重复学一遍。',
    inputShape: {},
    handler: async () => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.list({ callerSessionId: sessionId });
      return result.ok
        ? okPayload({ skills: result.skills })
        : errorPayload(result.errorCode, result.message);
    },
  });
}
