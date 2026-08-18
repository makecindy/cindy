import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

type DelegationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed-out';

export interface BotDelegationCallbacks {
  listBots(params: { callerSessionId: string }): Promise<ControlResult<{ bots: unknown[] }, string>>;
  delegateToBot(params: {
    callerSessionId: string;
    targetBotId: string;
    objective: string;
    contextRefs?: string[];
    artifactRefs?: string[];
    budgetTokens?: number;
    maxDepth?: number;
    timeoutMs?: number;
  }): Promise<ControlResult<Record<string, unknown>, string>>;
  listDelegations(params: {
    callerSessionId: string;
    status?: DelegationStatus;
  }): Promise<ControlResult<{ delegations: unknown[] }, string>>;
  cancelDelegation(params: {
    callerSessionId: string;
    delegationId: string;
  }): Promise<ControlResult<Record<string, unknown>, string>>;
  interjectDelegation(params: {
    callerSessionId: string;
    delegationId: string;
    text: string;
  }): Promise<ControlResult<Record<string, unknown>, string>>;
}

export interface BotDelegationToolDeps {
  getSessionContext: () => LiziMcpSessionContext;
  callbacks: BotDelegationCallbacks;
}

function callerSessionId(deps: BotDelegationToolDeps): string | null {
  return deps.getSessionContext().sessionId ?? null;
}

function missingSession() {
  return errorPayload(
    'NOT_A_BOT_SESSION',
    '当前 MCP 调用未绑定 Cindy 任务，无法验证 Bot 身份。',
  );
}

export function registerBotDelegationTools(
  registry: XdtHelperToolRegistry,
  deps: BotDelegationToolDeps,
): void {
  registry.register({
    name: 'list_bots',
    category: 'bots',
    description:
      '列出当前 Cindy Bot 可以委派的 Bot。仅 Bot 任务可调用；返回稳定 Bot id、名称、说明和主任务引用。',
    inputShape: {},
    handler: async () => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.listBots({ callerSessionId: sessionId });
      return result.ok ? okPayload({ bots: result.bots }) : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'delegate_to_bot',
    category: 'bots',
    description: [
      '把一个有界目标委派给另一个 Cindy Bot。目标在独立子任务中使用自己的 Profile、Skills、MCP、Memory 与项目/worktree 策略运行，完成后结果会自动回到当前任务。',
      '默认 max_depth=1，保持 Hermes 式扁平委派；只有明确需要编排型子 Bot 时才提高 max_depth。禁止循环；同一 Bot 默认最多 10 个进行中的委派。',
      '只传必要上下文引用，不复制父任务全部历史。budget_tokens 与 timeout_ms 是持久执行边界。',
    ].join('\n'),
    inputShape: {
      target_bot_id: z.string().min(1).max(128),
      objective: z.string().min(1).max(12_000),
      context_refs: z.array(z.string().max(4_000)).max(32).optional(),
      artifact_refs: z.array(z.string().max(4_000)).max(32).optional(),
      budget_tokens: z.number().int().positive().optional(),
      max_depth: z.number().int().min(1).max(5).optional(),
      timeout_ms: z.number().int().min(1_000).max(86_400_000).optional(),
    },
    handler: async ({
      target_bot_id,
      objective,
      context_refs,
      artifact_refs,
      budget_tokens,
      max_depth,
      timeout_ms,
    }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.delegateToBot({
        callerSessionId: sessionId,
        targetBotId: target_bot_id,
        objective,
        contextRefs: context_refs,
        artifactRefs: artifact_refs,
        budgetTokens: budget_tokens,
        maxDepth: max_depth,
        timeoutMs: timeout_ms,
      });
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'list_bot_delegations',
    category: 'bots',
    description:
      '查看当前 Bot 最近的持久委派记录、子任务、状态、预算、结果和错误。完整正文仍在 child_session_id 对应任务中。',
    inputShape: {
      status: z
        .enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'timed-out'])
        .optional(),
    },
    handler: async ({ status }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.listDelegations({
        callerSessionId: sessionId,
        status,
      });
      return result.ok
        ? okPayload({ delegations: result.delegations })
        : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'interject_bot_delegation',
    category: 'bots',
    description: [
      '向一个仍在进行的委派补充一句话：催一下进度、追加条件、或者纠正方向。对方会在当前回合结束后读到，不会打断它正在做的事。',
      '只对 queued/running/waiting 的委派有效；已完成、失败或已取消的委派会明确报错——那时候应该发起新的委派，而不是往旧的里塞话。',
      '想让对方立刻停手用 cancel_bot_delegation；想知道现在做到哪了用 list_bot_delegations。',
    ].join('\n'),
    inputShape: {
      delegation_id: z.string().min(1).max(128),
      text: z.string().min(1).max(4_000),
    },
    handler: async ({ delegation_id, text }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.interjectDelegation({
        callerSessionId: sessionId,
        delegationId: delegation_id,
        text,
      });
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });

  registry.register({
    name: 'cancel_bot_delegation',
    category: 'bots',
    description:
      '取消当前 Bot 发起的一个 queued/running/waiting 委派，并中止对应子任务的当前回合。终态委派不会被改写。',
    inputShape: {
      delegation_id: z.string().min(1).max(128),
    },
    handler: async ({ delegation_id }) => {
      const sessionId = callerSessionId(deps);
      if (!sessionId) return missingSession();
      const result = await deps.callbacks.cancelDelegation({
        callerSessionId: sessionId,
        delegationId: delegation_id,
      });
      return result.ok ? okPayload(result) : errorPayload(result.errorCode, result.message);
    },
  });
}
