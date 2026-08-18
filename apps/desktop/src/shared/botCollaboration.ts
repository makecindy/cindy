/**
 * 伙伴之间「群聊化」协作的消息级结构化标记。
 *
 * 委派本身的事实源仍是 `bot_delegations` 行（状态机 / 预算 / lineage）。这里补的是
 * **消息流里的锚点**：父任务与目标主任务各自的时间线上，哪几条消息属于同一次委派、
 * 各自扮演什么角色。renderer 据此把纯文本镜像升级成协作卡与客座气泡，并在两侧之间
 * 提供互看跳转。
 *
 * 设计约束：
 *  - 只增不改。老数据（没有本标记的镜像消息）继续按普通文本渲染，不回填、不迁移。
 *  - 写进 `messages.agent_meta`（JSON 列）的 `botCollaboration` 字段，不动 schema。
 *  - 只承载呈现所需的**冻结快照**（当时的名字），不做权限判据：能不能打开对方任务
 *    仍由既有的会话可见性决定，本标记不放宽任何边界。
 */

/** 委派在某条消息上扮演的角色。判据是消息落在谁的时间线上。 */
export type BotCollaborationRole =
  /** 父任务：委派创建时写下的协作卡锚点（空正文，只为承载卡片）。 */
  | 'delegation-request'
  /** 父任务：目标伙伴回传的结果 —— 渲染成客座气泡。 */
  | 'guest-result'
  /** 父任务：发起方对进行中委派的插话 / 催促留痕。 */
  | 'interjection'
  /** 目标主任务：收到的委派请求镜像 —— 客座来访。 */
  | 'guest-request'
  /** 目标主任务：本次委派的终态镜像。 */
  | 'result-mirror';

export interface BotCollaborationMeta {
  v: 1;
  role: BotCollaborationRole;
  delegationId: string;
  /** 发起方伙伴（调用 delegate_to_bot 的那个）。 */
  fromBotId: string;
  fromBotName: string;
  /** 目标伙伴。 */
  toBotId: string;
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
  if (typeof raw.toBotId !== 'string' || !raw.toBotId) return null;
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
  /** 父任务里的协作卡锚点。 */
  parentRequest: (delegationId: string) => `bot-delegation-request:${delegationId}`,
  /** 目标主任务里的请求镜像（历史值，不可改）。 */
  targetRequest: (delegationId: string) => `bot-delegation-target-request:${delegationId}`,
  /** 目标主任务里的终态镜像（历史值，不可改）。 */
  targetResult: (delegationId: string) => `bot-delegation-target-result:${delegationId}`,
  /** 父任务里的结果回传（历史值，不可改）。 */
  completion: (delegationId: string) => `bot-delegation-completion:${delegationId}`,
  /** 插话：投进子任务的那条。 */
  interjection: (delegationId: string, token: string) =>
    `bot-delegation-interject:${delegationId}:${token}`,
  /** 插话：留在父任务里的留痕。 */
  interjectionMirror: (delegationId: string, token: string) =>
    `bot-delegation-interject-mirror:${delegationId}:${token}`,
} as const;

/**
 * 从结果回传的机读正文里取出「目标伙伴到底说了什么」。
 *
 * 回传那条消息同时服务两个读者：父任务的 agent 读全文（带 delegation id / 目标 /
 * 子任务引用才能接着编排），人只该看到答案本身。正文由主进程 `deliverCompletion`
 * 生成，格式固定；这里只做保守切分，认不出来就原样返回，绝不吞内容。
 *
 * 契约由 botCanonicalSession 的委派测试钉住（真实产出必须能被这里解析）。
 */
export function readBotDelegationCompletionBody(content: string): {
  /** 结果正文；解析不出来时为原文。 */
  text: string;
  /** 失败 / 超时 / 取消时的错误说明。 */
  error: string | null;
} {
  if (!content.startsWith('[Cindy Bot delegation ')) return { text: content, error: null };
  const blocks = content.split('\n\n');
  let text = '';
  let error: string | null = null;
  for (const block of blocks) {
    if (block.startsWith('Result:\n')) text = block.slice('Result:\n'.length);
    else if (block.startsWith('Error: ')) error = block.slice('Error: '.length);
  }
  if (!text && !error) return { text: content, error: null };
  return { text, error };
}

export type BotDelegationInterjectResult =
  | {
      ok: true;
      delegationId: string;
      childSessionId: string;
      /** 子任务当时是否正忙：忙则本条进它的输入队列，当前回合结束后被读到。 */
      queued: boolean;
    }
  | { ok: false; errorCode: string; message: string };
