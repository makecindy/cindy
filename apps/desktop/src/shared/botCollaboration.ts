/**
 * 伙伴发起的可追踪任务在消息流中的结构化标记。
 *
 * 事实源仍是 `bot_delegations` 行。这里是父任务消息流里的持久锚点，让 renderer 在原位
 * 投影唯一任务卡与补充消息留痕。字段名 `botCollaboration` 为 v1 持久化兼容保留。
 *
 * 设计约束：
 *  - 只增不改。老数据（没有本标记的镜像消息）继续按普通文本渲染，不回填、不迁移。
 *  - 写进 `messages.agent_meta`（JSON 列）的 `botCollaboration` 字段，不动 schema。
 *  - 只承载呈现所需的**冻结快照**（当时的名字），不做权限判据：能不能打开对方任务
 *    仍由既有的会话可见性决定，本标记不放宽任何边界。
 */

/** 后台任务标记在某条消息上的用途。后三种只用于读取旧数据，不再生成或展示。 */
export type BotCollaborationRole =
  /** 父任务：启动时写下的任务卡锚点（空正文，只为承载卡片）。 */
  | 'delegation-request'
  /** 历史：父任务里的目标伙伴结果。 */
  | 'guest-result'
  /** 父任务：发起方给进行中任务追加消息的留痕。 */
  | 'interjection'
  /** 历史：目标伙伴主任务里的请求镜像。 */
  | 'guest-request'
  /** 历史：目标伙伴主任务里的终态镜像。 */
  | 'result-mirror';

export interface BotCollaborationMeta {
  v: 1;
  role: BotCollaborationRole;
  delegationId: string;
  /** 发起后台任务的伙伴。 */
  fromBotId: string;
  fromBotName: string;
  /** 新数据恒为 null；非 null 只可能来自旧版具名伙伴任务。 */
  toBotId: string | null;
  toBotName: string;
  /** 发起方任务；目标侧镜像据此回跳，看得到「这活是谁派的」。 */
  parentSessionId: string | null;
  /** 目标执行用的子任务；发起方侧据此跳过去看 TA 的完整对话。 */
  childSessionId: string | null;
  /** 委派目标摘要，用于卡片折叠态文案。 */
  objective: string;
}

const ROLES = new Set<BotCollaborationRole>([
  'delegation-request',
  'guest-result',
  'interjection',
  'guest-request',
  'result-mirror',
]);

function optionalId(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return value;
  return undefined;
}

/**
 * 严格解析：形状不对一律当作「没有标记」，退回普通文本渲染。宁可少一张卡，
 * 也不要把无法核实的身份贴到别人的气泡上。
 */
export function readBotCollaborationMeta(value: unknown): BotCollaborationMeta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 1) return null;
  if (typeof raw.role !== 'string' || !ROLES.has(raw.role as BotCollaborationRole)) return null;
  if (typeof raw.delegationId !== 'string' || !raw.delegationId) return null;
  if (typeof raw.fromBotId !== 'string' || !raw.fromBotId) return null;
  if (raw.toBotId !== null && (typeof raw.toBotId !== 'string' || !raw.toBotId)) return null;
  if (typeof raw.fromBotName !== 'string' || typeof raw.toBotName !== 'string') return null;
  if (typeof raw.objective !== 'string') return null;
  const parentSessionId = optionalId(raw.parentSessionId);
  const childSessionId = optionalId(raw.childSessionId);
  if (parentSessionId === undefined || childSessionId === undefined) return null;
  return {
    v: 1,
    role: raw.role as BotCollaborationRole,
    delegationId: raw.delegationId,
    fromBotId: raw.fromBotId,
    fromBotName: raw.fromBotName,
    toBotId: raw.toBotId,
    toBotName: raw.toBotName,
    parentSessionId,
    childSessionId,
    objective: raw.objective,
  };
}

/** 委派相关消息的幂等 clientId 前缀，main 与测试共用同一份常量。 */
export const BOT_DELEGATION_CLIENT_ID = {
  /** 父任务里的任务卡锚点。 */
  parentRequest: (delegationId: string) => `bot-delegation-request:${delegationId}`,
  /** 父任务里的结果回传（历史值，不可改）。 */
  completion: (delegationId: string) => `bot-delegation-completion:${delegationId}`,
  /** 同一任务结束后继续执行时，每一轮必须有独立的完成回执。首轮保持历史值兼容。 */
  completionRun: (delegationId: string, runSequence: number) =>
    runSequence <= 1
      ? `bot-delegation-completion:${delegationId}`
      : `bot-delegation-completion:${delegationId}:${runSequence}`,
  /** 插话：投进子任务的那条。 */
  interjection: (delegationId: string, token: string) =>
    `bot-delegation-interject:${delegationId}:${token}`,
  /** 插话：留在父任务里的留痕。 */
  interjectionMirror: (delegationId: string, token: string) =>
    `bot-delegation-interject-mirror:${delegationId}:${token}`,
} as const;

export type BotDelegationInterjectResult =
  | {
      ok: true;
      delegationId: string;
      childSessionId: string;
      /** 子任务当时是否正忙：忙则本条进它的输入队列，当前回合结束后被读到。 */
      queued: boolean;
    }
  | { ok: false; errorCode: string; message: string };
